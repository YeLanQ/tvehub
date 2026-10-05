// 骨骼动画 + IK Worker：在独立线程运行 AnimationMixer + CCD IK 解算，主线程经
// postMessage 同步骨骼变换。与物理 Worker 同一设计模式（双缓冲、单页回退主线程）。
// Worker 中使用 THREE.Bone / THREE.SkinnedMesh 代理（仅需数学运算，无 WebGL 依赖）。
//
// 消息协议（类型单源；主线程适配在 animation.ts createAnimationsWorker）：
// → AnimationWorkerIn
// ← AnimationWorkerOut

import * as THREE from "../core/three.module.min.js";
import { createAnimations } from "./animation";

// ---------------------------------------------------------------------------
// 消息协议
// ---------------------------------------------------------------------------

/** 序列化网格条目（主线程 init 下发；与 animation.ts createBinding 消费形状对齐） */
interface SerializedMeshEntry {
  json: { id?: string; [key: string]: unknown };
  modelRoot?: {
    bones?: {
      name: string;
      position: number[];
      quaternion: number[];
      scale: number[];
      parentIndex: number;
    }[];
    morphMeshes?: { name: string; dictionary: Record<string, number>; influenceCount: number }[];
  } | null;
}

/** 序列化模型（clip 纯数据，worker 侧重建 THREE.AnimationClip） */
interface SerializedModel {
  name: string;
  clips?: SerializedClip[];
}

interface SerializedClip {
  name?: string;
  duration?: number;
  blendMode?: number;
  tracks?: SerializedTrack[];
}

interface SerializedTrack {
  name: string;
  times: number[] | Float32Array;
  values: number[] | Float32Array;
  interpolation?: number;
  valueSize?: number;
}

/** 单节点动画状态快照（主线程同步 API 读取；一帧延迟可接受） */
export interface AnimNodeState {
  weights: Record<string, number>;
  iks: { id: string; name: string; effector: string; enabled: boolean }[];
  ikTargets: Record<string, { x: number; y: number; z: number }>;
}

/** 动画事件（mixer finished/loop 转发） */
interface AnimWorkerEvent {
  type: "finished" | "loop";
  nodeId: string;
  clip: string;
}

/** 绑定布局（worker 就绪时下发，主线程据此分配回读缓冲） */
interface BindingLayout {
  nodeId: string;
  boneCount: number;
  boneNames: string[];
  morphMeshes: { name: string; influenceCount: number }[];
}

/** 主线程 → Worker */
export type AnimationWorkerIn =
  | { type: "recycleResult"; transforms?: Float32Array; morphs?: Float32Array }
  | { type: "init"; meshEntries: SerializedMeshEntry[]; modelMap: SerializedModel[] }
  | { type: "step"; dt: number }
  | { type: "command"; method: string; args: unknown[] }
  | { type: "dispose" };

/** Worker → 主线程（TypedArray 随消息转移所有权） */
export type AnimationWorkerOut =
  | { type: "ready"; bindingLayouts: BindingLayout[] }
  | {
      type: "stepped";
      transforms: Float32Array;
      morphs: Float32Array;
      state: Record<string, AnimNodeState>;
      events: AnimWorkerEvent[];
    }
  | { type: "result"; method: string; value: unknown }
  | { type: "error"; message: string };

/** 专用 Worker 作用域（TS DOM lib 下 self 是 Window；收敛 Worker 专有 API 的类型面） */
interface WorkerScope {
  postMessage(message: AnimationWorkerOut, transfer?: Transferable[]): void;
  close(): void;
}
const scope = self as unknown as WorkerScope;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// 动画 API 视图（createAnimations 返回值的 worker 消费面；形状对齐 animation.ts）
// ---------------------------------------------------------------------------

interface AnimBindingView {
  root: THREE.Object3D;
  bones: THREE.Bone[];
  boneNames: string[];
  morphTable: { name: string; mesh: THREE.Mesh }[];
  /** clip 名 → 动作（读有效权重） */
  actions?: Map<string, { getEffectiveWeight(): number }>;
  /** IK 链记录（addIK 追加） */
  iks?: { id: string; name: string; effector: string; enabled: boolean; targetBone: THREE.Bone }[];
}

