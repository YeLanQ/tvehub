// 骨骼动画 + IK Worker：在独立线程运行 AnimationMixer + CCD IK 解算，主线程经
// postMessage 同步骨骼变换。与物理 Worker 同一设计模式（双缓冲、单页回退主线程）。
// Worker 中使用 THREE.Bone / THREE.SkinnedMesh 代理（仅需数学运算，无 WebGL 依赖）。
//
// 消息协议：
// → { type: "init", meshEntries: SerializedMeshEntry[], modelMap: SerializedModel[] }
// ← { type: "ready", bindingLayouts: BindingLayout[] }
// → { type: "step", dt: number }
// ← { type: "stepped", transforms: Float32Array, morphs: Float32Array, state: object, events: array }
// → { type: "command", method: string, args: any[] }
// ← { type: "result", method: string, value: any }
// → { type: "dispose" }

import * as THREE from "../core/three.module.min.js";
import { createAnimations } from "./animation";

let api: any = null;
let proxyBindings: ProxyBinding[] = [];
let bindingLayouts: any[] = [];
let pendingEvents: any[] = [];

interface ProxyBinding {
  nodeId: string;
  root: THREE.Object3D;
  bones: THREE.Bone[];
  boneNames: string[];
  morphMeshes: { name: string; mesh: THREE.Mesh; influenceCount: number }[];
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  switch (msg.type) {
    case "init": {
      try {
        const { meshEntries, modelMap } = msg;
        const proxyMeshes = buildProxyMeshes(meshEntries);
        const proxyModels = reconstructModels(modelMap);
        api = createAnimations(proxyMeshes, proxyModels);
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
          api.onFinished(b.nodeId, (p: any) =>
            pendingEvents.push({ type: "finished", nodeId: b.nodeId, clip: p.clip }),
          );
          api.onLoop(b.nodeId, (p: any) =>
            pendingEvents.push({ type: "loop", nodeId: b.nodeId, clip: p.clip }),
          );
        }
        (self as any).postMessage({ type: "ready", bindingLayouts });
      } catch (err) {
        (self as any).postMessage({ type: "error", message: String(err?.message ?? err) });
      }
      break;
    }
    case "step": {
      if (!api) break;
      try {
        api.update(msg.dt);
        const { transforms, morphs, state } = readbackState();
        const events = pendingEvents.splice(0);
        const transferList: ArrayBuffer[] = [transforms.buffer, morphs.buffer];
        (self as any).postMessage(
          { type: "stepped", transforms, morphs, state, events },
          transferList,
        );
      } catch (err) {
        (self as any).postMessage({ type: "error", message: String(err?.message ?? err) });
      }
      break;
    }
    case "command": {
      const { method, args } = msg;
      if (api && typeof api[method] === "function") {
        try {
          const value = api[method](...args);
          if (value !== undefined)
            (self as any).postMessage({ type: "result", method, value });
        } catch (err) {
          (self as any).postMessage({ type: "error", message: String(err?.message ?? err) });
        }
      }
      break;
    }
    case "dispose": {
      (self as any).close();
      break;
    }
  }
};

// ---------------------------------------------------------------------------
// 代理场景树构建：从序列化数据重建 THREE.Object3D 树（含 Bone/Skeleton/SkinnedMesh）
// ---------------------------------------------------------------------------

function buildProxyMeshes(entries: any[]): { json: any; obj: THREE.Object3D }[] {
  return entries.map((entry: any) => {
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
          if (!meshObj && o.isMesh && o.name === mm.name) meshObj = o as THREE.Mesh;
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
        meshObj.morphTargetInfluences = new Float32Array(mm.influenceCount);
      }
    }

    return { json: entry.json, obj };
  });
}

// ---------------------------------------------------------------------------
// AnimationClip 重建：从序列化纯数据重建 THREE.AnimationClip（含 KeyframeTrack 子类）
// ---------------------------------------------------------------------------

function reconstructModels(
  modelList: any[],
): Map<string, { clips: THREE.AnimationClip[] }> {
  const map = new Map<string, { clips: THREE.AnimationClip[] }>();
  for (const m of modelList) {
    map.set(m.name, { clips: (m.clips || []).map(reconstructClip) });
  }
  return map;
}

function reconstructClip(data: any): THREE.AnimationClip {
  const tracks = (data.tracks || []).map(reconstructTrack);
  const clip = new THREE.AnimationClip(data.name, data.duration, tracks);
  clip.blendMode = data.blendMode;
  return clip;
}

function reconstructTrack(data: any): THREE.KeyframeTrack {
  const { name, times, values, interpolation } = data;
  const timesArr = times instanceof Float32Array ? times : new Float32Array(times);
  const valuesArr = values instanceof Float32Array ? values : new Float32Array(values);
  if (name.endsWith(".quaternion")) {
    return new THREE.QuaternionKeyframeTrack(name, timesArr, valuesArr, interpolation);
  }
  if (name.endsWith(".morphTargetInfluences") || data.valueSize === 1) {
    return new THREE.NumberKeyframeTrack(name, timesArr, valuesArr, interpolation);
  }
  return new THREE.VectorKeyframeTrack(name, timesArr, valuesArr, interpolation);
}

// ---------------------------------------------------------------------------
// 代理绑定收集：从 createAnimations 返回的 API 提取每个绑定的骨骼/形态键信息
// ---------------------------------------------------------------------------

function collectProxyBindings(meshEntries: any[]): ProxyBinding[] {
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
      morphMeshes: (b.morphTable || []).map((m: any) => ({
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

function readbackState(): {
  transforms: Float32Array;
  morphs: Float32Array;
  state: any;
} {
  let totalBones = 0;
  let totalMorphs = 0;
  for (const b of proxyBindings) {
    totalBones += b.bones.length;
    for (const mm of b.morphMeshes) totalMorphs += mm.influenceCount;
  }

  const transforms = new Float32Array(totalBones * 7);
  const morphs = new Float32Array(totalMorphs);
  const state: any = {};

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
    const binding = api.bindingOf(b.nodeId);
    if (binding) {
      const weights: any = {};
      if (binding.actions) {
        for (const [clipName, action] of binding.actions) {
          weights[clipName] = action.getEffectiveWeight();
        }
      }
      const iks = (binding.iks || []).map((r: any) => ({
        id: r.id,
        name: r.name,
        effector: r.effector,
        enabled: r.enabled,
      }));
      const ikTargets: any = {};
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