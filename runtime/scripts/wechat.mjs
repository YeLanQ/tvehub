// 微信小游戏运行时 bundle 构建（产物不入库，public/engine 同一 doctrine）。
//
// 产线形态（public/exports/wechat/runtime/）：
//   code.js                                   单文件 CJS bundle（adapter+player+engine+three，压缩）
//   engine/core/tve.js                        tve 门面（转发 code.js 的 __tveFacade）
//   engine/runtime/physics-engines/rapier.js/.wasm   rapier 胶水 + 包内 wasm（按项目后端随包）
//   engine/runtime/physics-engines/jolt.js/.wasm     jolt 同上
//   engine/runtime/physics-engines/ammo/ammo-esm.js/.wasm  ammo 同上
//   engine/runtime/loaders/meshopt_decoder.wasm      meshopt（GLTFLoader 内联依赖）
//
// 关键决策（与 web 渠道隔离）：
// - 引擎源码 src/runtime/** 零改动；对本包内三处运行时形态做构建期定点改写
//   （锚点断言命中次数，失配即构建失败）：scripts.mjs 动态 import →
//   __tveLoadModule、player.mjs import.meta.url 合法化 + WebGPU 分支改写、
//   physics.mjs 引擎动态 import 改写（微信产物禁止变量/外部动态 import）。
// - 物理引擎与 meshopt 的 wasm 抽成包内 .wasm 文件：基础库 WXWebAssembly.
//   instantiate 只认代码包内路径（wxfile: 用户目录与字节直传均被拒）；胶水
//   改写为桥接钩子 __tveInstantiateWasmFile(path, imports) 直连，内嵌字节串
//   全部剥除（bundle 从 ~2.8MB/引擎 降到胶水体量）。
// - 多入口代码拆分（rollup）被刻意避开：tve 门面以 5 行静态文件转发主 bundle
//   导出，包内少一组 chunk、少一类注册表变数。
//
// 用法：node runtime/scripts/wechat.mjs（package.json build 链与 vite 插件挂载）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(ROOT, "public/exports/wechat/runtime");
const BRIDGE_DIR = path.join(ROOT, "runtime/bridge");
const BOOTSTRAP = path.join(BRIDGE_DIR, "entries/wechat.ts");
const PLAYER = path.join(ROOT, "public/web-preview/player.mjs");

/** 物理引擎产物：源（public/engine 构建产物）→ 包内 CJS 胶水 + 独立 .wasm 文件。
 *  键名与 physics.mjs 引擎动态 import 的改写目标（tve:engine/runtime/**.js）对齐；
 *  wasm 抽成包内文件（基础库 WXWebAssembly.instantiate 只认代码包内路径），
 *  wasm 路径必须与胶水改写内引用的路径一致。 */
const PHYSICS_ENGINES = [
  {
    key: "rapier",
    src: "public/engine/runtime/physics-engines/rapier.mjs",
    out: "engine/runtime/physics-engines/rapier.js",
    wasm: "engine/runtime/physics-engines/rapier.wasm",
  },
  {
    key: "jolt",
    src: "public/engine/runtime/physics-engines/jolt.mjs",
    out: "engine/runtime/physics-engines/jolt.js",
    wasm: "engine/runtime/physics-engines/jolt.wasm",
  },
  {
    key: "ammo",
    src: "public/engine/runtime/physics-engines/ammo/ammo-esm.mjs",
    out: "engine/runtime/physics-engines/ammo/ammo-esm.js",
    wasm: "engine/runtime/physics-engines/ammo/ammo.wasm",
  },
];

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
  throw new Error("[wechat-bundle] 单引号字符串未闭合");
}

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

/** 断言 wasm 魔数（\0asm + 版本 1），抽取正确性的最后防线 */
function assertWasmMagic(bytes, label) {
  const magic = [0, 0x61, 0x73, 0x6d];
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== magic[i]) throw new Error(`[wechat-bundle] ${label} wasm 魔数不符（抽取逻辑漂移）`);
  }
  if (bytes[4] !== 1) throw new Error(`[wechat-bundle] ${label} wasm 版本非 1`);
}

/** rapier 定点改写：内嵌 base64 → 包内路径；fetch 分发 → 桥接钩子；load IIFE → 直收钩子结果。
 *  同时把解码出的 wasm 字节写入 wasmOut（构建期抽包内 .wasm 文件）。 */