interface AnimationsApiView {
  update(dt: number): void;
  bindingOf(nodeId: string): AnimBindingView | null;
  onFinished(nodeId: string, cb: (p: { clip: string }) => void): void;
  onLoop(nodeId: string, cb: (p: { clip: string }) => void): void;
}

let api: AnimationsApiView | null = null;
let proxyBindings: ProxyBinding[] = [];
let bindingLayouts: BindingLayout[] = [];
let pendingEvents: AnimWorkerEvent[] = [];

interface ProxyBinding {
  nodeId: string;
  root: THREE.Object3D;
  bones: THREE.Bone[];
  boneNames: string[];
  morphMeshes: { name: string; mesh: THREE.Mesh; influenceCount: number }[];
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as AnimationWorkerIn;
  switch (msg.type) {
    case "recycleResult": {
      // 主线程消费完的回读缓冲归还复用（transform/morph 各一池）
      if (msg.transforms?.buffer) transformPool.push(msg.transforms);
      if (msg.morphs?.buffer) morphPool.push(msg.morphs);
      break;
    }
    case "init": {
      try {
        const { meshEntries, modelMap } = msg;
        const proxyMeshes = buildProxyMeshes(meshEntries);
        const proxyModels = reconstructModels(modelMap);
        const animationsApi = createAnimations(proxyMeshes, proxyModels) as AnimationsApiView;
        api = animationsApi;
        proxyBindings = collectProxyBindings(meshEntries);
        bindingLayouts = proxyBindings.map((b) => ({
          nodeId: b.nodeId,
          boneCount: b.bones.length,
          boneNames: b.boneNames,
          morphMeshes: b.morphMeshes.map((m) => ({
            name: m.name,
            influenceCount: m.influenceCount,
          })),
        }));
        // 注册事件转发：mixer finished/loop → 主线程回调
        for (const b of proxyBindings) {
          if (!b.nodeId) continue;
          animationsApi.onFinished(b.nodeId, (p) =>
            pendingEvents.push({ type: "finished", nodeId: b.nodeId, clip: p.clip }),
          );
          animationsApi.onLoop(b.nodeId, (p) =>
            pendingEvents.push({ type: "loop", nodeId: b.nodeId, clip: p.clip }),
          );
        }
        scope.postMessage({ type: "ready", bindingLayouts });
      } catch (err) {
        scope.postMessage({ type: "error", message: errText(err) });
      }
      break;
    }
    case "step": {
      if (!api) break;
      try {
        api.update(msg.dt);
        const { transforms, morphs, state } = readbackState();
        const events = pendingEvents.splice(0);
        // 池内缓冲均为本 worker 新建，buffer 必为可转移的 ArrayBuffer
        const transferList: Transferable[] = [
          transforms.buffer as ArrayBuffer,
          morphs.buffer as ArrayBuffer,
        ];
        scope.postMessage({ type: "stepped", transforms, morphs, state, events }, transferList);
      } catch (err) {
        scope.postMessage({ type: "error", message: errText(err) });
      }
      break;
    }
    case "command": {
      const { method, args } = msg;
      if (api) {
        // 动态分发：createAnimations 的方法面远宽于 worker 消费视图，经记录视图调用
        const methods = api as unknown as Record<string, (...a: unknown[]) => unknown>;
        const fn = methods[method];
        if (typeof fn === "function") {
          try {
            const value = fn.apply(api, args);
            if (value !== undefined) scope.postMessage({ type: "result", method, value });
          } catch (err) {
            scope.postMessage({ type: "error", message: errText(err) });
          }
        }
      }
      break;
    }
    case "dispose": {
      scope.close();
      break;
    }
  }
};

// ---------------------------------------------------------------------------
// 代理场景树构建：从序列化数据重建 THREE.Object3D 树（含 Bone/Skeleton/SkinnedMesh）
// ---------------------------------------------------------------------------

