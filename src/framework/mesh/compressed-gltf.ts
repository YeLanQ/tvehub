// ---------------------------------------------------------------------------
// 压缩 glTF/GLB 解码支持（KHR_draco_mesh_compression / EXT_meshopt_compression /
// KHR_texture_basisu）：解码器单例集中在此管理。
// - DRACO/Basis 解码器文件随引擎内置（public/engine/runtime/loaders/draco、
//   public/engine/runtime/loaders/basis），编辑器经相对 HTTP 路径按需拉取
//   （dev 由 Vite 静态服务、prod 随前端 dist 打包）；web 运行时同路径由产物
//   静态服务。基路径以 / 结尾由调用方拼接——加载器只会取「基路径 + 文件名」；
// - Meshopt 解码器是 three 自带的 JS+内嵌 wasm 模块，随代码分包直接 import；
// - KTX2 需按渲染器探测压缩纹理格式支持（WebGL/WebGPU 能力面不同），渲染器实例
//   变化（如重新挂载且后端切换）时重新探测。
// ---------------------------------------------------------------------------

import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/** 解码器就绪状态（loaders.ts 拼错误提示 / 诊断用） */
export interface CompressedGltfSupport {
  draco: boolean;
  ktx2: boolean;
  meshopt: boolean;
}

/** 解码器初始化参数（URL 基路径由应用层经 asset:// 构造，framework 不依赖 lib 层） */
export interface CompressedGltfSetup {
  /** Draco 解码器目录基路径（调用方保证以 / 结尾；含 draco_wasm_wrapper.js 等） */
  dracoBase: string;
  /** Basis 转码器目录基路径（以 / 结尾；含 basis_transcoder.{js,wasm}） */
  basisBase: string;
  /** Draco 解码器形态：wasm（默认，编辑器内置目录含 wrapper+wasm）/ js（web 运行时
   * 用——产物经「文本 IPC」通道分发，二进制 wasm 无法安全通过，目录只含
   * draco_decoder.js） */
  decoderType?: "js" | "wasm";
  /** 原始渲染器实例（WebGLRenderer / WebGPURenderer）；缺省跳过 KTX2 探测
   * （web 运行时无渲染器注入，KTX2 解码保持不可用） */
  renderer?: unknown;
}

let dracoLoader: DRACOLoader | null = null;
let ktx2Loader: KTX2Loader | null = null;
let lastRenderer: unknown;

/** 注入解码器基路径并探测 KTX2 支持（编辑器挂载后调用；重复调用幂等） */
export function setupCompressedGltfSupport(setup: CompressedGltfSetup): void {
  if (!dracoLoader) {
    dracoLoader = new DRACOLoader().setDecoderPath(setup.dracoBase);
    if (setup.decoderType === "js") {
      // r185 起该 API 标记废弃（r194 移除），但 JS 模式仍需它选路 dep_js；
      // three 版本钉在 0.185.x，告警可忽略
      dracoLoader.setDecoderConfig({ type: "js" });
    }
  }
  if (setup.renderer == null || setup.renderer === lastRenderer) return;
  lastRenderer = setup.renderer;
  try {
    ktx2Loader ??= new KTX2Loader().setTranscoderPath(setup.basisBase);
    // three 对 WebGL/WebGPU 两种渲染器都能探测（内部按 isWebGLRenderer 等标记分派）
    ktx2Loader.detectSupport(setup.renderer as Parameters<KTX2Loader["detectSupport"]>[0]);
  } catch (e) {
    ktx2Loader = null;
    console.warn("[gltf] KTX2 解码不可用（压缩纹理将无法解析）:", e);
  }
}

/** 给 GLTFLoader 挂全部已就绪的解码器（每次解析前调用；未初始化的能力跳过） */
export function applyCompressedGltfSupport(loader: GLTFLoader): void {
  if (dracoLoader) loader.setDRACOLoader(dracoLoader);
  if (ktx2Loader) loader.setKTX2Loader(ktx2Loader);
  loader.setMeshoptDecoder(MeshoptDecoder);
}

/** 当前解码器就绪状态（未 setup 时 draco/ktx2 为 false，loaders.ts 据此拼提示） */
export function compressedGltfSupport(): CompressedGltfSupport {
  return {
    draco: dracoLoader != null,
    ktx2: ktx2Loader != null,
    meshopt: true,
  };
}
