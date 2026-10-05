// 微信 bundle · 物理引擎 CJS 预转换（rapier/jolt/ammo 全部随包）：源 = public/engine
// 的钩子化产物（wasm 已在 web 渠道 wasm 文件化时抽成同目录 .wasm，见
// wasm-fileize.mjs），微信侧只做 cjs 形态转换（jolt 剥 node 分支；ammo 胶水改真
// 模块 + 入口工厂直取），.wasm 直接取产物同目录文件随包（桥接垫片经
// WXWebAssembly 以包内路径直连）。源缺失按跳过（导出期供给会对缺失文件报错）。
//
// 锚点清单：
// - jolt: "jolt node createRequire 分支锚点"、"jolt node fs 分支锚点"
//   （String.raw 内嵌 minified 变量名 aa/ba/da/ca——jolt 上游重打包即失配，人工核对）
// - ammo 胶水: "ammo 胶水 UMD 尾巴锚点"（indexOf 判定）、"ammo 胶水 this.Ammo 锚点"、
//   "ammo 胶水 node require 锚点"
// - ammo 入口: "ammo 入口工厂锚点"
// - 各引擎: "N wasm 魔数"（assertWasmMagic）
import fs from "node:fs";
import path from "node:path";

import { replaceExact, assertWasmMagic, assertCjsOutput } from "../lib/anchor.mjs";
import { cjsBundleOptions, esbuildBuild } from "../lib/esbuild.mjs";
import { ROOT, WECHAT_RUNTIME_DIR, ENGINE_DIR } from "../lib/paths.mjs";
import { PHYSICS_ENGINES_PREFIX } from "../../bridge/protocol.ts";

/** 物理引擎产物根相对路径（胶水与同目录 .wasm 同主名） */
function physicsEnginePath(file) {
  return PHYSICS_ENGINES_PREFIX + file;
}

/** 物理引擎产物：源（public/engine 钩子化产物）→ 包内 CJS 胶水 + 独立 .wasm 文件。
 *  键名与 physics.mjs 引擎动态 import 的改写目标（tve:engine/runtime/**.js）对齐；
 *  wasm 以包内文件随包（基础库 WXWebAssembly.instantiate 只认代码包内路径），
 *  包内路径必须与 web 产物胶水钩子引用的路径一致（同源同布局）。 */
export const PHYSICS_ENGINES = [
  {
    key: "rapier",
    src: path.join(ENGINE_DIR, "runtime/physics-engines/rapier.mjs"),
    out: physicsEnginePath("rapier.js"),
    wasm: physicsEnginePath("rapier.wasm"),
  },
  {
    key: "jolt",
    src: path.join(ENGINE_DIR, "runtime/physics-engines/jolt.mjs"),
    out: physicsEnginePath("jolt.js"),
    wasm: physicsEnginePath("jolt.wasm"),
  },
  {
    key: "ammo",
    src: path.join(ENGINE_DIR, "runtime/physics-engines/ammo/ammo-esm.mjs"),
    out: physicsEnginePath("ammo/ammo-esm.js"),
    wasm: physicsEnginePath("ammo/ammo.wasm"),
  },
];

/** jolt 定点改写：剥 node 环境分支（node:module 动态 import 在 cjs 输出无法存活，
 *  且产物不允许 import.meta 残留）。wasm 钩子化与内嵌字节串剥除已在 web 渠道
 *  wasm 文件化时完成（runtime/scripts/wasm-fileize.mjs），此处源即最终形态。 */
export function transformJolt(text) {
  // node 环境分支剥除（微信恒非 node）；`if(aa)…;else if(…)` 结构保持（主干挂空语句）
  const NODE_REQUIRE = String.raw`if(aa){let {createRequire:a}=await import("node:module");var ba=a(import.meta.url)}`;
  const NODE_FS = String.raw`ba("node:fs"),da.startsWith("file:")&&ba("node:path").dirname(ba("node:url").fileURLToPath(da)),process.argv.length>1&&(ca=process.argv[1].replace(/\\/g,"/")),process.argv.slice(2)`;
  return replaceExact(
    replaceExact(text, NODE_REQUIRE, "if(aa){}", "jolt node createRequire 分支锚点"),
    NODE_FS,
    "void 0",
    "jolt node fs 分支锚点",
  );
}

