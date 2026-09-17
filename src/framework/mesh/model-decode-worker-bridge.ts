// 模型解码 Worker 桥接：主线程代理，将 GLTFLoader.parse 移入 Worker 线程。
// 与物理/动画 Worker 同一设计模式：失败自动回退主线程解析。
//
// 设计：
// - Worker 中运行 GLTFLoader.parse → toJSON 序列化 → postMessage 纯数据
// - 主线程 ObjectLoader.parse 重建 Three.js 对象树
// - 序列化/反序列化失败或 Worker 异常 → 回退主线程 GLTFLoader.parse

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { applyCompressedGltfSupport, compressedGltfSupport } from "./compressed-gltf";
import type { ModelLoadContext, LoadedModelData } from "./loaders";
import ModelDecodeWorker from "./model-decode-worker.ts?worker";

let worker: Worker | null = null;
let workerReady = false;
let pendingId = 0;
const pending = new Map<
  number,
  { resolve: (data: LoadedModelData) => void; reject: (err: Error) => void }
>();

/** 初始化 Worker（传入 Draco 解码器路径） */
export function initModelDecodeWorker(decoderBase: string, basisBase: string): void {
  if (worker) return;
  try {
    worker = new ModelDecodeWorker();
    worker.onmessage = (e: MessageEvent) => {
      const msg: any = e.data;
      switch (msg.type) {
        case "ready":
          workerReady = true;
          break;
        case "parsed": {
          const task = pending.get(msg.id);
          if (!task) return;
          pending.delete(msg.id);
          try {
            const loader = new THREE.ObjectLoader();
            const object = loader.parse(msg.sceneJson);
            const clips = (msg.animationsJson ?? []).map(
              (j: any) => THREE.AnimationClip.parse(j),
            );
            task.resolve({ object, clips });
          } catch (err: any) {
            task.reject(
              new Error(`Worker 结果反序列化失败: ${String(err?.message ?? err)}`),
            );
          }
          break;
        }
        case "error": {
          const task = pending.get(msg.id);
          if (!task) return;
          pending.delete(msg.id);
          task.reject(new Error(msg.message));
          break;
        }
      }
    };
    worker.onerror = () => {
      worker = null;
      workerReady = false;
    };
    worker.postMessage({ type: "init", decoderBase, basisBase });
  } catch {
    worker = null;
    workerReady = false;
  }
}

/** 通过 Worker 解析 glTF（失败回退主线程） */
export async function parseGltfInWorker(
  buffer: ArrayBuffer,
  ctx: ModelLoadContext,
  resourceBaseUrl: string,
): Promise<LoadedModelData> {
  if (!worker || !workerReady) {
    return parseGltfInMainThread(buffer, ctx);
  }
  // transfer 后主线程 buffer 变 detached，回退主线程需备份
  const bufferBackup = buffer.slice(0);
  const id = ++pendingId;
  return new Promise<LoadedModelData>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage(
      { type: "parse", id, buffer, rel: ctx.resourcePath, resourceBaseUrl },
      [buffer],
    );
  }).catch(async (err) => {
    // Worker 失败 → 回退主线程（用备份 buffer）
    console.warn("[model-worker] 回退主线程解析:", err.message);
    return parseGltfInMainThread(bufferBackup, ctx);
  });
}

/** 主线程解析（回退用） */
async function parseGltfInMainThread(
  buffer: ArrayBuffer,
  ctx: ModelLoadContext,
): Promise<LoadedModelData> {
  return new Promise<LoadedModelData>((resolve, reject) => {
    const loader = new GLTFLoader(ctx.manager);
    applyCompressedGltfSupport(loader);
    loader.parse(
      buffer,
      ctx.resourcePath,
      (gltf) => resolve({ object: gltf.scene, clips: gltf.animations ?? [] }),
      (err) => {
        const support = compressedGltfSupport();
        const missing = [!support.draco && "DRACO", !support.ktx2 && "KTX2"]
          .filter(Boolean)
          .join("/");
        const hint = missing ? `（${missing} 压缩解码器未就绪）` : "";
        reject(new Error(`glTF 解析失败: ${String(err ?? "未知错误")}${hint}`));
      },
    );
  });
}

/** 销毁 Worker */
export function destroyModelDecodeWorker(): void {
  worker?.terminate();
  worker = null;
  workerReady = false;
  pending.clear();
}