function transformRapier(text, wasmOut) {
  const PATH = "engine/runtime/physics-engines/rapier.wasm";
  // R1：默认 init 的内嵌 base64 → 路径字符串（bundle 减重 ~2.2MB）。
  // 源形态为 ng.toByteArray("<b64>").buffer —— 尾部 .buffer 一并替换为纯路径串
  const r1Start = text.indexOf('ng.toByteArray("');
  if (r1Start < 0) throw new Error("[wechat-bundle] rapier 内嵌 base64 锚点未命中");
  const b64Start = r1Start + 'ng.toByteArray("'.length;
  const b64End = text.indexOf('")', b64Start);
  if (b64End < 0) throw new Error("[wechat-bundle] rapier 内嵌 base64 未闭合");
  const DOT_BUFFER = '").buffer';
  if (!text.startsWith(DOT_BUFFER, b64End)) {
    throw new Error("[wechat-bundle] rapier base64 尾部 .buffer 锚点不符");
  }
  const b64 = text.slice(b64Start, b64End);
  wasmOut.push(Buffer.from(b64, "base64"));
  let out = replaceExact(
    text,
    text.slice(r1Start, b64End + DOT_BUFFER.length),
    JSON.stringify(PATH),
    "rapier 内嵌 base64 锚点",
  );
  // R2：字符串输入分发（原 fetch）→ 桥接钩子（I 与调用点同作用域）
  const R2 = '("string"==typeof A||"function"==typeof Request&&A instanceof Request||"function"==typeof URL&&A instanceof URL)&&(A=fetch(A))';
  out = replaceExact(
    out,
    R2,
    R2.replace("fetch(A)", "globalThis.__tveInstantiateWasmFile(A,I)"),
    "rapier fetch 分发锚点",
  );
  // R3：load IIFE（Response/bytes 分支链在微信全部走不通）整体替换为直收钩子结果
  const r3Start = out.indexOf("const{instance:g,module:C}=await");
  if (r3Start < 0) throw new Error("[wechat-bundle] rapier load IIFE 锚点未命中");
  const r3EndMarker = "}(await A,I);";
  const r3End = out.indexOf(r3EndMarker, r3Start);
  if (r3End < 0) throw new Error("[wechat-bundle] rapier load IIFE 结束锚点未命中");
  return replaceExact(
    out,
    out.slice(r3Start, r3End + r3EndMarker.length),
    "const{instance:g,module:C}=await A;",
    "rapier load IIFE 整体替换锚点",
  );
}

/** jolt 定点改写：注入 emscripten 标准的 Module.instantiateWasm 钩子 + 剥内嵌字节串
 *  + 剥 node 环境分支（node:module 动态 import 在 cjs 输出无法存活）。
 *  钩子在位时 emscripten 在 `if(d) return` 短路，`na` 字节串永不使用。 */
function transformJolt(text, wasmOut) {
  const PATH = "engine/runtime/physics-engines/jolt.wasm";
  // node 环境分支剥除（微信恒非 node）；`if(aa)…;else if(…)` 结构保持（主干挂空语句）
  const NODE_REQUIRE = String.raw`if(aa){let {createRequire:a}=await import("node:module");var ba=a(import.meta.url)}`;
  const NODE_FS = String.raw`ba("node:fs"),da.startsWith("file:")&&ba("node:path").dirname(ba("node:url").fileURLToPath(da)),process.argv.length>1&&(ca=process.argv[1].replace(/\\/g,"/")),process.argv.slice(2)`;
  let out = replaceExact(
    replaceExact(text, NODE_REQUIRE, "if(aa){}", "jolt node createRequire 分支锚点"),
    NODE_FS,
    "void 0",
    "jolt node fs 分支锚点",
  );
  const J1 = "async function Jolt(moduleArg={}){var Module=moduleArg;";
  const HOOK =
    `async function Jolt(moduleArg={}){var Module=moduleArg;` +
    `if(!Module.instantiateWasm){Module.instantiateWasm=function(imports,receiveInstance){` +
    `return globalThis.__tveInstantiateWasmFile(${JSON.stringify(PATH)},imports).then(function(res){` +
    `receiveInstance(res.instance,res.module);return res.instance&&res.instance.exports;});};}`;
  out = replaceExact(out, J1, HOOK, "jolt 工厂入口锚点");
  // J2：剥内嵌字节串（解码抽包内 .wasm 文件）
  const j2Start = out.indexOf("na??=caa('");
  if (j2Start < 0) throw new Error("[wechat-bundle] jolt 内嵌字节串锚点未命中");
  const strStart = j2Start + "na??=caa(".length;
  const strEnd = scanSingleQuotedEnd(out, strStart);
  const literal = out.slice(strStart, strEnd + 1);
  const decoded = new Function(`return ${literal}`)();
  const bytes = Buffer.alloc(decoded.length);
  for (let i = 0; i < decoded.length; i++) {
    if (decoded.charCodeAt(i) > 255) throw new Error("[wechat-bundle] jolt 内嵌串含非字节字符");
    bytes[i] = decoded.charCodeAt(i);
  }
  assertWasmMagic(bytes, "jolt");
  wasmOut.push(bytes);
  return replaceExact(out, out.slice(j2Start, strEnd + 2), "na=void 0;", "jolt 内嵌字节串剥除锚点");
}