/** ammo 胶水改真模块（绕开 new Function 巨串求值——设备端 eval 限制与工具编译
 *  巨字符串的整类风险）：还原原始胶水源码、剥 UMD 尾巴（bundle 内 module.exports
 *  会覆写入口导出）、摘除 this.Ammo=b 严格模式炸点，追加工厂 default 导出。 */
export function transformAmmoGlue(gluePath) {
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
export function transformAmmoEntry(srcText) {
  const ANCHOR =
    'const factory = new Function(\n    AMMO_GLUE + "\\n;return typeof Ammo === \'function\' ? Ammo : undefined;",\n  )();';
  return replaceExact(srcText, ANCHOR, "const factory = AMMO_GLUE;", "ammo 入口工厂锚点");
}

/** 物理引擎 CJS 预转换主流程：逐引擎 esbuild（统一 cjsBundleOptions）+ .wasm
 *  字节直拷（魔数断言）+ 产物形态断言。返回尺寸报告（供冒烟与汇总日志）。 */
export async function buildPhysicsEngines() {
  const sizes = {};
  for (const def of PHYSICS_ENGINES) {
    if (!fs.existsSync(def.src)) {
      console.warn(`[wechat-bundle] 缺少 ${path.relative(ROOT, def.src)}，跳过 ${def.key} 物理引擎转换`);
      continue;
    }
    const wasmSrc = path.join(ROOT, "public", def.wasm);
    if (!fs.existsSync(wasmSrc)) {
      console.warn(
        `[wechat-bundle] 缺少 ${path.relative(ROOT, wasmSrc)}（先构建 web 运行时），跳过 ${def.key}`,
      );
      continue;
    }
    const srcText = await fs.promises.readFile(def.src, "utf8");
    // def.src 是平台原生分隔符的绝对路径；filter 只取文件名（esbuild 的 Go 正则
    // 不认完整 Windows 路径，且 ammo 特例按双文件名匹配）
    const entryFile = def.src.split(/[\\/]/).pop();
    const entryFilter =
      def.key === "ammo"
        ? /(ammo-esm|ammo-glue)\.mjs$/
        : new RegExp(`${entryFile.replace(/\./g, "\\.")}$`);
    const enginePlugin =
      def.key === "rapier"
        ? []
        : [
            {
              name: "tve-wechat-engine-transform",
              setup(build) {
                build.onLoad({ filter: entryFilter }, async (args) => {
                  if (def.key === "jolt") return { contents: transformJolt(srcText), loader: "js" };
                  // ammo：胶水改真模块 + 入口工厂直取（eval 零参与）
                  if (args.path.replace(/^.*[\\/]/, "") === "ammo-glue.mjs") {
                    return { contents: transformAmmoGlue(args.path), loader: "js" };
                  }
                  return { contents: transformAmmoEntry(srcText), loader: "js" };
                });
              },
            },
          ];
    const outfile = path.join(WECHAT_RUNTIME_DIR, def.out);
    fs.mkdirSync(path.dirname(outfile), { recursive: true });
    await esbuildBuild(
      cjsBundleOptions({
        entryPoints: [def.src],
        outfile,
        plugins: enginePlugin,
      }),
    );
    // 包内 .wasm 文件（与胶水同目录、同主名）：产物字节直拷 + 魔数断言
    const wasmBytes = await fs.promises.readFile(wasmSrc);
    assertWasmMagic(wasmBytes, def.key);
    fs.writeFileSync(path.join(WECHAT_RUNTIME_DIR, def.wasm), wasmBytes);
    sizes[`${def.key}Wasm`] = wasmBytes.length;
    const text = await fs.promises.readFile(outfile, "utf8");
    assertCjsOutput(text, def.out);
    if (text.includes("import.meta")) {
      throw new Error(`[wechat-bundle] ${def.out} 存活 import.meta（cjs 输出非法）`);
    }
    sizes[def.key] = Buffer.byteLength(text);
  }
  return sizes;
}
