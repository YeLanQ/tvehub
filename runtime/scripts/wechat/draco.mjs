// 微信 bundle · Draco wasm 解码器随包（wrapper 胶水 + .wasm 包内文件）：源 =
// public/engine 的 vendor 产物（自 three examples/jsm/libs/draco/gltf 拷出；
// wrapper 58KB + wasm 192KB，比旧纯 JS 解码器 512KB 再省约 260KB）。解码仍在
// 主线程内联执行（沙箱无 Worker、DRACOLoader 的 Blob Worker 链无法存活），
// 实例化走物理 wasm 同款链路：wrapper 的 emscripten 标准配置口 instantiateWasm
// 由 draco-inline.ts 在运行期接到桥接钩子 __tveInstantiateWasmFile（包内路径
// 直连 WXWebAssembly；字节直传/用户目录路径均被基础库拒绝，包内路径是唯一
// 可靠通路）。本文件只做字节拷贝 + 形态断言，零文本改写。源缺失按跳过（与
// 物理引擎同策略，导出期供给会对缺失文件报错）。
import fs from "node:fs";
import path from "node:path";

import { assertWasmMagic } from "../lib/anchor.mjs";
import { ROOT, WECHAT_RUNTIME_DIR } from "../lib/paths.mjs";

/** 胶水/字节在包内/产物内的键（与 draco-inline.ts 的 DRACO_WRAPPER_SPEC /
 *  DRACO_WASM_PATH 对齐——load-module 剥 tve: 前缀 + 小写折叠后 require 胶水；
 *  wasm 以包内路径直连 WXWebAssembly） */
export const DRACO_WRAPPER_KEY = "engine/runtime/loaders/draco/draco_wasm_wrapper.js";
export const DRACO_WASM_KEY = "engine/runtime/loaders/draco/draco_decoder.wasm";

/** 拷贝 wasm 解码器（胶水 + .wasm）进微信运行时产物目录 + 形态断言。
 *  返回合计字节数（缺源 = 0） */
export function copyDracoWasmDecoder() {
  const glueSrc = path.join(ROOT, "public", DRACO_WRAPPER_KEY);
  const wasmSrc = path.join(ROOT, "public", DRACO_WASM_KEY);
  if (!fs.existsSync(glueSrc) || !fs.existsSync(wasmSrc)) {
    console.warn(
      `[wechat-bundle] 缺少 ${DRACO_WRAPPER_KEY} / ${DRACO_WASM_KEY}（先构建 web 运行时），跳过 Draco 解码器随包`,
    );
    return 0;
  }
  const glueText = fs.readFileSync(glueSrc, "utf8");
  if (!glueText.includes("DracoDecoderModule") || !glueText.includes("instantiateWasm")) {
    throw new Error(
      "[wechat-bundle] draco_wasm_wrapper.js 形态异常（缺 DracoDecoderModule 工厂或 instantiateWasm 配置口，请核对 vendor 产物）",
    );
  }
  // 沙箱红线：胶水一旦引入动态求值（新版上游可能回归 emscripten eval 兜底），
  // 微信 Function hijack 下必死——构建期直接拦下，不带病随包
  if (/\bnew\s+Function\b|\beval\s*\(/.test(glueText)) {
    throw new Error("[wechat-bundle] draco_wasm_wrapper.js 含动态求值调用（微信沙箱禁用，需人工核对新版本解码器）");
  }
  const wasmBytes = fs.readFileSync(wasmSrc);
  assertWasmMagic(wasmBytes, "draco");
  for (const [key, data] of [
    [DRACO_WRAPPER_KEY, glueText],
    [DRACO_WASM_KEY, wasmBytes],
  ]) {
    const out = path.join(WECHAT_RUNTIME_DIR, key);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }
  return Buffer.byteLength(glueText) + wasmBytes.length;
}
