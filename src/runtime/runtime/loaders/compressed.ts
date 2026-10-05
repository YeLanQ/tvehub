// ---------------------------------------------------------------------------
// 运行时压缩 glTF 解码出口（编译为 public/engine/runtime/loaders/compressed.mjs，
// 由 runtime/scripts/engine.mjs 在构建/预览时自动生成，产物 DO NOT EDIT）。
// 单一事实源 = src/framework/mesh/compressed-gltf.ts（编辑器同源），本文件只做
// 播放侧目标适配：
// - 解码器目录固定为产物内页面根相对路径（多文件产物为真实文件；单页/gzip 产物
//   经 pak.mjs 的 fetch 拦截从归档/内联表供数）；
// - wasm 解码器：Draco/Basis 的 wasm 以文件随产物（文本 IPC 经 base64 通道传递，
//   Rust 侧按字节落盘/内联）。three 的 DRACOLoader/KTX2Loader 在主线程以
//   arraybuffer 取 wasm 再 postMessage 进解码 Worker，垫片/真实文件/内联表统一走
//   fetch，产物形态无感知；
// - 微信渠道（桥接钩子 __tveLoadModule 在场 = 桥接层已装配）：注入
//   DracoInlineLoader 主线程内联解码（无 Worker/无 wasm，解码器为包内纯 JS 模块），
//   web 与编辑器预览的 DRACOLoader wasm 形态不受影响。钩子名对齐
//   runtime/bridge/protocol.ts 的 TVE_LOAD_MODULE（引擎源保持字面量登记）；
// - 渲染器注入（KTX2 探测压缩纹理格式）：player 在 createRenderer 后经
//   setRuntimeRenderer 传入，先于首个模型加载（编辑器侧本就直接传 renderer）。
// ---------------------------------------------------------------------------
import type { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  applyCompressedGltfSupport,
  setupCompressedGltfSupport,
} from "../../../framework/mesh/compressed-gltf";
import { DracoInlineLoader } from "./draco-inline";

const DRACO_DECODER_DIR = "./engine/runtime/loaders/draco/";
const BASIS_TRANSCODER_DIR = "./engine/runtime/loaders/basis/";

let ready = false;
let renderer: unknown;

/** 播放器渲染器注入（KTX2 压缩纹理格式探测用；createRenderer 之后、模型加载前调用） */
export function setRuntimeRenderer(instance: unknown): void {
  renderer = instance;
  if (ready) ensureSetup();
}

function ensureSetup(): void {
  ready = true;
  setupCompressedGltfSupport({
    dracoBase: DRACO_DECODER_DIR,
    basisBase: BASIS_TRANSCODER_DIR,
    ...(renderer !== undefined ? { renderer } : {}),
    ...(typeof (globalThis as { __tveLoadModule?: unknown }).__tveLoadModule === "function"
      ? { dracoDecoder: new DracoInlineLoader() }
      : {}),
  });
}

/** 给 GLTFLoader 挂压缩解码器（幂等；解析压缩模型前调用） */
export function withCompressedGltf(loader: GLTFLoader): GLTFLoader {
  ensureSetup();
  applyCompressedGltfSupport(loader);
  return loader;
}
