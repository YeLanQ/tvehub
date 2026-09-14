// 物理引擎 Worker：在独立线程运行物理模拟，主线程经 postMessage 同步变换。
// 双缓冲策略：主线程发当前帧运动学体变换 → Worker 步进 → 回写动力学体变换。
// Worker 中使用 THREE.Object3D 作为代理（仅需数学运算，无 WebGL 依赖）。
//
// 消息协议：
// → { type: "init", nodes, terrains, settings }
// ← { type: "ready", dynamicIds: string[], bodyInfos: Record<string, {mode,gravityScale,colliderCount}> }
// → { type: "step", dt, transforms: Float32Array }
// ← { type: "stepped", transforms: Float32Array, velocities: Float32Array, collisions: any[] }
// → { type: "command", method: string, args: any[] }
// ← { type: "result", method: string, value: any }

import * as THREE from "../core/three.module.min.js";
import { createPhysics } from "./physics";

let api: any = null;
let proxyMap = new Map<string, THREE.Object3D>();
let allNodes: { nodeId: string; obj: THREE.Object3D }[] = [];
let dynamicIds: string[] = [];

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  switch (msg.type) {
    case "init": {
      try {
        const { nodes, terrains, settings } = msg;
        const proxyNodes = buildProxyTree(nodes);
        allNodes = proxyNodes;
        api = await createPhysics({ nodes: proxyNodes, terrains, settings });
        const bodyInfos: Record<string, any> = {};
        for (const { nodeId } of proxyNodes) {
          const info = api.bodyInfo(nodeId);
          if (info && info.mode === "dynamic") {
            dynamicIds.push(nodeId);
            bodyInfos[nodeId] = info;
          }
        }
        (self as any).postMessage({ type: "ready", dynamicIds, bodyInfos });
      } catch (err) {
        (self as any).postMessage({ type: "error", message: String(err?.message ?? err) });
      }
      break;
    }
    case "step": {
      if (!api) break;
      try {
        const { dt, transforms } = msg as { dt: number; transforms: Float32Array };
        for (let i = 0, j = 0; i < allNodes.length; i++, j += 7) {
          const obj = allNodes[i].obj;
          obj.position.set(transforms[j], transforms[j + 1], transforms[j + 2]);
          obj.quaternion.set(transforms[j + 3], transforms[j + 4], transforms[j + 5], transforms[j + 6]);
        }
        api.update(dt);
        const out = new Float32Array(dynamicIds.length * 7);
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
        (self as any).postMessage({ type: "stepped", transforms: out, velocities: vel, collisions }, [out.buffer, vel.buffer]);
      } catch (err) {
        (self as any).postMessage({ type: "error", message: String(err?.message ?? err) });
      }
      break;
    }
    case "command": {
      const { method, args } = msg;
      if (api && typeof api[method] === "function") {
        const value = api[method](...args);
        if (value !== undefined) (self as any).postMessage({ type: "result", method, value });
      }
      break;
    }
    case "dispose": {
      if (api?.dispose) api.dispose();
      (self as any).close();
      break;
    }
  }
};

function buildProxyTree(serialized: any[]): { nodeId: string; obj: THREE.Object3D; json: any }[] {
  proxyMap = new Map();
  const result: { nodeId: string; obj: THREE.Object3D; json: any }[] = [];
  for (const s of serialized) {
    const obj = s.isMesh ? new THREE.Mesh() : new THREE.Object3D();
    obj.position.fromArray(s.position);
    obj.quaternion.fromArray(s.quaternion);
    obj.scale.fromArray(s.scale);
    if (s.isMesh && s.vertices) {
      obj.geometry = new THREE.BufferGeometry();
      obj.geometry.setAttribute("position", new THREE.BufferAttribute(s.vertices, 3));
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