function buildProxyMeshes(
  entries: SerializedMeshEntry[],
): { json: SerializedMeshEntry["json"]; obj: THREE.Object3D }[] {
  return entries.map((entry) => {
    const obj = new THREE.Object3D();
    obj.name = entry.json?.id || "";
    const root = new THREE.Object3D();
    root.name = "__modelRoot";
    obj.add(root);

    if (entry.modelRoot?.bones?.length) {
      const bones: THREE.Bone[] = [];
      for (const bd of entry.modelRoot.bones) {
        const bone = new THREE.Bone();
        bone.name = bd.name;
        bone.position.fromArray(bd.position);
        bone.quaternion.fromArray(bd.quaternion);
        bone.scale.fromArray(bd.scale);
        bones.push(bone);
      }
      for (let i = 0; i < bones.length; i++) {
        const parentIndex = entry.modelRoot.bones[i].parentIndex;
        if (parentIndex >= 0 && parentIndex < bones.length) {
          bones[parentIndex].add(bones[i]);
        } else {
          root.add(bones[i]);
        }
      }
      // 计算 matrixWorld 后建 Skeleton（boneInverses 依赖 worldMatrix）
      obj.updateMatrixWorld(true);
      const geo = new THREE.BufferGeometry();
      const mat = new THREE.MeshBasicMaterial();
      const skinnedMesh = new THREE.SkinnedMesh(geo, mat);
      skinnedMesh.name = "__proxySkinnedMesh";
      skinnedMesh.skeleton = new THREE.Skeleton(bones);
      root.add(skinnedMesh);
    }

    // 形态键网格（与骨骼网格分离或同一对象；createBinding 遍历 root 子树收集）
    if (entry.modelRoot?.morphMeshes?.length) {
      for (const mm of entry.modelRoot.morphMeshes) {
        let meshObj: THREE.Mesh | null = null;
        root.traverse((o) => {
          if (!meshObj && (o as THREE.Mesh).isMesh && o.name === mm.name) meshObj = o as THREE.Mesh;
        });
        if (!meshObj) {
          meshObj = new THREE.Mesh(
            new THREE.BufferGeometry(),
            new THREE.MeshBasicMaterial(),
          );
          meshObj.name = mm.name;
          root.add(meshObj);
        }
        meshObj.morphTargetDictionary = { ...mm.dictionary };
        // three 运行时用 Float32Array 存形态键权重（类型库声明为 number[]），断言写入
        (meshObj as { morphTargetInfluences?: unknown }).morphTargetInfluences =
          new Float32Array(mm.influenceCount);
      }
    }

    return { json: entry.json, obj };
  });
}

// ---------------------------------------------------------------------------
// AnimationClip 重建：从序列化纯数据重建 THREE.AnimationClip（含 KeyframeTrack 子类）
// ---------------------------------------------------------------------------

function reconstructModels(
  modelList: SerializedModel[],
): Map<string, { clips: THREE.AnimationClip[] }> {
  const map = new Map<string, { clips: THREE.AnimationClip[] }>();
  for (const m of modelList) {
    map.set(m.name, { clips: (m.clips || []).map(reconstructClip) });
  }
  return map;
}

function reconstructClip(data: SerializedClip): THREE.AnimationClip {
  const tracks = (data.tracks || []).map(reconstructTrack);
  const clip = new THREE.AnimationClip(data.name, data.duration, tracks);
  // 序列化的是数值枚举（JSON 来源），断言回 three 枚举
  clip.blendMode = data.blendMode as THREE.AnimationBlendMode;
  return clip;
}

function reconstructTrack(data: SerializedTrack): THREE.KeyframeTrack {
  const { name, times, values, interpolation } = data;
  const timesArr = times instanceof Float32Array ? times : new Float32Array(times);
  const valuesArr = values instanceof Float32Array ? values : new Float32Array(values);
  // 插值模式为序列化数值枚举，断言回 three 枚举
  const mode = interpolation as THREE.InterpolationModes | undefined;
  if (name.endsWith(".quaternion")) {
    return new THREE.QuaternionKeyframeTrack(name, timesArr, valuesArr, mode);
  }
  if (name.endsWith(".morphTargetInfluences") || data.valueSize === 1) {
    return new THREE.NumberKeyframeTrack(name, timesArr, valuesArr, mode);
  }
  return new THREE.VectorKeyframeTrack(name, timesArr, valuesArr, mode);
}

