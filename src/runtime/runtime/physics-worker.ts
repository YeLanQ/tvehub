// 物理引擎 Worker：在独立线程运行物理模拟，主线程经 postMessage 同步变换。
// 双缓冲策略：主线程发当前帧运动学体变换 → Worker 步进 → 回写动力学体变换。
// Worker 中使用 THREE.Object3D 作为代理（仅需数学运算，无 WebGL 依赖）。
//
// 消息协议（类型单源；主线程适配在 physics.ts createPhysicsWorker）：
// → PhysicsWorkerIn
// ← PhysicsWorkerOut
//
// 路由复用：消息处理核心抽为 routePhysicsMessage（transport 无关），三处消费——
// - web 渠道：本模块按 DOM 专用 Worker 形态自装（self.onmessage）；
// - 微信渠道：entries/wechat-worker.ts 以 ns 信封接 worker.onMessage/self.onmessage
//   后调同一路由（拷贝语义传输，消息内 TypedArray 已被桥接层数组化）；
// - node 冒烟：worker-smoke.mjs 直接 import 路由驱动全链回归。

import * as THREE from "../core/three.module.min.js";
import { createPhysics } from "./physics";

// ---------------------------------------------------------------------------
// 消息协议
// ---------------------------------------------------------------------------

/** 序列化物理节点（主线程 init 下发；位置/旋转/缩放为分量数组）。
 *  vertices 兼容两种传输形态：TypedArray（DOM transfer）与纯数组（平台拷贝
 *  语义传输——微信跨上下文 TypedArray 结构化克隆不可靠，桥接层统一数组化） */
interface SerializedPhysNode {
  nodeId: string;
  json: Record<string, unknown>;
  position: number[];
  quaternion: number[];
  scale: number[];
  parentId: string | null;
  isMesh: boolean;
  vertices: Float32Array | number[] | null;
}

/** 序列化地形（只含 createPhysics 需要的高度场纯数据；heights 同样双形态） */
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
  | { type: "recycleResult"; buf?: Float32Array | number[] }
  | {
      type: "init";
      nodes: SerializedPhysNode[];
      terrains: SerializedPhysTerrain[];
      settings: Record<string, unknown>;
    }
  | { type: "step"; dt: number; transforms: Float32Array | number[] }
  | { type: "command"; method: string; args: unknown[] }
  | { type: "castRay"; id: number; options: Record<string, unknown> }
  | { type: "dispose" };

/** Worker → 主线程（TypedArray 随消息转移所有权；拷贝传输下为数组） */
export type PhysicsWorkerOut =
  | {
      type: "ready";
      dynamicIds: string[];
      bodyInfos: Record<string, PhysicsBodyInfo>;
    }
  | { type: "recycleInput"; buffer: ArrayBuffer }
  | {
      type: "stepped";
      transforms: Float32Array | number[];
      velocities: Float32Array | number[];
      collisions: unknown[];
    }
  | { type: "result"; method: string; value: unknown }
  | { type: "raycastResult"; id: number; hits: unknown[] }
  | { type: "error"; message: string };

