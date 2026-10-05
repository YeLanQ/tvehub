// OffscreenCanvas 渲染 Worker：将 Three.js 渲染循环移入独立线程，主线程只做 UI。
//
// 兼容性评估（2026-09）：
// - WebGLRenderer + OffscreenCanvas：Chrome/Edge 全支持，Firefox 支持，Safari 16.4+ 支持
// - WebGPURenderer + OffscreenCanvas：Chrome/Edge 113+ 支持，Firefox 实验性，Safari 不支持
// - Tauri WebView2（Windows）：基于 Chromium，支持 OffscreenCanvas + WebGL/WebGPU
// - 限制：transferControlToOffscreen 后主线程不能再操作该 canvas
//
// 重要：此 Worker 不能使用 bare import（如 `from "three"`），因为 Vite dev mode
// 下 Worker 从 blob URL 加载，bare import 无法解析。改用动态 import 从 public/engine/
// 下的物理文件加载（绝对路径 /engine/... 由浏览器相对 origin 解析，blob URL 下也可用）。
//
// 消息协议（类型单源：桥接端 import type 复用）：
// → RenderWorkerIn
// ← RenderWorkerOut

/** 主线程 → Worker */
export type RenderWorkerIn =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number; pixelRatio?: number }
  | { type: "resize"; width: number; height: number; pixelRatio?: number }
  | { type: "render"; sceneJson?: object; cameraJson?: object }
  | { type: "dispose" };

/** Worker → 主线程 */
export type RenderWorkerOut =
  | { type: "ready" }
  | { type: "rendered"; fps: number }
  | { type: "error"; message: string };

/** 动态加载的 three 模块结构视图（vendored 构建无类型声明，只声明 worker 消费面；
 *  three 直接引用受 check-layers 门禁约束，本文件不做 three 的类型位置引用） */
interface ThreeView {
  WebGLRenderer: new (params: {
    canvas: OffscreenCanvas;
    antialias: boolean;
    alpha: boolean;
  }) => {
    setPixelRatio(ratio: number): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    render(scene: object, camera: object): void;
    dispose(): void;
  };
  Scene: new () => object;
  PerspectiveCamera: new (fov: number, aspect: number, near: number, far: number) => {
    aspect: number;
    position: { z: number };
    updateProjectionMatrix(): void;
  };
  ObjectLoader: new () => { parse(json: object): object };
}

type RendererLike = InstanceType<ThreeView["WebGLRenderer"]>;
type CameraLike = InstanceType<ThreeView["PerspectiveCamera"]>;

let THREE: ThreeView | null = null;
let renderer: RendererLike | null = null;
let scene: object | null = null;
let camera: CameraLike | null = null;
let lastTime = performance.now();
let fps = 0;

async function loadThree(): Promise<ThreeView> {
  if (!THREE) {
    const origin = self.location.origin;
    const mod = (await import(
      /* @vite-ignore */ `${origin}/engine/core/three.module.min.js`
    )) as ThreeView;
    THREE = mod;
    return mod;
  }
  return THREE;
}

/** 专用 Worker 作用域（TS DOM lib 下 self 是 Window；收敛 Worker 专有 API 的类型面） */
interface WorkerScope {
  postMessage(message: RenderWorkerOut, transfer?: Transferable[]): void;
  close(): void;
  requestAnimationFrame(cb: (time: number) => void): number;
  cancelAnimationFrame(id: number): void;
}
const scope = self as unknown as WorkerScope;

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as RenderWorkerIn;
  switch (msg.type) {
    case "init": {
      try {
        const T = await loadThree();
        const { canvas, width, height, pixelRatio } = msg;
        renderer = new T.WebGLRenderer({
          canvas,
          antialias: true,
          alpha: true,
        });
        renderer.setPixelRatio(pixelRatio ?? 1);
        renderer.setSize(width, height, false);
        scene = new T.Scene();
        camera = new T.PerspectiveCamera(60, width / height, 0.1, 1000);
        camera.position.z = 5;
        scope.postMessage({ type: "ready" });
        startRenderLoop();
      } catch (err) {
        scope.postMessage({
          type: "error",
          message: `初始化失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      break;
    }
    case "resize": {
      if (!renderer || !camera) return;
      const { width, height, pixelRatio } = msg;
      renderer.setPixelRatio(pixelRatio ?? 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      break;
    }
    case "render": {
      // 场景/相机更新：从主线程接收序列化数据，用 ObjectLoader 重建
      try {
        if (THREE && msg.sceneJson) {
          const loader = new THREE.ObjectLoader();
          scene = loader.parse(msg.sceneJson);
        }
        if (THREE && msg.cameraJson) {
          const loader = new THREE.ObjectLoader();
          camera = loader.parse(msg.cameraJson) as CameraLike;
        }
      } catch {
        // 序列化数据不完整时保持上一帧场景
      }
      break;
    }
    case "dispose": {
      stopRenderLoop();
      renderer?.dispose();
      renderer = null;
      scene = null;
      camera = null;
      break;
    }
  }
};

let rafId = 0;
function startRenderLoop() {
  function loop() {
    if (!renderer || !scene || !camera) return;
    const now = performance.now();
    const dt = now - lastTime;
    lastTime = now;
    fps = 1000 / dt;
    renderer.render(scene, camera);
    if (rafId > 0) {
      scope.postMessage({ type: "rendered", fps });
    }
    rafId = scope.requestAnimationFrame(loop);
  }
  rafId = scope.requestAnimationFrame(loop);
}

function stopRenderLoop() {
  if (rafId) {
    scope.cancelAnimationFrame(rafId);
    rafId = 0;
  }
}
export {};