/** ammo 胶水改真模块（绕开 new Function 巨串求值——设备端 eval 限制与工具编译
 *  巨字符串的整类风险）：还原原始胶水源码、剥 UMD 尾巴（bundle 内 module.exports
 *  会覆写入口导出）、摘除 this.Ammo=b 严格模式炸点，追加工厂 default 导出。 */
function transformAmmoGlue(gluePath) {
  const text = fs.readFileSync(gluePath, "utf8");
  const script = JSON.parse(
    text.replace(/^\/\/[^\n]*\n/, "").replace(/^export default /, "").replace(/;\s*$/, ""),
  );
  const tailAt = script.indexOf("if (typeof exports === 'object'");
  if (tailAt < 0) throw new Error("[wechat-bundle] ammo 胶水 UMD 尾巴锚点未命中");
  let out = script.slice(0, tailAt);
  out = replaceExact(out, "this.Ammo=b;", "", "ammo 胶水 this.Ammo 锚点");
  // node 分支的 require("fs"/"path") 死代码：改名防 esbuild 按 CJS require 解析打包
  const NODE_REQUIRE = 'var fs=require("fs"),la=require("path")';
  out = replaceExact(
    out,
    NODE_REQUIRE,
    'var fs=__tveDeadRequire("fs"),la=__tveDeadRequire("path")',
    "ammo 胶水 node require 锚点",
  );
  return `${out}\n;export default Ammo;\n`;
}

/** ammo 入口改写：工厂从胶水模块直取（替代 new Function 字符串求值） */
function transformAmmoEntry(srcText) {
  const ANCHOR =
    'const factory = new Function(\n    AMMO_GLUE + "\\n;return typeof Ammo === \'function\' ? Ammo : undefined;",\n  )();';
  return replaceExact(srcText, ANCHOR, "const factory = AMMO_GLUE;", "ammo 入口工厂锚点");
}

/** meshopt 定点改写（compressed.mjs 内联拷贝与独立 vendored 文件二选一进包）：
 *  wasm 经包内文件 + 桥接钩子加载，两份内嵌编码串（SIMD/base）被树摇剔除。 */
function transformMeshopt(text, wasmOut) {
  const PATH = "engine/runtime/loaders/meshopt_decoder.wasm";
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
    `var ${varName} = typeof globalThis.__tveInstantiateWasmFile === "function"` +
      ` ? globalThis.__tveInstantiateWasmFile(${JSON.stringify(PATH)}, {})` +
      ` : Promise.reject(new Error("[wechat] wasm hook unavailable")).then(function(result) {`,
    "meshopt instantiate 锚点",
  );
}

/** 产物体积上限告警阈值（微信主包 4MB，data.js 由导出期另计） */
const BUNDLE_WARN_BYTES = 3 * 1024 * 1024;

function replaceExact(text, anchor, replacement, label, expect = 1) {
  const count = text.split(anchor).length - 1;
  if (count !== expect) {
    throw new Error(`[wechat-bundle] ${label} 锚点命中 ${count} 次（期望 ${expect}），产物源可能已变化，请人工核对`);
  }
  return text.split(anchor).join(replacement);
}

/** 定点改写：仅在本 bundle 构建内生效，引擎源与 public/engine 产物零改动。
 *  wasmOut 收集构建期抽取的 wasm 字节（随包 .wasm 文件）。 */
