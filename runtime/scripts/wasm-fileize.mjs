// ---------------------------------------------------------------------------
// 物理引擎胶水 wasm 文件化（web 渠道产物）：把 extra/ 下内联 wasm 的物理构建
// 定点改写为「全局钩子加载包外 .wasm 文件」形态，并把 wasm 字节抽取为产物内
// .wasm 文件——rapier/jolt 胶水体量从 2.8/3.2MB 降到百 KB 级，浏览器可缓存、
// 可并行加载，主线程与物理 Worker 走同一钩子链路。
//
// 改写目标 = 全局钩子 __tveInstantiateWasmFile(path, imports)（协议见
// runtime/bridge/protocol.ts，安装方）：
// - web 播放器主线程与物理 Worker：src/runtime/runtime/physics.ts 顶层安装
//   （实现见 src/framework/physics/wasm-file-hook.ts：主线程按文档地址解析、
//   Worker 按 worker 脚本上两级解析）；编辑器 canvas 由 ammoBackend 安装；
// - 微信渠道：桥接垫片安装（WXWebAssembly 包内路径直连）。
// 路径形态 = 产物根相对（如 "engine/runtime/physics-engines/rapier.wasm"），
// 主线程/Worker 各自解析出绝对地址；单页模式被资产 fetch 垫片命中（内联资产表）。
//
// 锚点清单（lib/anchor.mjs replaceExact 的 label 索引）：
// - rapier: "rapier 内嵌 base64 锚点"（+ indexOf 定位与闭合校验）、
//   "rapier fetch 分发锚点"（R2 内嵌 minified 布尔分发长串——上游重打包即失配）、
//   "rapier load IIFE 整体替换锚点"
// - jolt: "jolt 工厂入口锚点"、"jolt 内嵌字节串剥除锚点"（+ 单引号串扫描）
//
// 用法：engine.mjs 构建链内调用 fileizePhysicsEngines()（copyExtraAssets 之后）。
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

import { replaceExact, assertWasmMagic } from "./lib/anchor.mjs";
import { writeIfChanged } from "./lib/fs.mjs";
import { ENGINE_DIR, ROOT } from "./lib/paths.mjs";
import { TVE_INSTANTIATE_WASM_FILE, physicsEnginePath } from "../bridge/protocol.ts";

const EXTRA_DIR = path.join(ROOT, "src", "runtime", "extra", "runtime", "physics-engines");
const OUT_DIR = path.join(ENGINE_DIR, "runtime", "physics-engines");

/** 单引号字符串字面量扫描：返回含引号的完整区间终点（处理反斜杠转义） */
function scanSingleQuotedEnd(text, startIdx) {
  let i = startIdx + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'") return i;
    i += 1;
  }
  throw new Error("[wasm-fileize] 单引号字符串未闭合");
}

/** rapier 定点改写（compat 构建内嵌 base64 → 包外文件路径 + 钩子分发）。
 *  同时把解码出的 wasm 字节写入 wasmOut（落盘 rapier.wasm）。 */
export function transformRapier(text, wasmOut) {
  const PATH = physicsEnginePath("rapier.wasm");
  // R1：默认 init 的内嵌 base64 → 路径字符串（胶水减重 ~2.2MB）。
  // 源形态为 ng.toByteArray("<b64>").buffer —— 尾部 .buffer 一并替换为纯路径串
  const r1Start = text.indexOf('ng.toByteArray("');
  if (r1Start < 0) throw new Error("[wasm-fileize] rapier 内嵌 base64 锚点未命中");
  const b64Start = r1Start + 'ng.toByteArray("'.length;
  const b64End = text.indexOf('")', b64Start);
  if (b64End < 0) throw new Error("[wasm-fileize] rapier 内嵌 base64 未闭合");
  const DOT_BUFFER = '").buffer';
  if (!text.startsWith(DOT_BUFFER, b64End)) {
    throw new Error("[wasm-fileize] rapier base64 尾部 .buffer 锚点不符");
  }
  const b64 = text.slice(b64Start, b64End);
  wasmOut.push(Buffer.from(b64, "base64"));
  let out = replaceExact(
    text,
    text.slice(r1Start, b64End + DOT_BUFFER.length),
    JSON.stringify(PATH),
    "rapier 内嵌 base64 锚点",
  );
  // R2：字符串输入分发（原 fetch）→ 全局钩子
  const R2 = '("string"==typeof A||"function"==typeof Request&&A instanceof Request||"function"==typeof URL&&A instanceof URL)&&(A=fetch(A))';
  out = replaceExact(
    out,
    R2,
    R2.replace("fetch(A)", `globalThis.${TVE_INSTANTIATE_WASM_FILE}(A,I)`),
    "rapier fetch 分发锚点",
  );
  // R3：load IIFE（Response/bytes 分支链）整体替换为直收钩子结果
  const r3Start = out.indexOf("const{instance:g,module:C}=await");
  if (r3Start < 0) throw new Error("[wasm-fileize] rapier load IIFE 锚点未命中");
  const r3EndMarker = "}(await A,I);";
  const r3End = out.indexOf(r3EndMarker, r3Start);
  if (r3End < 0) throw new Error("[wasm-fileize] rapier load IIFE 结束锚点未命中");
  return replaceExact(
    out,
    out.slice(r3Start, r3End + r3EndMarker.length),
    "const{instance:g,module:C}=await A;",
    "rapier load IIFE 整体替换锚点",
  );
}

