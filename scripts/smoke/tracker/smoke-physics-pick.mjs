// ---------------------------------------------------------------------------
// 相机射线拾取「网页运行时」冒烟（Node 直接运行，不经打包）：
// 端到端复现「点击屏幕 → engine.input → CameraNode.screenToRay →
// engine.physics.castRay → engine.scene.find(nodeId)」完整链路（用户脚本视角）：
//   ① engine.physics.castRay 桥存在（曾缺失：engine-api 未转发 host.physics，
//      脚本调用即 TypeError，相机射线永远选不中碰撞体——回归点）；
//   ② 主线程模式 castRay 同步返回命中数组（nodeId/point/normal/distance）；
//   ③ maxDistance 截断与 excludeNodeIds 排除生效；
//   ④ CameraNode.screenToRay 经 host.camera 转发生效（脚本拿到世界射线）；
//   ⑤ engine.scene.find 按节点 id 命中（castRay 命中结果只携带 id；曾只能按
//      名字查导致脚本解析不到命中实体——回归点）；按名字查找不受影响（名字优先）；
//   ⑥ 用户脚本整链路：onPointerDown 点击 → 拾取脚本字段拿到命中实体 id。
// 相机反投影用简化映射（中心点击 = 竖直向下射线）：three Raycaster 反投影属
// player.mjs 薄层，本冒烟锁定的是 tve 桥接链路。
// 运行：pnpm smoke physics-pick
// ---------------------------------------------------------------------------
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createSuite, installDomShim, coreURL as core, engineURL as engineMod } from "../harness.mjs";

const { ok, finish } = createSuite();

const root = resolve(import.meta.dirname, "..", "..", "..");

// 最小 DOM 垫片（tve/scripts → three/log 模块导入期访问 window/document；
// baseURI 供 scripts.mjs 文件模式寻址用户脚本模块）
installDomShim();
const tmpRoot = resolve(root, ".tmp-smoke/physics-pick");
rmSync(tmpRoot, { recursive: true, force: true });
mkdirSync(resolve(tmpRoot, "src"), { recursive: true });
globalThis.document.baseURI = pathToFileURL(tmpRoot + "/").href;

// 用户脚本模块（createScripts 按 src/**.ts 引用加载编译产物 src/**.js）。
// shim.mjs 以字面量 file URL 再导出 tve.mjs（node 无 import map，脚本内不能写
// 裸说明符 "tve"；同 URL 模块实例保证 instanceof 命中）。
const tveUrl = core("tve.mjs");
writeFileSync(
  resolve(tmpRoot, "shim.mjs"),
  `export { Component, engine, CameraNode } from ${JSON.stringify(tveUrl)};\n`,
);
writeFileSync(
  resolve(tmpRoot, "src/picker.js"),
  `import { Component, engine } from "../shim.mjs";
export const picks = [];
export default class Picker extends Component {
  camera = null;
  onStart() {
    this.camera = engine.scene.find("cam");
    engine.input.onPointerDown((p) => { void this.pick(p.x, p.y); });
  }
  async pick(screenX, screenY) {
    if (!this.camera) { picks.push({ error: "no-camera" }); return; }
    const ray = this.camera.screenToRay(screenX, screenY);
    if (!ray) { picks.push({ error: "no-ray" }); return; }
    const result = engine.physics.castRay({
      origin: ray.origin,
      direction: ray.direction,
      maxDistance: 100,
      excludeNodeIds: [this.entity.id],
    });
    const hits = Array.isArray(result) ? result : await result;
    if (hits.length === 0) { picks.push(null); return; }
    const target = engine.scene.find(hits[0].nodeId);
    picks.push({ hit: hits[0], targetId: target ? target.id : null });
  }
}
`,
);

const { createPhysics } = await import(engineMod("runtime/physics.mjs"));
const THREE = await import(core("three.module.min.js"));
const { createScripts } = await import(core("scripts.mjs"));
const tv = await import(tveUrl);

// —— 场景：根节点 + 相机（俯视原点）+ 地面（隐式静态盒碰撞体）+ 拾取脚本宿主节点 ——
function nodeObj(name, id, kind) {
  const obj = new THREE.Object3D();
  obj.name = name;
  obj.userData = { nodeId: id, nodeKind: kind };
  obj.updateWorldMatrix(true, false);
  return obj;
}
const rootObj = nodeObj("Root", "n_root", "node");
const camObj = nodeObj("cam", "n_cam", "cameraNode");
camObj.position.set(0, 10, 0);
const groundObj = nodeObj("Ground", "n_ground", "meshNode");
const pickerObj = nodeObj("Picker", "n_picker", "node");
rootObj.add(camObj, groundObj, pickerObj);

const nodes = [
  {
    json: { id: "n_root", type: "node", name: "Root", components: [] },
    obj: rootObj,
  },
  {
    json: { id: "n_cam", type: "cameraNode", name: "cam", components: [] },
    obj: camObj,
  },
  {
    json: {
      id: "n_ground", type: "meshNode", name: "Ground",
      components: [
        { type: "collider", enabled: true, collider: { shape: "box", autoSize: false, size: { x: 10, y: 1, z: 10 } } },
      ],
    },
    obj: groundObj,
  },
  {
    json: {
      id: "n_picker", type: "node", name: "Picker",
      components: [{ type: "script", enabled: true, script: "src/picker.ts" }],
    },
    obj: pickerObj,
  },
];

