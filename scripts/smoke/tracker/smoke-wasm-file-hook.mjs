// ---------------------------------------------------------------------------
// @priority P0
// wasm 文件化装载链冒烟（Node 直接运行）：复现「单页/内联产物 + 资产 fetch 垫片」
// 形态下物理引擎经全局钩子加载 .wasm 的完整链路——曾回归：钩子把 URL 对象传给
// fetch，垫片只识别 string/Request 入参而放行原生 fetch（file:// 下 CORS 拒绝、
// http 单页下 404），wasm 加载全挂。
//   ① 资产垫片对 string 与 URL 两种入参都能命中内联表；
//   ② 真实 rapier 胶水（public/engine 产物）经钩子 + 垫片完成 init 并可建世界
//      步进——垫片外的任何 fetch（原生 file:// / 404）即失败，链路无旁路。
// 运行：pnpm smoke wasm-file-hook
// ---------------------------------------------------------------------------
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, createSuite, installDomShim } from "../harness.mjs";

const { ok, finish } = createSuite();

installDomShim();
// 主线程 + 页面根形态（单页产物双击 file:// 打开即此形态）
globalThis.location = new URL(pathToFileURL(join(ROOT, "build/web/index.html")).href);

// 内联资产表 = 单页产物 window.__TVE_BUILD_DATA.assets 的运行期形态
const wasmBytes = await readFile(join(ROOT, "public/engine/runtime/physics-engines/rapier.wasm"));
const nativeFetchCalls = [];
globalThis.fetch = async (input) => {
  nativeFetchCalls.push(String(input?.href ?? input));
  throw new TypeError("Failed to fetch (native)");
};

const { installAssetShim } = await import(
  pathToFileURL(join(ROOT, "public/engine/runtime/pak.mjs")).href
);
installAssetShim(new Map([["engine/runtime/physics-engines/rapier.wasm", wasmBytes]]));

// [1] 垫片入参形态：string 与 URL 对象都要命中（钩子历史回归点）
{
  const viaString = await fetch("engine/runtime/physics-engines/rapier.wasm");
  ok(viaString.ok && (await viaString.arrayBuffer()).byteLength === wasmBytes.length, "垫片命中 string 入参");
  const viaUrl = await fetch(new URL("engine/runtime/physics-engines/rapier.wasm", location.href));
  ok(viaUrl.ok && (await viaUrl.arrayBuffer()).byteLength === wasmBytes.length, "垫片命中 URL 对象入参");
  ok(nativeFetchCalls.length === 0, "两次命中都未穿透到原生 fetch");
}

// [2] 真实胶水端到端：rapier.mjs（钩子化产物）init → 建世界 → 步进
{
  const { installWasmFileHook } = await import(
    pathToFileURL(join(ROOT, "src/framework/physics/wasm-file-hook.ts")).href
  );
  installWasmFileHook();
  const R = (await import(pathToFileURL(join(ROOT, "public/engine/runtime/physics-engines/rapier.mjs")).href)).default;
  await R.init();
  ok(nativeFetchCalls.length === 0, `wasm 全程经垫片供数（原生 fetch 调用 ${nativeFetchCalls.length} 次）`);
  const world = new R.World({ x: 0, y: -9.81, z: 0 });
  const body = world.createRigidBody(
    R.RigidBodyDesc.dynamic().setTranslation(0, 1, 0),
  );
  world.createCollider(R.ColliderDesc.ball(0.5), body);
  for (let i = 0; i < 30; i++) world.step();
  const y = body.translation().y;
  ok(y < 0.9, `动力学体经步进下落（y=${y.toFixed(3)} < 0.9）`);
  world.free();
}

finish();
