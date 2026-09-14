// ---------------------------------------------------------------------------
// 压缩 glTF/GLB 解码支持（KHR_draco_mesh_compression / EXT_meshopt_compression /
// KHR_texture_basisu）：解码器单例集中在此管理。
// - DRACO/Basis 解码器文件随应用内置（public/internal/draco/gltf、
//   public/internal/basis），运行时经 asset:// 内置资源 URL 按需拉取（应用层在
//   编辑器挂载后注入基路径）。基路径以 / 结尾由调用方拼接——asset:// 内置作用域
//   拒绝空路径段，目录本身的 URL 不会被请求，加载器只会取「基路径 + 文件名」；
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
  /** 原始渲染器实例（WebGLRenderer / WebGPURenderer，KTX2 格式探测用） */
  renderer: unknown;
}

let dracoLoader: DRACOLoader | null = null;
let ktx2Loader: KTX2Loader | null = null;
let lastRenderer: unknown;

/** 注入解码器基路径并探测 KTX2 支持（编辑器挂载后调用；重复调用幂等） */
export function setupCompressedGltfSupport(setup: CompressedGltfSetup): void {
  if (!dracoLoader) {
    dracoLoader = new DRACOLoader().setDecoderPath(setup.dracoBase);
  }
  if (setup.renderer === lastRenderer) return;
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
