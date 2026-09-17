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
// 消息协议：
// → { type: "init", canvas: OffscreenCanvas, width, height, pixelRatio, useWebGPU }
// ← { type: "ready" }
// → { type: "resize", width, height, pixelRatio }
// → { type: "render", sceneJson, cameraJson }
// ← { type: "rendered", fps }
// → { type: "dispose" }

let THREE: any = null;
let renderer: any = null;
let scene: any = null;
let camera: any = null;
let lastTime = performance.now();
let fps = 0;

async function loadThree(): Promise<void> {
  if (THREE) return;
  const origin = self.location.origin;
  THREE = await import(/* @vite-ignore */ `${origin}/engine/core/three.module.min.js`);
}

self.onmessage = async (e: MessageEvent) => {
  const msg: any = e.data;
  switch (msg.type) {
    case "init": {
      try {
        await loadThree();
        const { canvas, width, height, pixelRatio } = msg;
        renderer = new THREE.WebGLRenderer({
          canvas,
          antialias: true,
          alpha: true,
        });
        renderer.setPixelRatio(pixelRatio ?? 1);
        renderer.setSize(width, height, false);
        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
        camera.position.z = 5;
        (self as any).postMessage({ type: "ready" });
        startRenderLoop();
      } catch (err: any) {
        (self as any).postMessage({
          type: "error",
          message: `初始化失败: ${String(err?.message ?? err)}`,
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
        if (msg.sceneJson) {
          const loader = new THREE.ObjectLoader();
          scene = loader.parse(msg.sceneJson);
        }
        if (msg.cameraJson) {
          const loader = new THREE.ObjectLoader();
          camera = loader.parse(msg.cameraJson);
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
      (self as any).postMessage({ type: "rendered", fps });
    }
    rafId = (self as any).requestAnimationFrame(loop);
  }
  rafId = (self as any).requestAnimationFrame(loop);
}

function stopRenderLoop() {
  if (rafId) {
    (self as any).cancelAnimationFrame(rafId);
    rafId = 0;
  }
}
export {};