/** jolt 定点改写：注入 emscripten 标准的 Module.instantiateWasm 钩子（钩子在位时
 *  emscripten 在 `if(d) return` 短路，内嵌字节串永不使用）+ 剥内嵌字节串并抽取
 *  wasm 字节。node 环境分支保留（web 产物恒非 node，死代码无害；微信渠道的 CJS
 *  预转换仍需自行剥除）。 */
export function transformJolt(text, wasmOut) {
  const PATH = physicsEnginePath("jolt.wasm");
  const J1 = "async function Jolt(moduleArg={}){var Module=moduleArg;";
  const HOOK =
    `async function Jolt(moduleArg={}){var Module=moduleArg;` +
    `if(!Module.instantiateWasm){Module.instantiateWasm=function(imports,receiveInstance){` +
    `return globalThis.${TVE_INSTANTIATE_WASM_FILE}(${JSON.stringify(PATH)},imports).then(function(res){` +
    `receiveInstance(res.instance,res.module);return res.instance&&res.instance.exports;});};}`;
  let out = replaceExact(text, J1, HOOK, "jolt 工厂入口锚点");
  // J2：剥内嵌字节串（解码抽成 jolt.wasm 文件）
  const j2Start = out.indexOf("na??=caa('");
  if (j2Start < 0) throw new Error("[wasm-fileize] jolt 内嵌字节串锚点未命中");
  const strStart = j2Start + "na??=caa(".length;
  const strEnd = scanSingleQuotedEnd(out, strStart);
  const literal = out.slice(strStart, strEnd + 1);
  const decoded = new Function(`return ${literal}`)();
  const bytes = Buffer.alloc(decoded.length);
  for (let i = 0; i < decoded.length; i++) {
    if (decoded.charCodeAt(i) > 255) throw new Error("[wasm-fileize] jolt 内嵌串含非字节字符");
    bytes[i] = decoded.charCodeAt(i);
  }
  assertWasmMagic(bytes, "jolt");
  wasmOut.push(bytes);
  return replaceExact(out, out.slice(j2Start, strEnd + 2), "na=void 0;", "jolt 内嵌字节串剥除锚点");
}

/** 从 extra 的 b64 模块抽取 ammo wasm 字节（Buffer） */
function extractAmmoWasm() {
  const b64Text = fs.readFileSync(path.join(EXTRA_DIR, "ammo", "ammo-wasm-b64.mjs"), "utf8");
  const b64 = /export default "([A-Za-z0-9+/=]+)";/.exec(b64Text);
  if (!b64) throw new Error("[wasm-fileize] ammo-wasm-b64 锚点未命中");
  const bytes = Buffer.from(b64[1], "base64");
  assertWasmMagic(bytes, "ammo");
  return bytes;
}

/** 物理引擎产物 wasm 文件化（engine.mjs 构建链步骤，copyExtraAssets 之后执行）：
 *  - rapier/jolt：extra 内联 wasm 构建 → 钩子化胶水 + 同目录 .wasm 文件；
 *  - ammo：胶水/初始化器（已是钩子形态）由 copyExtraAssets 原样拷出，这里只
 *    从 extra b64 模块抽取 ammo.wasm 落盘；
 *  - 清理历史产物中已废的 ammo-wasm-b64.mjs（extra 保留为 wasm 字节事实源，
 *    public/engine 侧不再拷出——清单不该把它当随包文件）。
 *  幂等：内容一致不落盘（dev 重建不触发 watcher 抖动）。 */
export function fileizePhysicsEngines() {
  const report = {};
  const engines = [
    { key: "rapier", src: path.join(EXTRA_DIR, "rapier.mjs"), out: path.join(OUT_DIR, "rapier.mjs"), wasm: path.join(OUT_DIR, "rapier.wasm") },
    { key: "jolt", src: path.join(EXTRA_DIR, "jolt.mjs"), out: path.join(OUT_DIR, "jolt.mjs"), wasm: path.join(OUT_DIR, "jolt.wasm") },
  ];
  for (const def of engines) {
    if (!fs.existsSync(def.src)) {
      console.warn(`[wasm-fileize] 缺少 ${path.relative(ROOT, def.src)}，跳过 ${def.key}`);
      continue;
    }
    const wasmOut = [];
    const srcText = fs.readFileSync(def.src, "utf8");
    const transformed = def.key === "rapier" ? transformRapier(srcText, wasmOut) : transformJolt(srcText, wasmOut);
    if (wasmOut.length !== 1) throw new Error(`[wasm-fileize] ${def.key} wasm 抽取数 ${wasmOut.length}（期望 1）`);
    assertWasmMagic(wasmOut[0], def.key);
    const glueWritten = writeIfChanged(def.out, Buffer.from(transformed, "utf8"));
    const wasmWritten = writeIfChanged(def.wasm, wasmOut[0]);
    if (glueWritten || wasmWritten) {
      report[def.key] = { glue: Buffer.byteLength(transformed), wasm: wasmOut[0].length };
    }
  }
  const ammoBytes = extractAmmoWasm();
  if (writeIfChanged(path.join(OUT_DIR, "ammo", "ammo.wasm"), ammoBytes)) {
    report.ammoWasm = ammoBytes.length;
  }
  const staleB64 = path.join(OUT_DIR, "ammo", "ammo-wasm-b64.mjs");
  if (fs.existsSync(staleB64)) fs.rmSync(staleB64);
  return report;
}
