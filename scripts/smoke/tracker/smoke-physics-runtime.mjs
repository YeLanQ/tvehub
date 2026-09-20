// ---------------------------------------------------------------------------
// 物理系统「网页运行时」冒烟（Node 直接运行，不经打包）：
// 验证 public/engine/runtime/physics.mjs 三后端（rapier/jolt/ammo）的重力缩放：
//   ① 缩放 0：动力学体不受重力（原位悬浮）；
//   ② 缩放 1：正常下落；
//   ③ 运行时 setGravityScale(0 → 1 → 0)：下落/悬浮随切换（睡眠体改系数需唤醒）；
//   ④ setGravity 换世界重力后：缩放体按新重力 × 各自缩放下落（ammo 的
//      world.setGravity 会重置逐体重力，缩放体必须重铺——回归点）。
// 同一世界内的体横向错开（重叠体会被接触冲量扰乱自由落体）；
// postLog 拦截暴露物理引擎加载失败（失败会静默回退 noop API）。
// ammo glue 的 Node 环境分支用 require/__dirname 取 wasm（浏览器走 web 分支
// 无此依赖）：冒烟经 wasmBinary 内联加载，补这两个全局让分支可求值。
// 运行：pnpm smoke physics-runtime
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
import { createSuite, installDomShim, runtimeURL as runtime, coreURL as core } from "../harness.mjs";

const { ok, finish } = createSuite();

// 最小 DOM 垫片（physics.mjs → three/log 模块导入期访问 window/document）
installDomShim();
// ammo glue Node 分支求值所需（仅冒烟环境；wasm 实际由 wasmBinary 注入）
globalThis.require ??= createRequire(import.meta.url);
globalThis.__dirname ??= "/";
// 拦截 postLog（预览页 → 编辑器的日志转发）以暴露静默失败
globalThis.window.parent = {
  postMessage(m) {
    if (m.level === "error") console.log(`  [preview] ${m.text}`);
  },
};

const { createPhysics } = await import(runtime("physics.mjs"));
const THREE = await import(core("three.module.min.js"));

const DT = 1 / 60;

/** 动力学球体节点（横向错开避免重叠接触扰乱自由落体） */
function ball(id, x, y, gravityScale) {
  const obj = new THREE.Object3D();
  obj.position.set(x, y, 0);
  obj.updateWorldMatrix(true, false);
  return {
    json: {
      id,
      components: [
        { type: "rigidBody", enabled: true, rigidBody: { mode: "dynamic", mass: 1, gravityScale } },
        { type: "collider", enabled: true, collider: { shape: "sphere", autoSize: false, size: { x: 1, y: 1, z: 1 }, friction: 0, restitution: 0 } },
      ],
    },
    obj,
  };
}

async function stepSeconds(api, seconds) {
  const n = Math.max(1, Math.round(seconds / DT));
  for (let i = 0; i < n; i++) api.update(DT);
}

