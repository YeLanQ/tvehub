// ---------------------------------------------------------------------------
// @priority P0
// 阴影「网页运行时」冒烟（Node 直接运行，不经打包）：
// 用导出的 scene.json 片段喂给 public/engine/runtime 的场景树/网格构建链路，验证
//   ① meshNode（基元/toon）默认投射 + 接收阴影（材质轮廓体除外）；
//   ② 三种可投影灯光节点的 castShadow 与阴影参数组落到 three 灯光上
//     （点光立方体贴图降档 1024、平行光/聚光灯 4096、浓度/偏移/近裁剪面）；
//   ③ 灯光组件（扁平字段）同语义；
//   ④ 舞台渲染器开启阴影贴图并使用 PCF 软阴影。
// 运行：pnpm smoke shadow-runtime
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSuite, runtimeURL as runtime, coreURL as core } from "../harness.mjs";

const { ok, finish, approx } = createSuite();

const root = resolve(import.meta.dirname, "..", "..", "..");

const { buildSceneTree } = await import(runtime("nodes.mjs"));
const { createMesh } = await import(runtime("mesh.mjs"));
const { buildComponentLight } = await import(core("lights.mjs"));
const THREE = await import(core("three.module.min.js"));

console.log("[1] meshNode 默认投射 + 接收阴影");
const scene = new THREE.Scene();
const sceneJson = {
  type: "node",
  id: "root",
  name: "Root",
  children: [
    {
      type: "meshNode",
      id: "m1",
      name: "Box",
      geometry: "box",
      size: { x: 2, y: 2, z: 2 },
      transform: { position: { x: 0, y: 3, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    },
  ],
};
const built = buildSceneTree(sceneJson, scene, { materialParams: new Map(), models: new Map() });
const nodeOf = (id) => built.nodes.find((n) => n.json.id === id)?.obj ?? null;
const box = nodeOf("m1");
ok(box?.castShadow === true && box?.receiveShadow === true, "基元网格投射 + 接收阴影");
// toon 轮廓体（沿法线外扩的背面壳）不参与投影
const toonMesh = createMesh(
  { type: "meshNode", geometry: "sphere", size: { x: 1, y: 1, z: 1 }, material: "assets/materials/Toon.mat" },
  { materialParams: new Map([["assets/materials/Toon.mat", { type: "toon", outlineEnabled: true, outlineWidth: 0.02, outlineColor: 0x000000, color: 0xffffff, opacity: 1, toonSteps: 3, toonShadowStrength: 0.1 }]]), models: new Map() },
);
let outline = null;
toonMesh.traverse((o) => {
  if (o.name === "__matOutline") outline = o;
});
ok(!!outline, "toon 轮廓体已建出");
ok(outline?.castShadow === false && outline?.receiveShadow === false, "轮廓体不投影/不受影");
ok(toonMesh.castShadow === true && toonMesh.receiveShadow === true, "toon 主网格投射 + 接收阴影");

console.log("[2] 灯光节点的阴影开关与阴影参数组");
const lightScene = new THREE.Scene();
const lightJson = {
  type: "node",
  id: "root2",
  children: [
    {
      type: "pointLightNode",
      id: "pl",
      castShadow: true,
      shadow: { strength: 0.6, bias: -0.002, normalBias: 0.03, near: 0.4 },
    },
    { type: "directionalLightNode", id: "dl", castShadow: true },
    { type: "spotLightNode", id: "sl", castShadow: false },
  ],
};
const lightBuilt = buildSceneTree(lightJson, lightScene, { materialParams: new Map(), models: new Map() });
const lightObjOf = (id) => {
  let hit = null;
  lightScene.traverse((o) => {
    if (!hit && o.userData?.nodeId === id) {
      o.traverse((c) => {
        if (!hit && c.isLight) hit = c;
      });
    }
  });
  return hit;
};
const pl = lightObjOf("pl");
ok(pl?.isPointLight === true && pl?.castShadow === true, "点光 castShadow 落到 three 灯光");
ok(pl?.shadow?.mapSize?.width === 1024, `点光立方体贴图降档 1024（实际 ${pl?.shadow?.mapSize?.width}）`);
ok(
  approx(pl?.shadow?.intensity ?? -1, 0.6) && approx(pl?.shadow?.bias ?? 0, -0.002) &&
    approx(pl?.shadow?.normalBias ?? 0, 0.03) && approx(pl?.shadow?.camera?.near ?? 0, 0.4),
  "点光阴影参数组（浓度/偏移/法线偏移/近裁剪面）生效",
);
ok(pl?.position?.z === 0 && pl?.position?.y === 0, "点光位置在节点原点");
const dl = lightObjOf("dl");
ok(dl?.isDirectionalLight === true && dl?.castShadow === true, "平行光 castShadow 落到 three 灯光");
ok(dl?.shadow?.mapSize?.width === 4096, `平行光贴图 4096（实际 ${dl?.shadow?.mapSize?.width}）`);
ok(dl?.position?.x === 0 && dl?.position?.y === 0 && dl?.position?.z === 0,
  "平行光位置归零（three 默认 (0,1,0) 会让方向偏离节点 -Z 语义）");
const sl = lightObjOf("sl");
ok(sl?.isSpotLight === true && sl?.castShadow === false, "未开阴影的聚光灯 castShadow=false");
ok(sl?.shadow?.mapSize?.width === 512, "未开阴影时不预置贴图分辨率（three 默认 512）");

console.log("[3] 灯光组件（扁平字段）同语义");
{
  const host = new THREE.Group();
  buildComponentLight(
    {
      kind: "point",
      lightColor: 0xffffff,
      intensity: 1,
      distance: 0,
      decay: 2,
      castShadow: true,
      shadowStrength: 0.4,
      shadowBias: -0.003,
      shadowNormalBias: 0.12,
      shadowNear: 0.7, // 故意避开 three 的 PointLight 默认 near(0.5)，验证真的写进去了
    },
    host,
  );
  let pl2 = null;
  host.traverse((o) => {
    if (!pl2 && o.isLight) pl2 = o;
  });
  ok(pl2?.castShadow === true, "组件点光 castShadow=true");
  ok(
    approx(pl2?.shadow?.intensity ?? -1, 0.4) && approx(pl2?.shadow?.bias ?? 0, -0.003) &&
      approx(pl2?.shadow?.normalBias ?? 0, 0.12) && approx(pl2?.shadow?.camera?.near ?? 0, 0.7),
    "组件阴影参数（浓度/偏移/法线偏移/近裁剪面）生效",
  );
  ok(pl2?.shadow?.mapSize?.width === 1024, "组件点光贴图降档 1024");
}

console.log("[4] 舞台渲染器的阴影开关与采样方式");
const stageSrc = readFileSync(resolve(root, "public/engine/runtime/stage.mjs"), "utf8");
ok(/renderer\.shadowMap\.enabled\s*=\s*true/.test(stageSrc), "shadowMap.enabled = true");
ok(/shadowMap\.type\s*=\s*THREE\.PCFShadowMap/.test(stageSrc), "shadowMap.type = PCFShadowMap（每灯 radius 才生效）");

finish();