// ---------------------------------------------------------------------------
// 代理绑定收集：从 createAnimations 返回的 API 提取每个绑定的骨骼/形态键信息
// ---------------------------------------------------------------------------

function collectProxyBindings(meshEntries: SerializedMeshEntry[]): ProxyBinding[] {
  const result: ProxyBinding[] = [];
  for (const entry of meshEntries) {
    const nodeId = entry.json?.id;
    if (!nodeId) continue;
    const b = api?.bindingOf(nodeId);
    if (!b) continue;
    result.push({
      nodeId,
      root: b.root,
      bones: b.bones,
      boneNames: b.boneNames,
      morphMeshes: (b.morphTable || []).map((m) => ({
        name: m.name,
        mesh: m.mesh,
        influenceCount: m.mesh.morphTargetInfluences?.length ?? 0,
      })),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 状态回读：每帧从代理骨骼提取变换 + 形态键权重 + 状态快照
// ---------------------------------------------------------------------------

/** 回读缓冲池（主线程消费 stepped 后经 recycleResult 归还；免每帧 TypedArray 分配） */
const transformPool: Float32Array[] = [];
const morphPool: Float32Array[] = [];

/** 从池取缓冲：尺寸不匹配（绑定结构变化）时清池新建 */
function takeBuf(pool: Float32Array[], len: number): Float32Array {
  const top = pool[pool.length - 1];
  if (top && top.length === len) return pool.pop()!;
  pool.length = 0;
  return new Float32Array(len);
}

function readbackState(): {
  transforms: Float32Array;
  morphs: Float32Array;
  state: Record<string, AnimNodeState>;
} {
  let totalBones = 0;
  let totalMorphs = 0;
  for (const b of proxyBindings) {
    totalBones += b.bones.length;
    for (const mm of b.morphMeshes) totalMorphs += mm.influenceCount;
  }

  const transforms = takeBuf(transformPool, totalBones * 7);
  const morphs = takeBuf(morphPool, totalMorphs);
  const state: Record<string, AnimNodeState> = {};

  let tOff = 0;
  let mOff = 0;
  for (const b of proxyBindings) {
    for (const bone of b.bones) {
      transforms[tOff++] = bone.position.x;
      transforms[tOff++] = bone.position.y;
      transforms[tOff++] = bone.position.z;
      transforms[tOff++] = bone.quaternion.x;
      transforms[tOff++] = bone.quaternion.y;
      transforms[tOff++] = bone.quaternion.z;
      transforms[tOff++] = bone.quaternion.w;
    }
    for (const mm of b.morphMeshes) {
      const inf = mm.mesh.morphTargetInfluences;
      if (inf) for (let i = 0; i < inf.length; i++) morphs[mOff++] = inf[i];
    }

    // 状态快照（供主线程同步 API 读取；一帧延迟可接受）
    const binding = api?.bindingOf(b.nodeId);
    if (binding) {
      const weights: Record<string, number> = {};
      if (binding.actions) {
        for (const [clipName, action] of binding.actions) {
          weights[clipName] = action.getEffectiveWeight();
        }
      }
      const iks = (binding.iks || []).map((r) => ({
        id: r.id,
        name: r.name,
        effector: r.effector,
        enabled: r.enabled,
      }));
      const ikTargets: Record<string, { x: number; y: number; z: number }> = {};
      for (const r of binding.iks || []) {
        ikTargets[r.id] = {
          x: r.targetBone.position.x,
          y: r.targetBone.position.y,
          z: r.targetBone.position.z,
        };
      }
      state[b.nodeId] = { weights, iks, ikTargets };
    }
  }

  return { transforms, morphs, state };
}
