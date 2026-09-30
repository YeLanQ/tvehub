// 微信小游戏运行时 bundle 构建（产物不入库，public/engine 同一 doctrine）。
//
// 产线形态（public/exports/wechat/runtime/）：
//   code.js                                   单文件 CJS bundle（adapter+player+engine+three，压缩）
//   engine/core/tve.js                        tve 门面（转发 code.js 的 __tveFacade）
//   engine/runtime/physics-engines/rapier.js  rapier CJS 预转换（物理项目随包）
//
// 关键决策（与 web 渠道隔离）：
// - 引擎源码 src/runtime/** 零改动；对本包内三处运行时形态做构建期定点改写
//   （锚点断言命中次数，失配即构建失败）：scripts.mjs 动态 import →
//   __tveLoadModule、player.mjs import.meta.url 合法化 + WebGPU 分支改写、
//   physics.mjs 引擎动态 import 改写（微信产物禁止变量/外部动态 import）。
// - 多入口代码拆分（rollup）被刻意避开：tve 门面以 5 行静态文件转发主 bundle
//   导出，包内少一组 chunk、少一类注册表变数。
//
// 用法：node scripts/build-wechat-runtime.mjs（package.json build 链与 vite 插件挂载）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "public/exports/wechat/runtime");
const BOOTSTRAP = path.join(ROOT, "scripts/wechat-runtime/bootstrap.js");
const PLAYER = path.join(ROOT, "public/web-preview/player.mjs");
const RAPIER_SRC = path.join(ROOT, "public/engine/runtime/physics-engines/rapier.mjs");

/** 产物体积上限告警阈值（微信主包 4MB，data.js 由导出期另计） */
const BUNDLE_WARN_BYTES = 3 * 1024 * 1024;

function replaceExact(text, anchor, replacement, label, expect = 1) {
  const count = text.split(anchor).length - 1;
  if (count !== expect) {
    throw new Error(`[wechat-bundle] ${label} 锚点命中 ${count} 次（期望 ${expect}），产物源可能已变化，请人工核对`);
  }
  return text.split(anchor).join(replacement);
}

/** 定点改写：仅在本 bundle 构建内生效，引擎源与 public/engine 产物零改动 */
function wechatTransformPlugin() {
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
        // tve: 并小写，require 恰好命中包内文件。jolt/ammo v1 不随包，选中时
        // require 报 module not defined（导出期另有后端白名单校验拦截）
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
  await esbuild.build({
    entryPoints: [BOOTSTRAP],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    target: "es2020",
    minify: true,
    legalComments: "none",
    outfile,
    plugins: [wechatTransformPlugin()],
    logLevel: "warning",
  });
  const text = await fs.promises.readFile(outfile, "utf8");
  assertCjsOutput(text, "code.js");
  const bytes = Buffer.byteLength(text);
  if (bytes > BUNDLE_WARN_BYTES) {
    console.warn(`[wechat-bundle] code.js ${(bytes / 1024).toFixed(0)}KB 偏大（告警阈值 ${(BUNDLE_WARN_BYTES / 1024).toFixed(0)}KB，主包 4MB 含 data.js）`);
  }
  return bytes;
}

async function buildRapier() {
  if (!fs.existsSync(RAPIER_SRC)) {
    console.warn("[wechat-bundle] 缺少 rapier.mjs，跳过物理引擎转换");
    return 0;
  }
  const src = await fs.promises.readFile(RAPIER_SRC, "utf8");
  if (src.includes("import.meta") || src.includes("import(")) {
    throw new Error("[wechat-bundle] rapier.mjs 含 import.meta/动态 import，需先人工评估转换策略");
  }
  const outfile = path.join(OUT_DIR, "engine/runtime/physics-engines/rapier.js");
  await esbuild.build({
    entryPoints: [RAPIER_SRC],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    target: "es2020",
    minify: true,
    legalComments: "none",
    outfile,
    logLevel: "warning",
  });
  const text = await fs.promises.readFile(outfile, "utf8");
  assertCjsOutput(text, "rapier.js");
  return Buffer.byteLength(text);
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

/** node 冒烟：最小存根下 require 产物（CJS 形态 + tve 门面可达性） */
async function smokeRequireBundle() {
  const { execFileSync } = await import("node:child_process");
  const smoke = path.join(ROOT, "scripts/wechat-runtime/smoke.cjs");
  execFileSync(
    process.execPath,
    [smoke, path.join(OUT_DIR, "code.js")],
    { stdio: "inherit", timeout: 60_000 },
  );
}

export async function buildWechatRuntime(reason = "") {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const label = reason ? `（${reason}）` : "";
  const codeBytes = await buildMainBundle();
  const rapierBytes = await buildRapier();
  const facadeBytes = writeTveFacade();
  await smokeRequireBundle();
  const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
  console.log(
    `[wechat-bundle] 构建完成${label}: code.js ${kb(codeBytes)} + tve.js ${kb(facadeBytes)}` +
      (rapierBytes ? ` + rapier.js ${kb(rapierBytes)}` : "") +
      ` → public/exports/wechat/runtime/`,
  );
  return { codeBytes, rapierBytes, facadeBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildWechatRuntime().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
