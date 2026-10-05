// 微信 bundle · 主 bundle 定点改写（esbuild 插件，仅本 bundle 构建内生效，引擎源
// 与 public/engine 产物零改动）：scripts.mjs 动态 import → 钩子、player.mjs 的
// import.meta 合法化 + WebGPU/脚本图动态 import 改写、physics.mjs 引擎动态
// import → 包内键、meshopt 解码器 → 包内文件 + 钩子、data.js 声明 external。
// wasmOut 收集构建期抽取的 wasm 字节（随包 .wasm 文件）。
//
// 锚点清单：
// - "scripts.mjs 动态 import 锚点"
// - "player 物理 Worker URL 锚点"、"player 动画 Worker URL 锚点"
//   （+ 存活 import.meta 行数守卫，>0 抛错）
// - "player WebGPU 粒子材质动态 import"、"player 节点材质 Hook 动态 import"、
//   "player WebGPU three 动态 import"、"player 脚本图模块动态 import"
// - physics.mjs 引擎动态 import（正则，命中数 ≠ 3 抛错）
// - meshopt 三锚点见 ./meshopt.mjs
import fs from "node:fs";

import { replaceExact } from "../lib/anchor.mjs";
import { PHYSICS_ENGINES_PREFIX, TVE_LOAD_MODULE, TVE_SPEC_PREFIX } from "../../bridge/protocol.ts";
import { transformMeshopt } from "./meshopt.mjs";

/** 定点改写插件 */
export function wechatTransformPlugin(wasmOut) {
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
          `return globalThis.${TVE_LOAD_MODULE}(spec);`,
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
          `await globalThis.${TVE_LOAD_MODULE}("../engine/core/particleNodeMaterial.mjs")`,
          "player WebGPU 粒子材质动态 import",
        );
        text = replaceExact(
          text,
          'await import("../engine/core/nodeMaterialHooks.mjs")',
          `await globalThis.${TVE_LOAD_MODULE}("../engine/core/nodeMaterialHooks.mjs")`,
          "player 节点材质 Hook 动态 import",
        );
        text = replaceExact(
          text,
          'await import("../engine/core/three.webgpu.min.js")',
          `await globalThis.${TVE_LOAD_MODULE}("../engine/core/three.webgpu.min.js")`,
          "player WebGPU three 动态 import",
        );
        // 注入式图运行时模块（config.scriptGraphModules，微信产物不配置该键）：
        // 变量动态 import 改写为 hook，失败走既有 catch 诊断
        text = replaceExact(
          text,
          "await import(String(u));",
          `await globalThis.${TVE_LOAD_MODULE}(String(u));`,
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
          const target = `${TVE_SPEC_PREFIX}${PHYSICS_ENGINES_PREFIX}${inner.slice("./physics-engines/".length).replace(/\.mjs$/, ".js")}`;
          return `await globalThis.${TVE_LOAD_MODULE}(${JSON.stringify(target)})`;
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
