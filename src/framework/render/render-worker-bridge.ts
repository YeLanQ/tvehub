// OffscreenCanvas 渲染 Worker 桥接：主线程代理，将渲染循环移入 Worker 线程。
//
// 设计：
// - 主线程 canvas.transferControlToOffscreen() → OffscreenCanvas（转移后主线程不能再操作）
// - Worker 中创建 WebGLRenderer + 渲染循环
// - 场景/相机变更通过 toJSON 序列化传递到 Worker
// - 不支持 OffscreenCanvas 时回退主线程渲染
//
// 兼容性检测：
// - typeof OffscreenCanvas !== "undefined"
// - canvas.transferControlToOffscreen 存在
// - WebGPU: navigator.gpu 存在（可选，当前框架用 WebGL）

import * as THREE from "three";
import RenderWorker from "./render-worker.ts?worker";

export interface RenderWorkerOptions {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  pixelRatio?: number;
}

export class RenderWorkerBridge {
  private worker: Worker | null = null;
  private offscreen: OffscreenCanvas | null = null;
  private ready = false;

  /** 检测 OffscreenCanvas 是否可用 */
  static isSupported(): boolean {
    return (
      typeof OffscreenCanvas !== "undefined" &&
      typeof HTMLCanvasElement !== "undefined" &&
      "transferControlToOffscreen" in HTMLCanvasElement.prototype
    );
  }

  /** 初始化渲染 Worker（不支持 OffscreenCanvas 时返回 false） */
  init(opts: RenderWorkerOptions): boolean {
    if (!RenderWorkerBridge.isSupported()) return false;
    try {
      this.offscreen = opts.canvas.transferControlToOffscreen();
      this.worker = new RenderWorker();
      this.worker.onmessage = (e: MessageEvent) => {
        const msg: any = e.data;
        if (msg.type === "ready") this.ready = true;
        if (msg.type === "error") console.error("[render-worker]", msg.message);
      };
      this.worker.postMessage(
        {
          type: "init",
          canvas: this.offscreen,
          width: opts.width,
          height: opts.height,
          pixelRatio: opts.pixelRatio ?? window.devicePixelRatio,
        },
        [this.offscreen],
      );
      return true;
    } catch (err) {
      console.warn("[render-worker] 初始化失败，回退主线程:", err);
      this.worker = null;
      this.offscreen = null;
      return false;
    }
  }

  /** 调整渲染尺寸 */
  resize(width: number, height: number, pixelRatio?: number): void {
    if (!this.worker || !this.ready) return;
    this.worker.postMessage({
      type: "resize",
      width,
      height,
      pixelRatio: pixelRatio ?? window.devicePixelRatio,
    });
  }

  /** 更新场景/相机（序列化传递） */
  updateScene(scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this.worker || !this.ready) return;
    try {
      const sceneJson = scene.toJSON();
      const cameraJson = camera.toJSON();
      this.worker.postMessage({ type: "render", sceneJson, cameraJson });
    } catch {
      // 序列化失败时跳过（保持上一帧）
    }
  }

  /** 销毁 Worker */
  dispose(): void {
    if (this.worker) {
      this.worker.postMessage({ type: "dispose" });
      this.worker.terminate();
      this.worker = null;
    }
    this.offscreen = null;
    this.ready = false;
  }

  /** Worker 是否就绪 */
  isReady(): boolean {
    return this.ready;
  }
}
