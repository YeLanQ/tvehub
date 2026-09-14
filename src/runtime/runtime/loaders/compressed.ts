// ---------------------------------------------------------------------------
// 运行时压缩 glTF 解码出口（编译为 public/engine/runtime/loaders/compressed.mjs，
// 由 scripts/build-runtime.mjs 在构建/预览时自动生成，产物 DO NOT EDIT）。
// 单一事实源 = src/framework/mesh/compressed-gltf.ts（编辑器同源），本文件只做
// 播放侧目标适配：
// - 解码器目录固定为产物内页面根相对路径（多文件产物为真实文件；单页/gzip 产物
//   经 pak.mjs 的 fetch 拦截从归档/内联表供数）；
// - 无渲染器可注入 → KTX2 探测跳过（压缩纹理暂不支持，编辑器内已支持；basisBase
//   传占位值，仅在 renderer 存在时才会被使用）；
// - JS 版 Draco 解码器：运行时文件走「文本 IPC」产物通道，二进制 wasm 无法安全
//   通过（UTF-8 往返损坏）；JS 解码慢约一倍，属加载期一次性成本。
// ---------------------------------------------------------------------------
import type { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  applyCompressedGltfSupport,
  setupCompressedGltfSupport,
} from "../../../framework/mesh/compressed-gltf";

const DRACO_DECODER_DIR = "./engine/runtime/loaders/draco/";

let ready = false;

function ensureSetup(): void {
  if (ready) return;
  ready = true;
  setupCompressedGltfSupport({
    dracoBase: DRACO_DECODER_DIR,
    basisBase: DRACO_DECODER_DIR,
    decoderType: "js",
  });
}

/** 给 GLTFLoader 挂压缩解码器（幂等；解析压缩模型前调用） */
export function withCompressedGltf(loader: GLTFLoader): GLTFLoader {
  ensureSetup();
  applyCompressedGltfSupport(loader);
  return loader;
}
