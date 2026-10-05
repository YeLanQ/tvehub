// 微信 bundle · meshopt 解码器改写：compressed.mjs 内联拷贝与独立 vendored 文件
// 二选一进包——wasm 经包内文件 + 桥接钩子加载，两份内嵌编码串（SIMD/base）被
// 树摇剔除。
//
// 锚点清单（lib/anchor.mjs replaceExact 的 label 索引）：
// - meshopt wasm_base 抽取（正则，非 replaceExact）
// - "meshopt wasm 选择锚点"
// - "meshopt instantiate 锚点"（ready/ready2 双形态兼容）
import { replaceExact, assertWasmMagic } from "../lib/anchor.mjs";
import { MESHOPT_WASM_PATH, TVE_INSTANTIATE_WASM_FILE } from "../../bridge/protocol.ts";

/** meshopt 的 unpack 解码（对齐 vendored meshopt_decoder.module.js 的算法） */
function meshoptUnpack(data) {
  const wasmpack = [
    32, 0, 65, 2, 1, 106, 34, 33, 3, 128, 11, 4, 13, 64, 6, 253, 10, 7, 15, 116, 127, 5, 8, 12,
    40, 16, 19, 54, 20, 9, 27, 255, 113, 17, 42, 67, 24, 23, 146, 148, 18, 14, 22, 45, 70, 69, 56,
    114, 101, 21, 25, 63, 75, 136, 108, 28, 118, 29, 73, 115,
  ];
  const result = new Uint8Array(data.length);
  for (let i = 0; i < data.length; ++i) {
    const ch = data.charCodeAt(i);
    result[i] = ch > 96 ? ch - 97 : ch > 64 ? ch - 39 : ch + 4;
  }
  let write = 0;
  for (let i = 0; i < data.length; ++i) {
    result[write++] = result[i] < 60 ? wasmpack[result[i]] : (result[i] - 60) * 64 + result[++i];
  }
  return result.slice(0, write);
}

/** meshopt 定点改写：wasm 经包内文件 + 桥接钩子加载，wasmOut 收集构建期抽取的字节 */
export function transformMeshopt(text, wasmOut) {
  const baseMatch = /var wasm_base\s*=\s*"([^"]*)"|var wasm_base\s*=\s*'([^']*)'/.exec(text);
  if (!baseMatch) throw new Error("[wechat-bundle] meshopt wasm_base 锚点未命中");
  const bytes = meshoptUnpack(baseMatch[1] ?? baseMatch[2]);
  assertWasmMagic(bytes, "meshopt");
  wasmOut.push(bytes);
  let out = replaceExact(
    text,
    "var wasm = WebAssembly.validate(detector) ? unpack(wasm_simd) : unpack(wasm_base);",
    "var wasm = null; // wechat: wasm 经包内文件 + 桥接钩子加载",
    "meshopt wasm 选择锚点",
  );
  // compressed.mjs 的内联拷贝（esbuild 预构建产物）用 ready2；独立 vendored 文件用 ready
  const READY2 = "var ready2 = WebAssembly.instantiate(wasm, {}).then(function(result) {";
  const READY1 = "var ready = WebAssembly.instantiate(wasm, {}).then(function (result) {";
  const ready2 = out.includes(READY2) ? READY2 : null;
  const ready1 = !ready2 && out.includes(READY1) ? READY1 : null;
  if (!ready2 && !ready1) throw new Error("[wechat-bundle] meshopt instantiate 锚点未命中");
  const varName = ready2 ? "ready2" : "ready";
  return replaceExact(
    out,
    ready2 ?? ready1,
    // 钩子缺位（桥接未激活的求值环境，如 node 冒烟）走拒绝而非 TypeError：
    // ready 的 rejection 由消费方（decodeGltfBufferAsync）与缺失降级承担
    `var ${varName} = typeof globalThis.${TVE_INSTANTIATE_WASM_FILE} === "function"` +
      ` ? globalThis.${TVE_INSTANTIATE_WASM_FILE}(${JSON.stringify(MESHOPT_WASM_PATH)}, {})` +
      ` : Promise.reject(new Error("[wechat] wasm hook unavailable")).then(function(result) {`,
    "meshopt instantiate 锚点",
  );
}
