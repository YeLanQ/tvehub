// 压缩 glTF（KHR_draco_mesh_compression / EXT_meshopt_compression）解码支持，
// 与编辑器 compressed-gltf.ts 同构：解码器单例 + 给 GLTFLoader 挂载。
// - Draco JS 解码器由 vendor-preview-loaders.mjs vendor 到 ./draco/draco_decoder.js。
//   走「文本 IPC」产物通道 + 固定 JS 版（二进制 wasm 无法安全通过 UTF-8 文本管道；
//   JS 解码慢约一倍，属加载期一次性成本，编辑器视口走 wasm 快路径不受影响）。
//   解码器基路径按页面根相对解析（多文件产物是真实文件；单页/gzip 产物经资产
//   fetch 拦截从归档/内联表供数）——不能用 import.meta.url（单页内联后是 blob）；
// - Meshopt 解码器为自包含 JS 模块（wasm 以 base64 内嵌，无外部文件），直接 import；
// - KTX2 压缩纹理暂未接入运行时（需按渲染器探测格式支持；编辑器内已支持）。
import { DRACOLoader } from "./DRACOLoader.js";
import { MeshoptDecoder } from "./meshopt_decoder.module.js";

const DRACO_DECODER_DIR = "./engine/runtime/loaders/draco/";

let dracoLoader = null;

/** 给 GLTFLoader 挂压缩解码器（幂等；解析压缩模型前调用） */
export function withCompressedGltf(loader) {
  dracoLoader ??= new DRACOLoader()
    .setDecoderConfig({ type: "js" })
    .setDecoderPath(DRACO_DECODER_DIR);
  loader.setDRACOLoader(dracoLoader);
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}
