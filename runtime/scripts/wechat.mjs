// 微信小游戏运行时 bundle 构建（产物不入库，public/engine 同一 doctrine）。
//
// 产线形态（public/exports/wechat/runtime/）：
//   code.js                                   单文件 CJS bundle（adapter+player+engine+three，压缩）
//   engine/core/tve.js                        tve 门面（转发 code.js 的 __tveFacade）
//   engine/runtime/physics-engines/rapier.js/.wasm   rapier 胶水 + 包内 wasm（按项目后端随包）
//   engine/runtime/physics-engines/jolt.js/.wasm     jolt 同上
//   engine/runtime/physics-engines/ammo/ammo-esm.js/.wasm  ammo 同上
//   engine/runtime/loaders/meshopt_decoder.wasm      meshopt（GLTFLoader 内联依赖）
//   engine/runtime/loaders/draco/draco_decoder.js    Draco 纯 JS 解码器（主线程内联解码）
//
// 关键决策（与 web 渠道隔离）：
// - 引擎源码 src/runtime/** 零改动；对本包内三处运行时形态做构建期定点改写
//   （锚点断言命中次数，失配即构建失败），改写实现见 ./wechat/transforms.mjs：
//   scripts.mjs 动态 import → __tveLoadModule、player.mjs import.meta.url 合法化 +
//   WebGPU 分支改写、physics.mjs 引擎动态 import 改写（微信产物禁止变量/外部
//   动态 import）。
// - 物理引擎 wasm 以包内 .wasm 文件随包：基础库 WXWebAssembly.instantiate 只认
//   代码包内路径（wxfile: 用户目录与字节直传均被拒）。web 渠道的 wasm 文件化
//   （runtime/scripts/wasm-fileize.mjs）已把 public/engine 胶水统一改写为桥接钩子
//   __tveInstantiateWasmFile(path, imports) 直连 + 内嵌字节串剥除，本构建只做 cjs
//   形态转换（./wechat/engines.mjs：jolt 剥 node 分支；ammo 胶水改真模块 + 入口
//   工厂直取），.wasm 直接取产物同目录文件；meshopt 仍在本构建内定点改写
//   （./wechat/meshopt.mjs；web 产物保留内联形态）。
// - 多入口代码拆分（rollup）被刻意避开：tve 门面以 5 行静态文件转发主 bundle
//   导出，包内少一组 chunk、少一类注册表变数。
// - 守卫：surface 漂移守卫 + bridge 契约测试 + bundle 冒烟，见 ./wechat/guards.mjs
//   （前两者另有独立 npm script：check:surface / test:bridge）。
//
// 用法：node runtime/scripts/wechat.mjs（package.json build 链与 vite 插件挂载）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cjsBundleOptions, esbuildBuild } from "./lib/esbuild.mjs";
import { assertCjsOutput } from "./lib/anchor.mjs";
import { BRIDGE_DIR, WECHAT_RUNTIME_DIR } from "./lib/paths.mjs";
import { wechatTransformPlugin } from "./wechat/transforms.mjs";
import { buildPhysicsEngines } from "./wechat/engines.mjs";
import { buildWorkerBundles } from "./wechat/worker.mjs";
import { copyDracoJsDecoder } from "./wechat/draco.mjs";
import { runSurfaceCheck, runBridgeSpec, smokeRequireBundle, runDracoDecodeSmoke, runWorkerSmoke, writeTveFacade } from "./wechat/guards.mjs";
import { MESHOPT_WASM_PATH } from "../bridge/protocol.ts";

/** 产物体积上限告警阈值（微信主包 4MB，data.js 由导出期另计） */
const BUNDLE_WARN_BYTES = 3 * 1024 * 1024;

async function buildMainBundle() {
  const outfile = path.join(WECHAT_RUNTIME_DIR, "code.js");
  const wasmOut = [];
  await esbuildBuild(
    cjsBundleOptions({
      entryPoints: [path.join(BRIDGE_DIR, "entries/wechat.ts")],
      outfile,
      plugins: [wechatTransformPlugin(wasmOut)],
    }),
  );
  // meshopt 的 wasm 随包（loaders 组；GLTFLoader meshopt 压缩模型依赖）
  if (wasmOut.length) {
    const wasmPath = path.join(WECHAT_RUNTIME_DIR, MESHOPT_WASM_PATH);
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

export async function buildWechatRuntime(reason = "") {
  fs.rmSync(WECHAT_RUNTIME_DIR, { recursive: true, force: true });
  fs.mkdirSync(WECHAT_RUNTIME_DIR, { recursive: true });
  const label = reason ? `（${reason}）` : "";
  const main = await buildMainBundle();
  const engines = await buildPhysicsEngines();
  const workers = await buildWorkerBundles();
  const dracoBytes = copyDracoJsDecoder();
  const facadeBytes = writeTveFacade();
  runSurfaceCheck();
  runBridgeSpec();
  smokeRequireBundle(engines);
  runDracoDecodeSmoke(dracoBytes);
  for (const backend of Object.keys(workers)) runWorkerSmoke(backend);
  const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
  const engineSummary = Object.entries(engines)
    .map(([key, bytes]) => `${key} ${kb(bytes)}`)
    .join(" + ");
  const workerSummary = Object.entries(workers)
    .map(([key, bytes]) => `${key} ${kb(bytes)}`)
    .join(" + ");
  console.log(
    `[wechat-bundle] 构建完成${label}: code.js ${kb(main.code)} + tve.js ${kb(facadeBytes)}` +
      (dracoBytes ? ` + draco_decoder.js ${kb(dracoBytes)}（主线程内联解码）` : "") +
      (engineSummary ? ` + ${engineSummary}` : "") +
      (workerSummary ? ` + worker[${workerSummary}]` : "") +
      ` → public/exports/wechat/runtime/`,
  );
  return { codeBytes: main.code, engines, workers, facadeBytes, dracoBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildWechatRuntime().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
