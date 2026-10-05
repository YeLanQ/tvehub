// 物理引擎 Worker：在独立线程运行物理模拟，主线程经 postMessage 同步变换。
// 双缓冲策略：主线程发当前帧运动学体变换 → Worker 步进 → 回写动力学体变换。
// Worker 中使用 THREE.Object3D 作为代理（仅需数学运算，无 WebGL 依赖）。
//
// 消息协议（类型单源；主线程适配在 physics.ts createPhysicsWorker）：
// → PhysicsWorkerIn
// ← PhysicsWorkerOut

import * as THREE from "../core/three.module.min.js";
import { createPhysics } from "./physics";

// ---------------------------------------------------------------------------
// 消息协议
// ---------------------------------------------------------------------------

/** 序列化物理节点（主线程 init 下发；位置/旋转/缩放为分量数组） */
interface SerializedPhysNode {
  nodeId: string;
  json: Record<string, unknown>;
  position: number[];
  quaternion: number[];
  scale: number[];
  parentId: string | null;
  isMesh: boolean;
  /** 顶点位置分量数组（仅 isMesh；地形/复杂网格烘焙采样用） */
  vertices: Float32Array | null;
}

/** 序列化地形（只含 createPhysics 需要的高度场纯数据） */
interface SerializedPhysTerrain {
  json: { id: string };
  data: { heights: unknown; gridSize: unknown; size: unknown };
}

/** 物理体信息（bodyInfo 返回；worker 只转发 dynamic 体给主线程） */
interface PhysicsBodyInfo {
  mode?: string;
  gravityScale?: number;
  colliderCount?: number;
}

/** createPhysics 返回控制面的 worker 消费面（形状对齐 physics.ts） */
interface PhysicsApiView {
  update(dt: number): void;
  bodyInfo(nodeId: string): PhysicsBodyInfo | null;
  getLinearVelocity(nodeId: string): { x: number; y: number; z: number } | null;
  drainCollisions(): unknown[];
  castRay(options: Record<string, unknown>): Promise<unknown[]> | unknown[];
  dispose?(): void;
}

/** 主线程 → Worker */
export type PhysicsWorkerIn =
  | { type: "recycleResult"; buf?: Float32Array }
  | {
      type: "init";
      nodes: SerializedPhysNode[];
      terrains: SerializedPhysTerrain[];
      settings: Record<string, unknown>;
    }
  | { type: "step"; dt: number; transforms: Float32Array }
  | { type: "command"; method: string; args: unknown[] }
  | { type: "castRay"; id: number; options: Record<string, unknown> }
  | { type: "dispose" };

/** Worker → 主线程（TypedArray 随消息转移所有权） */
export type PhysicsWorkerOut =
  | {
      type: "ready";
      dynamicIds: string[];
      bodyInfos: Record<string, PhysicsBodyInfo>;
    }
  | { type: "recycleInput"; buffer: ArrayBuffer }
  | { type: "stepped"; transforms: Float32Array; velocities: Float32Array; collisions: unknown[] }
  | { type: "result"; method: string; value: unknown }
  | { type: "raycastResult"; id: number; hits: unknown[] }
  | { type: "error"; message: string };

/** 专用 Worker 作用域（TS DOM lib 下 self 是 Window；收敛 Worker 专有 API 的类型面） */
interface WorkerScope {
  postMessage(message: PhysicsWorkerOut, transfer?: Transferable[]): void;
  close(): void;
}
const scope = self as unknown as WorkerScope;

