// 微信 bundle · 物理 Worker 构建（产物 workers/<backend>/tve.js，按后端一份）：
// 入口 = bridge/entries/wechat-worker.ts（ns 信封 + wasm 字节中继 + 物理/动画
// 双路由），打包四件套——three（src/runtime 下不存在的构建，解析到 public/engine
// 并内联）、physics-worker 路由 + createPhysics 全量（src/runtime 源直入）、
// animation-worker 路由 + createAnimations 全量（同上；CCDIKSolver 为 vendor
// 产物，src 下只有 .d.ts → 同插件映射到 public/engine）、预构建 CJS 胶水
// （选中的后端静态 import 进 bundle；其余两枚动态 import 改写为拒绝型 Promise，
// createPhysics 只加载配置后端、永不触达）。physics/animation 共享单实例 worker
// （wx.createWorker 平台限额每包 1 个，ns 信封多路复用），故动画路由随各后端
// bundle 一起进包。
//
// 与主 bundle（wechat.mjs）的关系：物理引擎胶水须先经 buildPhysicsEngines 产出
// （本模块直接消费其产物），wasm 不进 worker bundle——worker 线程经 bridge 保留
// 信道向主线程要包内 .wasm 字节（worker 线程无文件系统/WXWebAssembly）。动画
// 路由无 wasm 依赖（纯数学代理重建），worker bundle 内零 wasm 请求即可用。
import fs from "node:fs";
import path from "node:path";

import { assertCjsOutput } from "../lib/anchor.mjs";
import { cjsBundleOptions, esbuildBuild } from "../lib/esbuild.mjs";
import { BRIDGE_DIR, ENGINE_DIR, ROOT, WECHAT_RUNTIME_DIR } from "../lib/paths.mjs";
import { PHYSICS_ENGINES } from "./engines.mjs";

/** physics.ts 源内三处引擎动态 import 的字面量说明符（与源码严格一致，失配即失败） */
function engineImportSpec(def) {
  return `./physics-engines/${def.key === "ammo" ? "ammo/ammo-esm.mjs" : `${def.key}.mjs`}`;
}

/** three / vendor 产物解析：src/runtime 下不存在的构建期外部化产物同路径 →
 *  public/engine（worker 自包含，必须打包进去）。CCDIKSolver 为 vendor 拷贝
 *  （animation.ts 的 IK 求解器依赖），其内部 three import 已是相对说明符，
 *  落到 ENGINE_DIR 后被第一条规则接住。 */
function workerResolvePlugin() {
  return {
    name: "tve-wechat-worker-resolve",
    setup(build) {
      build.onResolve({ filter: /three\.module\.min\.js$/ }, () => ({
        path: path.join(ENGINE_DIR, "core", "three.module.min.js"),
      }));
      build.onResolve({ filter: /(?:^|[\\/])loaders[\\/]CCDIKSolver\.js$/ }, () => ({
        path: path.join(ENGINE_DIR, "runtime", "loaders", "CCDIKSolver.js"),
      }));
    },
  };
}

/** physics.ts 定点改写（按选中后端）：三处引擎动态 import → 选中者静态绑定
 *  预构建 CJS 胶水（经 default 互操作归一），其余拒绝型。
 *
 *  互操作坑：仓库 "type":"module" 下预构建 .js 须以 .cjs 暂存强制 CJS（见
 *  stageGlueAsCjs）；esbuild 对 CJS 的 import * as ns 做 __toESM（非 node 模式）
 *  时 ns.default = 整个 module.exports，胶水真 default 再深一层——helper 统一
 *  剥层（ESM 直通形态 default 即真身；web 产物不经此路径零影响）。 */
const INTEROP_HELPER = [
  "function __tveEngineInteropDefault(ns: unknown): unknown {",
  "  const d = ns && typeof ns === \"object\" ? (ns as { default?: unknown }).default : ns;",
  "  if (d && typeof d === \"object\" && \"default\" in (d as Record<string, unknown>)) {",
  "    return (d as { default: unknown }).default;",
  "  }",
  "  return d;",
  "}",
].join("\n");