const physicsApi = await createPhysics({
  nodes,
  settings: { physicsEnabled: true, backend: "rapier", gravity: { x: 0, y: -9.81, z: 0 } },
});
ok(physicsApi.bodyInfo("n_ground") != null, "物理世界就绪（noop 回退时 bodyInfo 为 null）");

// 画布 800×600；screenToRay 用简化映射：ndcX = x/400-1，方向 = (ndcX, -1, 0) 归一化
// （中心点击 = 竖直向下），origin 固定相机位 (0,10,0)——three Raycaster 反投影为
// player.mjs 薄层，此处锁定桥接链路
const listeners = {};
const fakeCanvas = {
  addEventListener(type, fn) { listeners[type] = fn; },
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
};
const cameraHost = {
  screenToRay(screenX, screenY) {
    const ndcX = (screenX / 400) - 1;
    const len = Math.hypot(ndcX, 1);
    return { origin: { x: 0, y: 10, z: 0 }, direction: { x: ndcX / len, y: -1 / len, z: 0 } };
  },
};

await createScripts({
  nodes, cfg: {}, animations: null, audios: null, physics: physicsApi,
  clipAnims: null, particles: null, terrains: null, ui: null, logic: null,
  canvas: fakeCanvas, camera: cameraHost,
});

// ① castRay 桥存在（曾缺失 → 脚本调用 TypeError）
ok(typeof tv.engine.physics.castRay === "function", "engine.physics.castRay 桥存在");

// ② 主线程模式同步返回命中数组（地面盒顶面 y=0.5，距离 ≈ 9.5）
const hits = tv.engine.physics.castRay({
  origin: { x: 0, y: 10, z: 0 }, direction: { x: 0, y: -1, z: 0 },
});
ok(Array.isArray(hits) && hits.length === 1, `castRay 命中地面（${Array.isArray(hits) ? hits.length : typeof hits}）`);
ok(hits[0]?.nodeId === "n_ground", `命中 nodeId = n_ground（实际 ${hits[0]?.nodeId}）`);
ok(Math.abs(hits[0]?.distance - 9.5) < 0.01, `距离 ≈ 9.5m（实际 ${hits[0]?.distance?.toFixed(3)}）`);
ok(Math.abs(hits[0]?.point.y - 0.5) < 0.01, `命中点在盒顶面（y=${hits[0]?.point?.y?.toFixed(3)}）`);
ok(Math.abs(Math.abs(hits[0]?.normal.y) - 1) < 0.01, `法线朝上（|ny|=${Math.abs(hits[0]?.normal?.y ?? 0)?.toFixed(3)}）`);

// ③ maxDistance 截断 / excludeNodeIds 排除
const tooFar = tv.engine.physics.castRay({
  origin: { x: 0, y: 10, z: 0 }, direction: { x: 0, y: -1, z: 0 }, maxDistance: 5,
});
ok(tooFar.length === 0, "maxDistance 截断后未命中");
const excluded = tv.engine.physics.castRay({
  origin: { x: 0, y: 10, z: 0 }, direction: { x: 0, y: -1, z: 0 }, excludeNodeIds: ["n_ground"],
});
ok(excluded.length === 0, "excludeNodeIds 排除命中体后未命中");

// ⑤ scene.find：id 回退命中 + 名字优先不受影响
const byId = tv.engine.scene.find("n_ground");
ok(byId?.id === "n_ground" && byId?.name === "Ground", `scene.find(nodeId) 命中实体（name=${byId?.name}）`);
const byName = tv.engine.scene.find("Ground");
ok(byName?.id === "n_ground", "scene.find(名称) 不受 id 回退影响");
const camEntity = tv.engine.scene.find("cam");
ok(camEntity?.id === "n_cam" && typeof camEntity.screenToRay === "function", "相机实体为 CameraNode（含 screenToRay）");

// ⑥ 整链路：脚本 onStart 已注册监听；点击画布中心拾取，点击远侧落空
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
ok(typeof listeners.pointerdown === "function", "脚本 onStart 已注册 pointerdown 监听");
listeners.pointerdown({ pointerId: 1, clientX: 400, clientY: 300 });
listeners.pointerdown({ pointerId: 1, clientX: 788, clientY: 300 }); // ndcX=0.97 → 侧面落空
await sleep(30);
const { picks } = await import(pathToFileURL(resolve(tmpRoot, "src/picker.js")).href);
ok(picks.length === 2, `两次点击都完成拾取流程（实际 ${picks.length} 条）`);
ok(picks[0]?.targetId === "n_ground", `中心点击拾取到地面实体（targetId=${picks[0]?.targetId}）`);
ok(picks[0]?.hit != null && Math.abs(picks[0].hit.distance - 9.5) < 0.01, "脚本拿到的命中距离一致");
ok(picks[1] === null, "画面远侧点击未命中（返回空）");

rmSync(tmpRoot, { recursive: true, force: true });
finish();
