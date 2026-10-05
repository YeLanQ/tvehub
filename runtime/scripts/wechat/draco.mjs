// 微信 bundle · Draco 纯 JS 解码器随包：源 = public/engine 的 vendor 产物
// （runtime/scripts/vendor-preview-loaders.mjs 字节拷自 three 的 gltf 变体，
// 512KB、纯 JS、零动态求值）。微信沙箱无 Worker 且 globalThis.Function 被基础库
// hijack（Blob Worker / new Function 全灭）——Draco 解码走主线程内联实现
// （src/runtime/runtime/loaders/draco-inline.ts），经桥接钩子 __tveLoadModule
// require 本文件为包内真实模块：零 Blob、零 Worker、零 wasm（wasm 解码腿的
// 2026-10-03/04 方案已废弃）。源缺失按跳过（与物理引擎同策略，导出期供给
// 会对缺失文件报错）。
import fs from "node:fs";
import path from "node:path";

import { ROOT, WECHAT_RUNTIME_DIR } from "../lib/paths.mjs";

/** 解码器在包内/产物内的键（与 draco-inline.ts 的 DRACO_DECODER_SPEC 对齐——
 *  load-module 剥 tve: 前缀 + 小写折叠后 require 本键） */
export const DRACO_JS_KEY = "engine/runtime/loaders/draco/draco_decoder.js";

/** 拷贝解码器进微信运行时产物目录 + 形态断言。返回字节数（缺源 = 0） */
export function copyDracoJsDecoder() {
  const src = path.join(ROOT, "public", DRACO_JS_KEY);
  if (!fs.existsSync(src)) {
    console.warn(`[wechat-bundle] 缺少 ${DRACO_JS_KEY}（先构建 web 运行时），跳过 Draco 解码器随包`);
    return 0;
  }
  const text = fs.readFileSync(src, "utf8");
  if (!text.includes("DracoDecoderModule")) {
    throw new Error("[wechat-bundle] draco_decoder.js 形态异常（缺 DracoDecoderModule 工厂，请核对 vendor 产物）");
  }
  // 沙箱红线：解码器一旦引入动态求值（新版上游可能回归 emscripten eval 兜底），
  // 微信 Function hijack 下必死——构建期直接拦下，不带病随包
  if (/\bnew\s+Function\b|\beval\s*\(/.test(text)) {
    throw new Error("[wechat-bundle] draco_decoder.js 含动态求值调用（微信沙箱禁用，需人工核对新版本解码器）");
  }
  const out = path.join(WECHAT_RUNTIME_DIR, DRACO_JS_KEY);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  return Buffer.byteLength(text);
}