let api: PhysicsApiView | null = null;
let proxyMap = new Map<string, THREE.Object3D>();
let allNodes: { nodeId: string; obj: THREE.Object3D }[] = [];
let dynamicIds: string[] = [];
/** stepped 结果缓冲池（主线程消费后经 recycleResult 归还复用） */
const resultPool: Float32Array[] = [];

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as PhysicsWorkerIn;
  switch (msg.type) {
    case "recycleResult": {
      if (msg.buf?.buffer) resultPool.push(msg.buf);
      break;
    }
    case "init": {
      try {
        const { nodes, terrains, settings } = msg;
        const proxyNodes = buildProxyTree(nodes);
        allNodes = proxyNodes;
        // createPhysics 现已类型化（physics.ts PhysicsApi）；worker 只消费记录视图，
        // RaycastOptions 与 Record 入参不可直接比较 → 经 unknown 双重断言
        api = (await createPhysics({ nodes: proxyNodes, terrains, settings })) as unknown as PhysicsApiView;
        const bodyInfos: Record<string, PhysicsBodyInfo> = {};
        for (const { nodeId } of proxyNodes) {
          const info = api.bodyInfo(nodeId);
          if (info && info.mode === "dynamic") {
            dynamicIds.push(nodeId);
            bodyInfos[nodeId] = info;
          }
        }
        scope.postMessage({ type: "ready", dynamicIds, bodyInfos });
      } catch (err) {
        scope.postMessage({ type: "error", message: errText(err) });
      }
      break;
    }
    case "step": {
      if (!api) break;
      try {
        const { dt, transforms } = msg;
        for (let i = 0, j = 0; i < allNodes.length; i++, j += 7) {
          const obj = allNodes[i].obj;
          obj.position.set(transforms[j], transforms[j + 1], transforms[j + 2]);
          obj.quaternion.set(transforms[j + 3], transforms[j + 4], transforms[j + 5], transforms[j + 6]);
        }
        // 输入缓冲消费完立即归还主线程复用（零拷贝往返；免每帧 nodes×7 分配）
        scope.postMessage(
          { type: "recycleInput", buffer: transforms.buffer as ArrayBuffer },
          [transforms.buffer as ArrayBuffer],
        );
        api.update(dt);
        const out = resultPool.pop() ?? new Float32Array(dynamicIds.length * 7);
        const vel = new Float32Array(dynamicIds.length * 3);
        for (let i = 0, j = 0, k = 0; i < dynamicIds.length; i++, j += 7, k += 3) {
          const obj = proxyMap.get(dynamicIds[i]);
          if (!obj) continue;
          out[j] = obj.position.x;
          out[j + 1] = obj.position.y;
          out[j + 2] = obj.position.z;
          out[j + 3] = obj.quaternion.x;
          out[j + 4] = obj.quaternion.y;
          out[j + 5] = obj.quaternion.z;
          out[j + 6] = obj.quaternion.w;
          const v = api.getLinearVelocity(dynamicIds[i]);
          if (v) { vel[k] = v.x; vel[k + 1] = v.y; vel[k + 2] = v.z; }
        }
        const collisions = api.drainCollisions();
        scope.postMessage(
          { type: "stepped", transforms: out, velocities: vel, collisions },
          [out.buffer as ArrayBuffer, vel.buffer as ArrayBuffer],
        );
      } catch (err) {
        scope.postMessage({ type: "error", message: errText(err) });
      }
      break;
    }
    case "command": {
      const { method, args } = msg;
      if (api) {
        // 动态分发：createPhysics 的方法面远宽于 worker 消费视图，经记录视图调用
        const methods = api as unknown as Record<string, (...a: unknown[]) => unknown>;
        const fn = methods[method];
        if (typeof fn === "function") {
          const value = fn.apply(api, args);
          if (value !== undefined) scope.postMessage({ type: "result", method, value });
        }
      }
      break;
    }
    case "castRay": {
      const { id, options } = msg;
      try {
        const hits = api?.castRay(options) ?? [];
        Promise.resolve(hits).then((h) => {
          scope.postMessage({ type: "raycastResult", id, hits: h ?? [] });
        });
      } catch {
        scope.postMessage({ type: "raycastResult", id, hits: [] });
      }
      break;
    }
    case "dispose": {
      api?.dispose?.();
      scope.close();
      break;
    }
  }
};

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function buildProxyTree(
  serialized: SerializedPhysNode[],
): { nodeId: string; obj: THREE.Object3D; json: Record<string, unknown> }[] {
  proxyMap = new Map();
  const result: { nodeId: string; obj: THREE.Object3D; json: Record<string, unknown> }[] = [];
  for (const s of serialized) {
    const obj: THREE.Object3D = s.isMesh ? new THREE.Mesh() : new THREE.Object3D();
    obj.position.fromArray(s.position);
    obj.quaternion.fromArray(s.quaternion);
    obj.scale.fromArray(s.scale);
    if (s.isMesh && s.vertices) {
      const mesh = obj as THREE.Mesh;
      mesh.geometry = new THREE.BufferGeometry();
      mesh.geometry.setAttribute("position", new THREE.BufferAttribute(s.vertices, 3));
    }
    proxyMap.set(s.nodeId, obj);
    result.push({ nodeId: s.nodeId, obj, json: s.json });
  }
  for (const s of serialized) {
    if (s.parentId) {
      const obj = proxyMap.get(s.nodeId);
      const parent = proxyMap.get(s.parentId);
      if (obj && parent) parent.add(obj);
    }
  }
  return result;
}