function workerPhysicsPlugin(backend, glueByBinding) {
  return {
    name: "tve-wechat-worker-physics",
    setup(build) {
      build.onLoad({ filter: /(?:^|[\\/])physics\.ts$/ }, async (args) => {
        let text = await fs.promises.readFile(args.path, "utf8");
        const imports = [];
        for (const def of PHYSICS_ENGINES) {
          const anchor = `await import("${engineImportSpec(def)}")`;
          if (!text.includes(anchor)) {
            throw new Error(`[wechat-worker] ${def.key} 动态 import 锚点未命中: ${anchor}`);
          }
          if (def.key === backend) {
            const binding = `__tveEngine_${def.key}`;
            imports.push(`import * as ${binding} from ${JSON.stringify(glueByBinding[def.key])};`);
            // rapier/jolt 消费面走 mod.default（引擎 API / 初始化工厂）→ 归一后
            // 包回 namespace 形态，源码后续 mod.default 读取零改动；ammo 消费面
            // 解构命名导出 initAmmo → 直取 namespace
            const resolved =
              def.key === "ammo"
                ? `await Promise.resolve(${binding})`
                : `await Promise.resolve({ default: __tveEngineInteropDefault(${binding}) })`;
            text = text.split(anchor).join(resolved);
          } else {
            text = text
              .split(anchor)
              .join(`Promise.reject(new Error("[wechat-worker] 引擎未随本 worker 打包: ${def.key}"))`);
          }
        }
        return { contents: `${imports.join("\n")}\n${INTEROP_HELPER}\n${text}`, loader: "ts" };
      });
    },
  };
}

/** 胶水暂存：预构建产物为 .js，仓库 package.json "type":"module" 作用域下 esbuild
 *  按 ESM 解析（module.exports 沦为死代码 → 空命名空间）——拷为 .cjs 强制 CJS
 *  语义再入 bundle。暂存目录在 runtime/ 扫描树之外（不进 manifest），构建后清理。 */
function stageGlueAsCjs(def, stageDir) {
  const src = path.join(WECHAT_RUNTIME_DIR, def.out);
  const dest = path.join(stageDir, `glue-${def.key}.cjs`);
  fs.mkdirSync(stageDir, { recursive: true });
  fs.copyFileSync(src, dest);
  return dest.split(path.sep).join("/");
}

/** 逐后端构建 worker bundle（依赖 buildPhysicsEngines 先行产出预构建胶水） */
export async function buildWorkerBundles() {
  const sizes = {};
  const stageDir = path.join(WECHAT_RUNTIME_DIR, "..", ".worker-build");
  for (const def of PHYSICS_ENGINES) {
    const prebuilt = path.join(WECHAT_RUNTIME_DIR, def.out);
    if (!fs.existsSync(prebuilt)) {
      console.warn(`[wechat-worker] 缺少 ${path.relative(ROOT, prebuilt)}，跳过 ${def.key} worker bundle`);
      continue;
    }
    const gluePath = stageGlueAsCjs(def, stageDir);
    const outfile = path.join(WECHAT_RUNTIME_DIR, "workers", def.key, "tve.js");
    fs.mkdirSync(path.dirname(outfile), { recursive: true });
    await esbuildBuild(
      cjsBundleOptions({
        entryPoints: [path.join(BRIDGE_DIR, "entries/wechat-worker.ts")],
        outfile,
        plugins: [workerResolvePlugin(), workerPhysicsPlugin(def.key, { [def.key]: gluePath })],
      }),
    );
    const key = `workers/${def.key}/tve.js`;
    const text = await fs.promises.readFile(outfile, "utf8");
    assertCjsOutput(text, key);
    if (text.includes("import.meta")) {
      throw new Error(`[wechat-worker] ${key} 存活 import.meta（cjs 输出非法）`);
    }
    sizes[def.key] = Buffer.byteLength(text);
  }
  fs.rmSync(stageDir, { recursive: true, force: true });
  return sizes;
}