for (const backend of ["rapier", "jolt", "ammo"]) {
  console.log(`\n[${backend}]`);

  // ① ② 缩放 0 悬浮 / 缩放 1 下落；③ 运行时切换
  const a = ball("a", -4, 5, 0);
  const b = ball("b", 4, 5, 1);
  const api = await createPhysics({
    nodes: [a, b],
    settings: { physicsEnabled: true, backend, gravity: { x: 0, y: -9.81, z: 0 } },
  });
  ok(api.bodyInfo("b") != null, "物理引擎就绪（bodyInfo 可用；noop 回退会为 null）");
  await stepSeconds(api, 1);
  const ya = a.obj.position.y, yb = b.obj.position.y;
  ok(Math.abs(ya - 5) < 0.05, `缩放 0 不受重力（y=${ya.toFixed(3)}，应 ≈5）`);
  ok(yb < 4, `缩放 1 正常下落（y=${yb.toFixed(3)}，应 <4）`);

  api.setGravityScale("a", 1);
  await stepSeconds(api, 0.5);
  ok(a.obj.position.y < ya - 0.1, `setGravityScale(0→1) 后开始下落（y=${a.obj.position.y.toFixed(3)}）`);
  // 缩放 0 只去掉重力加速度、不刹已有速度：清零速度后应稳定悬浮
  // （容差 0.3m = 位姿插值对清零前速度的一帧追赶；仍在坠落则为 ~1.2m）
  api.setGravityScale("a", 0);
  api.setLinearVelocity("a", 0, 0, 0);
  const yNow = a.obj.position.y;
  await stepSeconds(api, 0.5);
  ok(Math.abs(a.obj.position.y - yNow) < 0.3, `setGravityScale(→0) 后恢复悬浮（0.5s 漂移 ${Math.abs(a.obj.position.y - yNow).toFixed(3)}m）`);

  // ④ setGravity 换世界重力：缩放 0.5 与缩放 1 同场下落，缩放小的落得少
  const half = ball("half", -4, 5, 0.5);
  const full = ball("full", 4, 5, 1);
  const api2 = await createPhysics({
    nodes: [half, full],
    settings: { physicsEnabled: true, backend, gravity: { x: 0, y: -19.62, z: 0 } },
  });
  await stepSeconds(api2, 0.5);
  const yh = half.obj.position.y, yf = full.obj.position.y;
  ok(yh > yf, `缩放 0.5 落得比缩放 1 少（${yh.toFixed(3)} vs ${yf.toFixed(3)}）`);
  ok(yf < 3, `缩放 1 按新世界重力 -19.62 下落（y=${yf.toFixed(3)}，0.5s 应 <3）`);

  // ⑤ 高度场：terrainNode（隐式静态 heightfield 碰撞体，terrains 传烘焙网格）
  //    两级平台 x<0 高 1 / x≥0 高 3，两球分别落在两台上（校准 y 对齐与 x 方向性）
  const S = 64;
  const hfHeights = new Float32Array(S * S);
  for (let iz = 0; iz < S; iz++) {
    for (let ix = 0; ix < S; ix++) hfHeights[iz * S + ix] = ix < S / 2 ? 1 : 3;
  }
  const terrainObj = new THREE.Object3D();
  const terrainNode = {
    json: {
      id: "terrain", type: "terrainNode",
      components: [
        { type: "collider", enabled: true, collider: { shape: "heightfield", resolution: 64, friction: 0.6, restitution: 0 } },
      ],
    },
    obj: terrainObj,
  };
  const lowBall = ball("low", -2.5, 8, 1);
  const highBall = ball("high", 2.5, 8, 1);
  const apiHf = await createPhysics({
    nodes: [terrainNode, lowBall, highBall],
    terrains: [{ json: terrainNode.json, obj: terrainObj, data: { heights: hfHeights, gridSize: S, size: 10, segments: S - 1, minY: 1, maxY: 3 } }],
    settings: { physicsEnabled: true, backend, gravity: { x: 0, y: -9.81, z: 0 } },
  });
  await stepSeconds(apiHf, 3);
  const yLow = lowBall.obj.position.y, yHigh = highBall.obj.position.y;
  ok(yLow > 1.1 && yLow < 1.9, `高度场低台（x=-2.5）球停 y=${yLow.toFixed(3)}（期望 ≈1.5）`);
  ok(yHigh > 3.1 && yHigh < 3.9, `高度场高台（x=+2.5）球停 y=${yHigh.toFixed(3)}（期望 ≈3.5）`);
  ok(yHigh > yLow + 1, "高度场 x 方向正确（高台在 +x 侧）");

  // ⑥ 射线投射（三后端同一 API/返回结构）：对准球实时位置自上而下先命中球，
  //    排除后命中地形，射程截断后无命中。球心 y≈1.5（顶 ≈2.0），自 y=8 向下 ≈6.0
  const bx = lowBall.obj.position.x.toFixed(3), by = lowBall.obj.position.y, bz = lowBall.obj.position.z.toFixed(3);
  const down = { origin: { x: Number(bx), y: 8, z: Number(bz) }, direction: { x: 0, y: -1, z: 0 } };
  const rayHits = apiHf.castRay({ ...down, maxDistance: 100 });
  ok(rayHits.length > 0 && rayHits[0].nodeId === "low", `射线先命中 low 球（${rayHits[0]?.nodeId ?? "未命中"}，距离 ${rayHits[0]?.distance?.toFixed(2)}）`);
  ok(rayHits[0].distance > 5.5 && rayHits[0].distance < 6.5, `命中距离 ≈ 6.0（实际 ${rayHits[0].distance.toFixed(3)}）`);
  const terrainHits = apiHf.castRay({ ...down, maxDistance: 100, excludeNodeIds: ["low"] });
  ok(terrainHits.length > 0 && terrainHits[0].nodeId === "terrain", `排除球后命中地形（${terrainHits[0]?.nodeId ?? "未命中"}，距离 ${terrainHits[0]?.distance?.toFixed(2)}）`);
  const shortHits = apiHf.castRay({ ...down, maxDistance: 5 });
  ok(shortHits.length === 0, "射程 5m 内无命中（球顶 ≈6m）");
}

finish();