function wechatTransformPlugin(wasmOut) {
  return {
    name: "tve-wechat-transforms",
    setup(build) {
      // 用户脚本动态加载：import(spec) 无法被工具静态编译，bundle 内也不允许
      // 动态 import 存活——统一改写为适配层 hook（strip tve: / 小写 / require）
      build.onLoad({ filter: /engine[\\/]core[\\/]scripts\.mjs$/ }, async (args) => {
        const text = await fs.promises.readFile(args.path, "utf8");
        const out = replaceExact(
          text,
          "return await import(spec);",
          "return globalThis.__tveLoadModule(spec);",
          "scripts.mjs 动态 import 锚点",
        );
        return { contents: out, loader: "js" };
      });

      build.onLoad({ filter: /web-preview[\\/]player\.mjs$/ }, async (args) => {
        let text = await fs.promises.readFile(args.path, "utf8");
        // import.meta.url 在 cjs 输出中不合法；两处代码仅 !inline（微信恒 inline）
        // 可达，按精确锚点合法化为字面量；注释里的提法经 minify 剥除，无碍
        text = replaceExact(
          text,
          'new URL("../engine/runtime/physics-worker.mjs", import.meta.url).href',
          '""',
          "player 物理 Worker URL 锚点",
        );
        text = replaceExact(
          text,
          'new URL("../engine/runtime/animation-worker.mjs", import.meta.url).href',
          '""',
          "player 动画 Worker URL 锚点",
        );
        const liveImportMeta = text
          .split("\n")
          .filter((line) => {
            const noComment = line.split("//")[0];
            return noComment.includes("import.meta");
          })
          .length;
        if (liveImportMeta > 0) {
          throw new Error(`[wechat-bundle] player.mjs 仍有 ${liveImportMeta} 行存活 import.meta（需扩展锚点）`);
        }
        // WebGPU 分支动态 import（微信后端恒 WebGL，永不执行）：改写为 hook 保
        // cjs 输出合法，且 three.webgpu 等不进 bundle
        text = replaceExact(
          text,
          'await import("../engine/core/particleNodeMaterial.mjs")',
          'await globalThis.__tveLoadModule("../engine/core/particleNodeMaterial.mjs")',
          "player WebGPU 粒子材质动态 import",
        );
        text = replaceExact(
          text,
          'await import("../engine/core/nodeMaterialHooks.mjs")',
          'await globalThis.__tveLoadModule("../engine/core/nodeMaterialHooks.mjs")',
          "player 节点材质 Hook 动态 import",
        );
        text = replaceExact(
          text,
          'await import("../engine/core/three.webgpu.min.js")',
          'await globalThis.__tveLoadModule("../engine/core/three.webgpu.min.js")',
          "player WebGPU three 动态 import",
        );
        // 注入式图运行时模块（config.scriptGraphModules，微信产物不配置该键）：
        // 变量动态 import 改写为 hook，失败走既有 catch 诊断
        text = replaceExact(
          text,
          "await import(String(u));",
          "await globalThis.__tveLoadModule(String(u));",
          "player 脚本图模块动态 import",
        );
        return { contents: text, loader: "js" };
      });

      build.onLoad({ filter: /engine[\\/]runtime[\\/]physics\.mjs$/ }, async (args) => {
        const text = await fs.promises.readFile(args.path, "utf8");
        // 物理引擎动态 import → 适配层 hook（tve: 前缀 = 包内键形态）：
        // 原 "./physics-engines/rapier.mjs" 相对 engine/runtime/ 解析，包内键为
        // engine/runtime/physics-engines/rapier.js（CJS 预转换产物）——hook 剥
        // tve: 并小写，require 恰好命中包内文件（rapier/jolt/ammo 全部随包）
        const re = /await import\(("\.\/physics-engines\/[^"]+")\)/g;
        const hits = [...text.matchAll(re)];
        if (hits.length !== 3) {
          throw new Error(`[wechat-bundle] physics.mjs 引擎动态 import 命中 ${hits.length} 处（期望 3）`);
        }
        const out = text.replace(re, (_m, spec) => {
          const inner = JSON.parse(spec); // "./physics-engines/rapier.mjs"
          const target = `tve:engine/runtime/${inner.slice(2).replace(/\.mjs$/, ".js")}`;
          return `await globalThis.__tveLoadModule(${JSON.stringify(target)})`;
        });
        return { contents: out, loader: "js" };
      });

      // 导出期数据桥的 external 声明（相对 bootstrap 源位的 ./data.js 保留为运行期 require）
      build.onResolve({ filter: /^\.\/data\.js$/ }, () => ({ external: true, path: "./data.js" }));
      // meshopt 解码器（compressed.mjs 内联拷贝为主形态；独立 vendored 文件兼容）：
      // 模块求值期即实例化 wasm——平台缺 wasm 链路时的首个炸点，改走包内文件 + 钩子
      build.onLoad({ filter: /loaders[\\/](compressed|meshopt_decoder\.module)\.m?js$/ }, async (args) => {
        const text = await fs.promises.readFile(args.path, "utf8");
        return { contents: transformMeshopt(text, wasmOut), loader: "js" };
      });
    },
  };
}

/** 产物断言：cjs 输出里不允许任何 import()/import 语句/裸 export 存活 */
function assertCjsOutput(text, label) {
  const dynamicImport = text.match(/[^.\w$"']import\s*\(/);
  if (dynamicImport) {
    const at = dynamicImport.index;
    throw new Error(`[wechat-bundle] ${label} 存活动态 import: …${text.slice(Math.max(0, at - 60), at + 60)}…`);
  }
  if (/(^|[;{}\n])\s*import\s*["']/.test(text) || /(^|[;{}\n])\s*export\s+\{/.test(text)) {
    throw new Error(`[wechat-bundle] ${label} 存活 ESM import/export 语句`);
  }
}

async function buildMainBundle() {
  const outfile = path.join(OUT_DIR, "code.js");
  const wasmOut = [];
  await esbuild.build({
    entryPoints: [BOOTSTRAP],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    target: "es2020",
    minify: true,
    legalComments: "none",
    outfile,
    plugins: [wechatTransformPlugin(wasmOut)],
    logLevel: "warning",
  });
  // meshopt 的 wasm 随包（loaders 组；GLTFLoader meshopt 压缩模型依赖）
  if (wasmOut.length) {
    const wasmPath = path.join(OUT_DIR, "engine/runtime/loaders/meshopt_decoder.wasm");
    fs.mkdirSync(path.dirname(wasmPath), { recursive: true });
    fs.writeFileSync(wasmPath, wasmOut[0]);
  }
  const text = await fs.promises.readFile(outfile, "utf8");
  assertCjsOutput(text, "code.js");
  const bytes = Buffer.byteLength(text);
  if (bytes > BUNDLE_WARN_BYTES) {
    console.warn(`[wechat-bundle] code.js ${(bytes / 1024).toFixed(0)}KB 偏大（告警阈值 ${(BUNDLE_WARN_BYTES / 1024).toFixed(0)}KB，主包 4MB 含 data.js）`);
  }
  return { code: bytes, meshoptWasm: wasmOut.length ? wasmOut[0].length : 0 };
}

/** 物理引擎 CJS 预转换（rapier/jolt/ammo 全部随包）：胶水内嵌 wasm 抽成包内
 *  .wasm 文件（基础库 WXWebAssembly.instantiate 只认代码包内路径），胶水改写为
 *  桥接钩子直连（bundle 减重：内嵌字节串全部剥除）。源缺失按跳过（导出期供给
 *  会对缺失文件报错）。 */
async function buildPhysicsEngines() {
  const sizes = {};
  for (const def of PHYSICS_ENGINES) {
    const srcPath = path.join(ROOT, def.src);
    if (!fs.existsSync(srcPath)) {
      console.warn(`[wechat-bundle] 缺少 ${def.src}，跳过 ${def.key} 物理引擎转换`);
      continue;
    }
    const srcText = await fs.promises.readFile(srcPath, "utf8");
    const wasmOut = [];
    const entryFile = def.src.replace(/^.*\//, "");
    const entryFilter =
      def.key === "ammo"
        ? /(ammo-esm|ammo-glue)\.mjs$/
        : new RegExp(`${entryFile.replace(/\./g, "\\.")}$`);
    const enginePlugin = {
      name: "tve-wechat-engine-transform",
      setup(build) {
        build.onLoad({ filter: entryFilter }, async (args) => {
          if (def.key === "rapier") return { contents: transformRapier(srcText, wasmOut), loader: "js" };
          if (def.key === "jolt") return { contents: transformJolt(srcText, wasmOut), loader: "js" };
          // ammo：胶水改真模块 + 入口工厂直取（eval 零参与）
          if (args.path.replace(/^.*[\\/]/, "") === "ammo-glue.mjs") {
            return { contents: transformAmmoGlue(args.path), loader: "js" };
          }
          return { contents: transformAmmoEntry(srcText), loader: "js" };
        });
      },
    };
    const outfile = path.join(OUT_DIR, def.out);
    fs.mkdirSync(path.dirname(outfile), { recursive: true });
    await esbuild.build({
      entryPoints: [srcPath],
      bundle: true,
      format: "cjs",
      platform: "neutral",
      target: "es2020",
      minify: true,
      legalComments: "none",
      charset: "utf8",
      define: def.key === "ammo" ? { __TVE_WECHAT__: "true" } : undefined,
      outfile,
      plugins: [enginePlugin],
      logLevel: "warning",
    });
    // ammo 的 wasm 从 b64 产物抽取（其余引擎在 transform 内抽取）
    if (def.key === "ammo") {
      const b64File = path.join(ROOT, "public/engine/runtime/physics-engines/ammo/ammo-wasm-b64.mjs");
      const b64Text = await fs.promises.readFile(b64File, "utf8");
      const b64 = /export default "([A-Za-z0-9+/=]+)";/.exec(b64Text);
      if (!b64) throw new Error("[wechat-bundle] ammo-wasm-b64 锚点未命中");
      const bytes = Buffer.from(b64[1], "base64");
      assertWasmMagic(bytes, "ammo");
      wasmOut.push(bytes);
    }
    // 包内 .wasm 文件（与胶水同目录、同主名）
    if (wasmOut.length) {
      const wasmPath = path.join(OUT_DIR, def.wasm);
      fs.writeFileSync(wasmPath, wasmOut[0]);
      sizes[`${def.key}Wasm`] = wasmOut[0].length;
    }
    const text = await fs.promises.readFile(outfile, "utf8");
    assertCjsOutput(text, def.out);
    if (text.includes("import.meta")) {
      throw new Error(`[wechat-bundle] ${def.out} 存活 import.meta（cjs 输出非法）`);
    }
    sizes[def.key] = Buffer.byteLength(text);
  }
  return sizes;
}

function writeTveFacade() {
  // tve 门面：转发主 bundle 的命名空间导出（用户脚本 require "../../engine/core/tve.js"）
  const facade =
    "// 由 scripts/build-wechat-runtime.mjs 生成（请勿手动编辑）：\n" +
    "// 用户脚本 tve 门面——转发主 bundle 的 __tveFacade（= engine/core/tve.mjs 全部导出）。\n" +
    '"use strict";\n' +
    'var facade = require("../../code.js");\n' +
    "module.exports = (facade && facade.__tveFacade) || {};\n";
  const file = path.join(OUT_DIR, "engine/core/tve.js");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, facade);
  return Buffer.byteLength(facade);
}

/** node 冒烟：最小存根下 require 产物（CJS 形态 + tve 门面可达性 + 物理引擎可加载） */
async function smokeRequireBundle(engineSizes) {
  const { execFileSync } = await import("node:child_process");
  const smoke = path.join(BRIDGE_DIR, "smoke.cjs");
  const engineFiles = PHYSICS_ENGINES
    .filter((def) => engineSizes[def.key] !== undefined)
    .map((def) => path.join(OUT_DIR, def.out));
  execFileSync(
    process.execPath,
    [smoke, path.join(OUT_DIR, "code.js"), ...engineFiles],
    { stdio: "inherit", timeout: 120_000 },
  );
}

/** 契约一致性测试：桥接核心语义 + 平台端点（实验室判定集固化，见 bridge.spec.mjs） */
async function runBridgeSpec() {
  const { execFileSync } = await import("node:child_process");
  execFileSync(
    process.execPath,
    [path.join(BRIDGE_DIR, "bridge.spec.mjs")],
    { stdio: "inherit", timeout: 120_000 },
  );
}

/** 漂移守卫：统一运行时源码的全局用法对照桥接覆盖清单（未覆盖新增 = 构建失败） */
async function runSurfaceCheck() {
  const { execFileSync } = await import("node:child_process");
  execFileSync(
    process.execPath,
    [path.join(BRIDGE_DIR, "check-surface.mjs")],
    { stdio: "inherit", timeout: 60_000 },
  );
}

export async function buildWechatRuntime(reason = "") {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const label = reason ? `（${reason}）` : "";
  const main = await buildMainBundle();
  const engines = await buildPhysicsEngines();
  const facadeBytes = writeTveFacade();
  await runSurfaceCheck();
  await runBridgeSpec();
  await smokeRequireBundle(engines);
  const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
  const engineSummary = Object.entries(engines)
    .map(([key, bytes]) => `${key} ${kb(bytes)}`)
    .join(" + ");
  console.log(
    `[wechat-bundle] 构建完成${label}: code.js ${kb(main.code)} + tve.js ${kb(facadeBytes)}` +
      (engineSummary ? ` + ${engineSummary}` : "") +
      ` → public/exports/wechat/runtime/`,
  );
  return { codeBytes: main.code, engines, facadeBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildWechatRuntime().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
