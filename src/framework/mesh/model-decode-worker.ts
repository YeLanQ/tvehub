// 模型解码 Worker：在独立线程运行 GLTFLoader.parse，避免主线程卡顿。
//
// 重要：此 Worker 不能使用 bare import（如 `from "three"`），因为 Vite dev mode
// 下 Worker 从 blob URL 加载，bare import 无法解析。改用动态 import 从 public/engine/
// 下的物理文件加载（绝对路径 /engine/... 由浏览器相对 origin 解析，blob URL 下也可用）。
//
// 限制：不支持 Draco 压缩（DRACOLoader 未 vendor 为独立文件）；Draco 模型自动
// 回退主线程解析。Meshopt 解码支持（meshopt_decoder.module.js 已 vendor）。
//
// 消息协议：
// → { type: "init", decoderBase: string, basisBase: string }
// ← { type: "ready" }
// → { type: "parse", id: number, buffer: ArrayBuffer, rel: string, resourceBaseUrl: string }
// ← { type: "parsed", id: number, sceneJson: object, animationsJson: object[] }
// ← { type: "error", id: number, message: string }

let THREE: any = null;
let GLTFLoader: any = null;
let MeshoptDecoder: any = null;
let ready = false;

async function loadModules(): Promise<void> {
  if (THREE) return;
  const origin = self.location.origin;
  THREE = await import(/* @vite-ignore */ `${origin}/engine/core/three.module.min.js`);
  const gltfMod = await import(/* @vite-ignore */ `${origin}/engine/runtime/loaders/GLTFLoader.js`);
  GLTFLoader = gltfMod.GLTFLoader;
  const meshoptMod = await import(/* @vite-ignore */ `${origin}/engine/runtime/loaders/meshopt_decoder.module.js`);
  MeshoptDecoder = meshoptMod.MeshoptDecoder;
}

/** 检测 glTF/GLB 是否使用 Draco 压缩（Worker 不支持 Draco，需回退主线程） */
function usesDraco(buffer: ArrayBuffer): boolean {
  try {
    let json: any;
    const view = new DataView(buffer);
    // GLB: magic=0x676C5466 ("glTF")
    if (view.getUint32(0, true) === 0x46546c67) {
      const jsonLen = view.getUint32(12, true);
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)));
    } else {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer)));
    }
    const exts = json?.extensionsRequired ?? json?.extensionsUsed ?? [];
    return Array.isArray(exts) && exts.includes("KHR_draco_mesh_compression");
  } catch {
    return false;
  }
}

self.onmessage = async (e: MessageEvent) => {
  const msg: any = e.data;
  switch (msg.type) {
    case "init": {
      try {
        await loadModules();
        ready = true;
        (self as any).postMessage({ type: "ready" });
      } catch (err: any) {
        (self as any).postMessage({
          type: "error",
          message: `初始化失败: ${String(err?.message ?? err)}`,
        });
      }
      break;
    }
    case "parse": {
      try {
        if (!ready || !THREE || !GLTFLoader) {
          (self as any).postMessage({
            type: "error",
            id: msg.id,
            message: "Worker 未就绪",
          });
          break;
        }
        const { id, buffer, resourceBaseUrl } = msg;

        // Draco 压缩不支持 → 提前返回 error，bridge 回退主线程
        if (usesDraco(buffer)) {
          (self as any).postMessage({
            type: "error",
            id,
            message: "Draco 压缩不支持（回退主线程）",
          });
          break;
        }

        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);

        // 外部资源（贴图/.bin）按相对 URL 拼到 resourceBaseUrl
        if (resourceBaseUrl) {
          const manager = new THREE.LoadingManager();
          manager.setURLModifier((url: string) => {
            // 绝对 URL（含协议）直接返回
            if (/^https?:\/\//.test(url) || url.startsWith("asset:")) return url;
            // 相对 URL 拼到 resourceBaseUrl
            const base = resourceBaseUrl.endsWith("/")
              ? resourceBaseUrl
              : resourceBaseUrl + "/";
            return new URL(url, base).href;
          });
          (loader as any).manager = manager;
        }

        loader.parse(
          buffer,
          resourceBaseUrl ?? "",
          (gltf: any) => {
            try {
              const sceneJson = gltf.scene.toJSON();
              const animationsJson = (gltf.animations ?? []).map((c: any) =>
                c.toJSON(),
              );
              (self as any).postMessage(
                { type: "parsed", id, sceneJson, animationsJson },
              );
            } catch (jsonErr: any) {
              (self as any).postMessage({
                type: "error",
                id,
                message: `序列化失败（回退主线程）: ${String(jsonErr?.message ?? jsonErr)}`,
              });
            }
          },
          (err: any) => {
            (self as any).postMessage({
              type: "error",
              id,
              message: `glTF 解析失败: ${String(err ?? "未知错误")}`,
            });
          },
        );
      } catch (err: any) {
        (self as any).postMessage({
          type: "error",
          id: msg.id,
          message: String(err?.message ?? err),
        });
      }
      break;
    }
  }
};
export {};