/** 路由回复端口（DOM = self；平台 = 信封信道封装；transfer 仅 DOM 形态支持） */
export interface PhysicsWorkerReply {
  postMessage(message: PhysicsWorkerOut, transfer?: Transferable[]): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// 路由状态（模块级单例：一个 worker 线程承载一份物理世界）
// ---------------------------------------------------------------------------

let api: PhysicsApiView | null = null;
let proxyMap = new Map<string, THREE.Object3D>();
let allNodes: { nodeId: string; obj: THREE.Object3D }[] = [];
let dynamicIds: string[] = [];
/** stepped 结果缓冲池（DOM transfer 模式下主线程消费后经 recycleResult 归还复用；
 *  拷贝传输模式 postMessage 即复制，缓冲池不参与） */
const resultPool: Float32Array[] = [];

/** TypedArray 判定（跨传输形态的 duck-type；instanceof 对拷贝还原的数组不成立） */
function isFloat32Array(v: Float32Array | number[] | null | undefined): v is Float32Array {
  return !!v && typeof (v as Float32Array).buffer === "object" && typeof (v as Float32Array).length === "number";
}

/** 纯数组 → Float32Array（TypedArray 原样返回；地形高度场/网格顶点进后端前的归一） */
function reviveFloat32(v: unknown): unknown {
  if (Array.isArray(v) && (v.length === 0 || typeof v[0] === "number")) return Float32Array.from(v as number[]);
  return v;
}

/**
 * 消息路由核心（transport 无关）：处理一条 PhysicsWorkerIn 并经 reply 回话。
 * 平台拷贝传输下输入输出均为纯数组——索引读写兼容，TypedArray 专属操作
 * （transfer/缓冲池）按 duck-type 自动旁路。init 为异步（引擎 wasm 加载），
 * 完成前到达的 step/command 因 api 未就绪被丢弃（与 DOM Worker 形态一致）。
 */
export async function routePhysicsMessage(msg: PhysicsWorkerIn, reply: PhysicsWorkerReply): Promise<void> {
  switch (msg.type) {
    case "recycleResult": {
      if (isFloat32Array(msg.buf)) resultPool.push(msg.buf);
      break;
    }
    case "init": {
      try {
        const { nodes, terrains, settings } = msg;
        const proxyNodes = buildProxyTree(nodes);
        allNodes = proxyNodes;
        const revivedTerrains = (Array.isArray(terrains) ? terrains : []).map((t) => ({
          json: t.json,
          data: { ...t.data, heights: reviveFloat32(t.data?.heights) },
        }));
        // createPhysics 现已类型化（physics.ts PhysicsApi）；worker 只消费记录视图，
        // RaycastOptions 与 Record 入参不可直接比较 → 经 unknown 双重断言
        api = (await createPhysics({ nodes: proxyNodes, terrains: revivedTerrains, settings })) as unknown as PhysicsApiView;
        const bodyInfos: Record<string, PhysicsBodyInfo> = {};
        for (const { nodeId } of proxyNodes) {
          const info = api.bodyInfo(nodeId);
          if (info && info.mode === "dynamic") {
            dynamicIds.push(nodeId);
            bodyInfos[nodeId] = info;
          }
        }
        reply.postMessage({ type: "ready", dynamicIds, bodyInfos });
      } catch (err) {
        reply.postMessage({ type: "error", message: errText(err) });
      }
      break;
    }
    case "step": {
      if (!api) break;
      try {
        const { dt, transforms } = msg;
        const plain = !isFloat32Array(transforms);
        for (let i = 0, j = 0; i < allNodes.length; i++, j += 7) {
          const obj = allNodes[i].obj;
          obj.position.set(transforms[j], transforms[j + 1], transforms[j + 2]);
          obj.quaternion.set(transforms[j + 3], transforms[j + 4], transforms[j + 5], transforms[j + 6]);
        }
        if (!plain) {
          // 输入缓冲消费完立即归还主线程复用（零拷贝往返；免每帧 nodes×7 分配）；
          // 拷贝传输（plain）下消息即复制，无缓冲可还
          reply.postMessage(
            { type: "recycleInput", buffer: transforms.buffer },
            [transforms.buffer],
          );
        }
        api.update(dt);
        const out: Float32Array | number[] = plain
          ? new Array<number>(dynamicIds.length * 7).fill(0)
          : resultPool.pop() ?? new Float32Array(dynamicIds.length * 7);
        const vel: Float32Array | number[] = plain
          ? new Array<number>(dynamicIds.length * 3).fill(0)
          : new Float32Array(dynamicIds.length * 3);
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
          if (v) {
            vel[k] = v.x;
            vel[k + 1] = v.y;
            vel[k + 2] = v.z;
          }
        }
        const collisions = api.drainCollisions();
        if (plain) {
          reply.postMessage({ type: "stepped", transforms: out, velocities: vel, collisions });
        } else {
          reply.postMessage(
            { type: "stepped", transforms: out, velocities: vel, collisions },
            [(out as Float32Array).buffer, (vel as Float32Array).buffer],
          );
        }
      } catch (err) {
        reply.postMessage({ type: "error", message: errText(err) });
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
          if (value !== undefined) reply.postMessage({ type: "result", method, value });
        }
      }
      break;
    }
    case "castRay": {
      const { id, options } = msg;
      try {
        const hits = api?.castRay(options) ?? [];
        Promise.resolve(hits).then((h) => {
          reply.postMessage({ type: "raycastResult", id, hits: h ?? [] });
        });
      } catch {
        reply.postMessage({ type: "raycastResult", id, hits: [] });
      }
      break;
    }
    case "dispose": {
      api?.dispose?.();
      reply.close();
      break;
    }
  }
}

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // 附加首个用户帧（真机/冒烟定位 trap 与异常源头；wasm trap 的 message 常无上下文）
  const stack = e instanceof Error ? e.stack : undefined;
  const frame = stack?.split("\n").find((line) => line.includes(".mjs") || line.includes(".js"));
  return frame ? `${msg} @ ${frame.trim().slice(0, 160)}` : msg;
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
    if (s.isMesh && s.vertices && s.vertices.length) {
      const mesh = obj as THREE.Mesh;
      const verts = isFloat32Array(s.vertices) ? s.vertices : Float32Array.from(s.vertices);
      mesh.geometry = new THREE.BufferGeometry();
      mesh.geometry.setAttribute("position", new THREE.BufferAttribute(verts, 3));
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

// ---------------------------------------------------------------------------
// DOM 专用 Worker 自装（web 渠道 physics-worker.mjs 产物形态）：专用 Worker
// 作用域才生效（无 document/window 且有 self；lib.dom 无 WorkerGlobalScope 值，
// 用环境 duck-type 判定）——微信 worker bundle 复用本模块时入口随后覆写
// self.onmessage（import 求值序在先），node 导入（冒烟/测试）三条件皆缺不影响。
// ---------------------------------------------------------------------------

if (typeof document === "undefined" && typeof window === "undefined" && typeof self !== "undefined") {
  const scope = self as unknown as {
    postMessage(message: PhysicsWorkerOut, transfer?: Transferable[]): void;
    close(): void;
  };
  self.onmessage = (e: MessageEvent) => {
    routePhysicsMessage(e.data as PhysicsWorkerIn, scope);
  };
}
