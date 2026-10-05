// 模型解码 Worker：在独立线程运行 GLTFLoader.parse，避免主线程卡顿。
//
// 重要：此 Worker 不能使用 bare import（如 `from "three"`），因为 Vite dev mode
// 下 Worker 从 blob URL 加载，bare import 无法解析。改用动态 import 从 public/engine/
// 下的物理文件加载（绝对路径 /engine/... 由浏览器相对 origin 解析，blob URL 下也可用）。
//
// 限制：不支持 Draco 压缩（DRACOLoader 未 vendor 为独立文件）；Draco 模型自动
// 回退主线程解析。Meshopt 解码支持（meshopt_decoder.module.js 已 vendor）。
//
// 消息协议（类型单源：桥接端 import type 复用）：
// → ModelDecodeWorkerIn
// ← ModelDecodeWorkerOut

/** 主线程 → Worker */
export type ModelDecodeWorkerIn =
  | { type: "init"; decoderBase: string; basisBase: string }
  | { type: "parse"; id: number; buffer: ArrayBuffer; rel: string; resourceBaseUrl: string };

/** Worker → 主线程（sceneJson/animationsJson 为 three toJSON 纯数据，主线程 ObjectLoader/AnimationClip.parse 重建） */
export type ModelDecodeWorkerOut =
  | { type: "ready" }
  | { type: "parsed"; id: number; sceneJson: object; animationsJson: object[] }
  | { type: "error"; id?: number; message: string };

/** 动态加载的 three 模块结构视图（vendored 构建无类型声明，只声明 worker 消费面；
 *  three 直接引用受 check-layers 门禁约束，本文件不做 three 的类型位置引用） */
interface ThreeView {
  LoadingManager: new () => LoadingManagerView;
}

/** three LoadingManager 的结构视图（外部资源 URL 改写钩子） */
interface LoadingManagerView {
  setURLModifier(modifier: (url: string) => string): void;
}

/** GLTF 解析成功回调的负载（worker 内只做 toJSON 序列化） */
interface WorkerParsedGltf {
  scene: { toJSON(): object };
  animations?: { toJSON(): object }[];
}

/** vendored GLTFLoader 的结构视图（运行时从 /engine/runtime/loaders 动态加载，无类型声明） */
interface WorkerGltfLoader {
  setMeshoptDecoder(decoder: unknown): void;
  manager?: LoadingManagerView;
  parse(
    data: ArrayBuffer,
    path: string,
    onLoad: (gltf: WorkerParsedGltf) => void,
    onError: (err: unknown) => void,
  ): void;
}
type WorkerGltfLoaderCtor = new () => WorkerGltfLoader;

let THREE: ThreeView | null = null;
let GLTFLoader: WorkerGltfLoaderCtor | null = null;
let MeshoptDecoder: unknown = null;
let ready = false;

async function loadModules(): Promise<void> {
  if (THREE) return;
  const origin = self.location.origin;
  THREE = (await import(
    /* @vite-ignore */ `${origin}/engine/core/three.module.min.js`
  )) as ThreeView;
  const gltfMod = await import(/* @vite-ignore */ `${origin}/engine/runtime/loaders/GLTFLoader.js`);
  GLTFLoader = (gltfMod as { GLTFLoader: WorkerGltfLoaderCtor }).GLTFLoader;
  const meshoptMod = await import(/* @vite-ignore */ `${origin}/engine/runtime/loaders/meshopt_decoder.module.js`);
  MeshoptDecoder = (meshoptMod as { MeshoptDecoder: unknown }).MeshoptDecoder;
}

/** 检测 glTF/GLB 是否使用 Draco 压缩（Worker 不支持 Draco，需回退主线程） */
function usesDraco(buffer: ArrayBuffer): boolean {
  try {
    let json: GltfHeaderJson | undefined;
    const view = new DataView(buffer);
    // GLB: magic=0x676C5466 ("glTF")
    if (view.getUint32(0, true) === 0x46546c67) {
      const jsonLen = view.getUint32(12, true);
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen))) as GltfHeaderJson;
    } else {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer))) as GltfHeaderJson;
    }
    const exts = json?.extensionsRequired ?? json?.extensionsUsed ?? [];
    return Array.isArray(exts) && exts.includes("KHR_draco_mesh_compression");
  } catch {
    return false;
  }
}

/** glTF JSON 头部的压缩扩展声明（仅用于 Draco 探测） */
interface GltfHeaderJson {
  extensionsRequired?: string[];
  extensionsUsed?: string[];
}

/** 专用 Worker 作用域（TS DOM lib 下 self 是 Window；收敛 Worker 专有 API 的类型面） */
interface WorkerScope {
  postMessage(message: ModelDecodeWorkerOut, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as ModelDecodeWorkerIn;
  switch (msg.type) {
    case "init": {
      try {
        await loadModules();
        ready = true;
        scope.postMessage({ type: "ready" });
      } catch (err) {
        scope.postMessage({ type: "error", message: `初始化失败: ${errText(err)}` });
      }
      break;
    }
    case "parse": {
      try {
        if (!ready || !THREE || !GLTFLoader) {
          scope.postMessage({ type: "error", id: msg.id, message: "Worker 未就绪" });
          break;
        }
        const { id, buffer, resourceBaseUrl } = msg;

        // Draco 压缩不支持 → 提前返回 error，bridge 回退主线程
        if (usesDraco(buffer)) {
          scope.postMessage({
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
          loader.manager = manager;
        }

        loader.parse(
          buffer,
          resourceBaseUrl ?? "",
          (gltf) => {
            try {
              const sceneJson = gltf.scene.toJSON();
              const animationsJson = (gltf.animations ?? []).map((c) => c.toJSON());
              scope.postMessage({ type: "parsed", id, sceneJson, animationsJson });
            } catch (jsonErr) {
              scope.postMessage({
                type: "error",
                id,
                message: `序列化失败（回退主线程）: ${errText(jsonErr)}`,
              });
            }
          },
          (err) => {
            scope.postMessage({
              type: "error",
              id,
              message: `glTF 解析失败: ${String(err ?? "未知错误")}`,
            });
          },
        );
      } catch (err) {
        scope.postMessage({ type: "error", id: msg.id, message: errText(err) });
      }
      break;
    }
  }
};
export {};
