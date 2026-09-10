// 阴影系统冒烟测试（headless，无需 GPU）。
// 设计：阴影不设独立节点，**各灯自带阴影参数组**（Unity Shadows 语义）：
//   点光（立方体阴影贴图）/ 平行光（正交，相机按场景包围盒后推贴合）/
//   聚光灯（透视，远平面按场景贴合）。覆盖五段：
// ① 数据层：三种灯光节点的 castShadow / shadow 配置（默认值、收敛、序列化往返、旧场景兼容）；
// ② 渲染建出：three 灯光对象 castShadow / 贴图分辨率（点光 1024、其余 2048）/
//    浓度与偏移写入 shadow；基元网格默认投射 + 接收阴影；
// ③ 阴影相机贴合：平行光正交范围含整场景（8 角点验证）、聚光灯/点光远平面、
//    用户 Near Plane / Normal Bias / Strength / Bias 生效；
// ④ 组件模式：灯光组件的阴影参数同样落到 three 灯光上；
// ⑤ 未开阴影的灯光不配置阴影贴图。
// 跑法（同其余冒烟）：
//   npx vite build --ssr scripts/smoke-shadow.ts --outDir .tmp-smoke --emptyOutDir
//   node .tmp-smoke/smoke-shadow.js

import * as THREE from "three";
import { Node } from "../src/framework/prototype/Node";
import { MeshNode } from "../src/framework/prototype/nodes/MeshNode";
import { DirectionalLightNode } from "../src/framework/prototype/nodes/DirectionalLightNode";
import { PointLightNode } from "../src/framework/prototype/nodes/PointLightNode";
import { SpotLightNode } from "../src/framework/prototype/nodes/SpotLightNode";
import { createDefaultRegistry } from "../src/framework/prototype/PrototypeRegistry";
import {
  DEFAULT_LIGHT_SHADOW,
  LIGHT_SHADOW_TYPE_HARD_RADIUS,
  LIGHT_SHADOW_TYPE_SOFT_RADIUS,
  SHADOW_MAP_SIZE_CUBE,
  SHADOW_MAP_SIZE_PLANE,
  applyLightShadowType,
  lightShadowTypeOf,
  parseLightShadow,
} from "../src/framework/lighting/shadow";
import { SceneSynchronizer } from "../src/framework/engine/modules/SceneSynchronizer";
import type { GraphLike, SceneChange } from "../src/framework/scene/SceneClient";
import type { Node } from "../src/framework/prototype/Node";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function approx(a: number, b: number, eps = 1e-3): boolean {
  return Math.abs(a - b) <= eps;
}

/** 最小 GraphLike（同步器只用到 get/all） */
function fakeGraph(nodes: Node[]): GraphLike {
  const map = new Map(nodes.map((n) => [n.id, n]));
  return { get: (id: string) => map.get(id), all: () => [...nodes] };
}

/** 取节点在渲染场景里的根对象 */
function objOf(sync: SceneSynchronizer, node: Node): THREE.Object3D {
  const obj = sync.getObjectMap().get(node.id);
  if (!obj) throw new Error(`未映射到 three 对象: ${node.id}`);
  return obj;
}

/** 在子树里找第一盏符合条件的灯光 */
function findLight<T extends THREE.Light>(root: THREE.Object3D, pred: (l: THREE.Light) => boolean): T | null {
  let hit: THREE.Light | null = null;
  root.traverse((o) => {
    const l = o as THREE.Light;
    if (!hit && l.isLight === true && pred(l)) hit = l;
  });
  return hit as T | null;
}

// ---------- ① 数据层 ----------
{
  const p = new PointLightNode();
  const d = new DirectionalLightNode();
  const s = new SpotLightNode();
  check(
    "三种灯光默认 castShadow=false 且带默认阴影配置",
    p.castShadow === false && d.castShadow === false && s.castShadow === false &&
      p.shadow.strength === DEFAULT_LIGHT_SHADOW.strength &&
      d.shadow.bias === DEFAULT_LIGHT_SHADOW.bias &&
      s.shadow.near === DEFAULT_LIGHT_SHADOW.near,
  );
  check(
    "配置收敛：strength>1 → 1、bias 越界钳到 [-0.05,0]、near 下限 0.01、radius 钳到 [1,5]",
    parseLightShadow({ strength: 5, bias: -9, near: -3 }).strength === 1 &&
      parseLightShadow({ bias: -9 }).bias === -0.05 &&
      parseLightShadow({ near: -3 }).near === 0.01 &&
      parseLightShadow({ radius: 99 }).radius === 5 &&
      parseLightShadow({ radius: 0 }).radius === 1,
  );
  check(
    "Shadow 类型推导：关→off / radius≥2→soft / radius<2→hard",
    lightShadowTypeOf(false, { ...DEFAULT_LIGHT_SHADOW }) === "off" &&
      lightShadowTypeOf(true, { ...DEFAULT_LIGHT_SHADOW, radius: 4 }) === "soft" &&
      lightShadowTypeOf(true, { ...DEFAULT_LIGHT_SHADOW, radius: 1 }) === "hard",
  );
  check(
    "Shadow 类型写回：hard→radius 1 / soft→radius 4 / off 只关投影不动 radius",
    applyLightShadowType(DEFAULT_LIGHT_SHADOW, "hard").radius === LIGHT_SHADOW_TYPE_HARD_RADIUS &&
      applyLightShadowType(DEFAULT_LIGHT_SHADOW, "soft").radius === LIGHT_SHADOW_TYPE_SOFT_RADIUS &&
      applyLightShadowType(DEFAULT_LIGHT_SHADOW, "off").castShadow === false &&
      applyLightShadowType(DEFAULT_LIGHT_SHADOW, "off").radius === DEFAULT_LIGHT_SHADOW.radius,
  );

  // 序列化往返（含阴影配置）
  const registry = createDefaultRegistry();
  const src = new PointLightNode({ castShadow: true });
  src.shadow = { strength: 0.6, bias: -0.002, normalBias: 0.03, near: 0.4 };
  const back = registry.createFromJSON(src.toJSON() as Record<string, unknown>) as PointLightNode;
  check(
    "点光序列化往返（castShadow + 阴影参数）",
    back instanceof PointLightNode &&
      back.castShadow === true &&
      approx(back.shadow.strength, 0.6) &&
      approx(back.shadow.bias, -0.002) &&
      approx(back.shadow.normalBias, 0.03) &&
      approx(back.shadow.near, 0.4),
    JSON.stringify(back.shadow),
  );

  const dSrc = new DirectionalLightNode({ castShadow: true });
  dSrc.shadow = { strength: 0.5, bias: -0.001, normalBias: 0, near: 0.2 };
  const dBack = registry.createFromJSON(dSrc.toJSON() as Record<string, unknown>) as DirectionalLightNode;
  check(
    "平行光序列化往返",
    dBack instanceof DirectionalLightNode && dBack.castShadow && approx(dBack.shadow.strength, 0.5),
  );

  // 旧场景兼容：无 castShadow/shadow 字段 → 默认关 + 默认配置
  const legacy = registry.createFromJSON({ type: "pointLightNode", id: "l1", name: "L" }) as PointLightNode;
  check(
    "旧场景数据兼容（无阴影字段回默认）",
    legacy instanceof PointLightNode && legacy.castShadow === false && legacy.shadow.strength === 1,
  );

  // 克隆带阴影配置
  const cloned = src.clone();
  check(
    "克隆携带 castShadow 与阴影配置",
    cloned.castShadow === true && cloned.shadow !== src.shadow && approx(cloned.shadow.strength, 0.6),
  );
}

// ---------- ② 渲染建出 ----------
{
  const scene = new THREE.Scene();
  const sync = new SceneSynchronizer(scene);
  const p = new PointLightNode({ castShadow: true });
  p.shadow = { strength: 0.7, bias: -0.001, normalBias: 0, near: 0.2 };
  const d = new DirectionalLightNode({ castShadow: true });
  const s = new SpotLightNode({ castShadow: true });
  const box = new MeshNode({ geometry: "box", size: { x: 4, y: 4, z: 4 } });
  const graph = fakeGraph([p, d, s, box]);
  sync.rebuildAll(graph);

  const pl = findLight<THREE.PointLight>(objOf(sync, p), (l) => l.isPointLight === true);
  check("点光节点 → THREE.PointLight 且 castShadow=true", !!pl && pl.castShadow === true);
  check(
    `点光阴影贴图 ${SHADOW_MAP_SIZE_CUBE}（立方体贴图降档）`,
    !!pl && pl.shadow.mapSize.width === SHADOW_MAP_SIZE_CUBE,
    pl ? String(pl.shadow.mapSize.width) : "",
  );
  check(
    "浓度/Bias/软化半径写入 shadow（intensity/bias/radius）",
    !!pl && approx(pl.shadow.intensity, 0.7) && approx(pl.shadow.bias, -0.001) && pl.shadow.radius === 4,
  );
  check("点光阴影相机 near = 用户 Near Plane", !!pl && approx(pl.shadow.camera.near, 0.2));

  const dl = findLight<THREE.DirectionalLight>(objOf(sync, d), (l) => l.isDirectionalLight === true);
  const sl = findLight<THREE.SpotLight>(objOf(sync, s), (l) => l.isSpotLight === true);
  check(
    `平行光/聚光灯阴影贴图 ${SHADOW_MAP_SIZE_PLANE}`,
    !!dl && dl.shadow.mapSize.width === SHADOW_MAP_SIZE_PLANE &&
      !!sl && sl.shadow.mapSize.width === SHADOW_MAP_SIZE_PLANE,
  );
  check(
    "平行光/聚光灯默认浓度 1、默认 Bias",
    !!dl && approx(dl.shadow.intensity, 1) && approx(dl.shadow.bias, DEFAULT_LIGHT_SHADOW.bias) &&
      !!sl && approx(sl.shadow.intensity, 1),
  );
  check(
    "聚光灯 near = 用户默认 Near Plane",
    !!sl && approx(sl.shadow.camera.near, DEFAULT_LIGHT_SHADOW.near),
  );

  const boxObj = objOf(sync, box) as THREE.Mesh;
  check("基元网格默认投射 + 接收阴影", boxObj.castShadow === true && boxObj.receiveShadow === true);
}

// ---------- ③ 阴影相机贴合 ----------
{
  const scene = new THREE.Scene();
  const sync = new SceneSynchronizer(scene);
  const light = new DirectionalLightNode({ castShadow: true });
  light.transform.position = { x: 3, y: 4, z: 3 };
  light.transform.rotation = { x: 45, y: -45, z: 0 };
  const ground = new MeshNode({ geometry: "plane", size: { x: 60, y: 60, z: 1 } });
  ground.transform.rotation = { x: -90, y: 0, z: 0 };
  const box = new MeshNode({ geometry: "box", size: { x: 4, y: 4, z: 4 } });
  box.transform.position = { x: 12, y: 1, z: -8 };
  const graph = fakeGraph([light, ground, box]);
  sync.rebuildAll(graph);

  const dl = findLight<THREE.DirectionalLight>(objOf(sync, light), (l) => l.isDirectionalLight === true);
  check("平行光节点建出真实 DirectionalLight 且开启阴影", !!dl && dl.castShadow === true);
  if (dl) {
    sync.refitShadowCameras(true);
    check("法线偏移自动档（用户未设时 >0）", dl.shadow.normalBias > 0, String(dl.shadow.normalBias));
    const cam = dl.shadow.camera as THREE.OrthographicCamera;
    check("正交范围非退化（near>0 且 far>near）", cam.near > 0 && cam.far > cam.near);

    // 场景包围盒 8 角点必须全部落在阴影视锥内（按相机取向构造探针验证）
    scene.updateMatrixWorld(true);
    const box3 = new THREE.Box3();
    const tmp = new THREE.Box3();
    graph.all().forEach((n) => {
      const o = sync.getObjectMap().get(n.id);
      o?.traverse((m) => {
        const mesh = m as THREE.Mesh;
        const pos = mesh.geometry?.getAttribute?.("position");
        if (mesh.isMesh !== true || !pos || pos.count === 0) return;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        if (!mesh.geometry.boundingBox) return;
        tmp.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
        box3.union(tmp);
      });
    });
    const lightPos = new THREE.Vector3().setFromMatrixPosition(dl.matrixWorld);
    const targetPos = new THREE.Vector3().setFromMatrixPosition(dl.target.matrixWorld);
    // 探针必须是**相机**（Object3D.lookAt 是 +Z 朝向目标，相机/灯光才是 -Z）
    const probe = new THREE.PerspectiveCamera();
    probe.position.copy(lightPos);
    probe.lookAt(targetPos);
    probe.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(probe.matrixWorld).invert();
    const corners = [
      [box3.min.x, box3.min.y, box3.min.z],
      [box3.max.x, box3.min.y, box3.min.z],
      [box3.min.x, box3.max.y, box3.min.z],
      [box3.max.x, box3.max.y, box3.min.z],
      [box3.min.x, box3.min.y, box3.max.z],
      [box3.max.x, box3.min.y, box3.max.z],
      [box3.min.x, box3.max.y, box3.max.z],
      [box3.max.x, box3.max.y, box3.max.z],
    ];
    let inside = true;
    let worst = "";
    for (const c of corners) {
      const v = new THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(inv);
      const depth = -v.z; // 视空间 -Z 为前方
      if (
        Math.abs(v.x) > cam.right + 1e-3 ||
        Math.abs(v.y) > cam.top + 1e-3 ||
        depth < cam.near - 1e-3 ||
        depth > cam.far + 1e-3
      ) {
        inside = false;
        worst = `x=${v.x.toFixed(2)}/depth=${depth.toFixed(2)}（right=${cam.right.toFixed(2)} near=${cam.near.toFixed(2)} far=${cam.far.toFixed(2)}）`;
        break;
      }
    }
    check("整场景包围盒 8 角点全部落在阴影视锥内", inside, worst);

    // 用户 Near Plane：调大后正交 near 随之上移（裁掉过近物体的投影）。
    // 注意属性变更会整组重建灯光对象，断言要重新查找新的 three 灯光
    light.shadow = { ...light.shadow, near: 5 };
    sync.onGraphChange({ kind: "properties", nodeId: light.id } as SceneChange, graph);
    sync.refitShadowCameras(true);
    const dl2 = findLight<THREE.DirectionalLight>(objOf(sync, light), (l) => l.isDirectionalLight === true);
    check("重建后的灯光对象保留 castShadow 与新阴影配置", !!dl2 && dl2 !== dl && dl2.castShadow && approx(dl2.userData.shadowCfg.near, 5));
    const cam2 = dl2!.shadow.camera as THREE.OrthographicCamera;
    check(
      "Near Plane 生效（正交 near 抬高 ≥5）",
      cam2.near >= 5 - 1e-3,
      String(cam2.near),
    );
  }
}

// ---------- 点光远平面 + 用户 NormalBias/Strength ----------
{
  const scene = new THREE.Scene();
  const sync = new SceneSynchronizer(scene);
  const p = new PointLightNode({ castShadow: true });
  p.transform.position = { x: 0, y: 5, z: 0 };
  p.shadow = { strength: 1, bias: -0.0005, normalBias: 0.25, near: 0.3 };
  const box = new MeshNode({ geometry: "box", size: { x: 2, y: 2, z: 2 } });
  const graph = fakeGraph([p, box]);
  sync.rebuildAll(graph);
  const pl = findLight<THREE.PointLight>(objOf(sync, p), (l) => l.isPointLight === true);
  if (pl) {
    sync.refitShadowCameras(true);
    check(
      "用户 NormalBias 生效（不被自动档覆盖）",
      approx(pl.shadow.normalBias, 0.25),
      String(pl.shadow.normalBias),
    );
    check("点光远平面 ≥ 灯到物体距离（5+）", pl.shadow.camera.far >= 4.9, String(pl.shadow.camera.far));
    check("点光 near = 用户 Near Plane", approx(pl.shadow.camera.near, 0.3));
    check("浓度生效（intensity=1）", approx(pl.shadow.intensity, 1));
  } else {
    check("点光阴影相机贴合", false, "未找到 PointLight");
  }
}

// ---------- 聚光灯：远平面推够远 ----------
{
  const scene = new THREE.Scene();
  const sync = new SceneSynchronizer(scene);
  const spot = new SpotLightNode({ castShadow: true, distance: 0 });
  spot.transform.position = { x: 0, y: 6, z: 0 };
  const box = new MeshNode({ geometry: "box", size: { x: 2, y: 2, z: 2 } });
  sync.rebuildAll(fakeGraph([spot, box]));
  const sl = findLight<THREE.SpotLight>(objOf(sync, spot), (l) => l.isSpotLight === true);
  check("聚光灯节点建出真实 SpotLight 且开启阴影", !!sl && sl.castShadow === true);
  if (sl) {
    sync.refitShadowCameras(true);
    // three 的 SpotLightShadow 以 distance || camera.far 作远平面；distance=0 时用我们推的 far
    check(
      "distance=0 时远平面被推到场景之外（> 灯到物体距离）",
      sl.shadow.camera.far >= 5.9,
      String(sl.shadow.camera.far),
    );
  }
}

// ---------- ④ 组件模式：灯光组件阴影参数 ----------
{
  const scene = new THREE.Scene();
  const sync = new SceneSynchronizer(scene);
  const host = new Node({ name: "CompLightHost" });
  host.components = [
    {
      id: "comp1",
      type: "light",
      enabled: true,
      light: {
        kind: "point",
        lightColor: 0xffffff,
        intensity: 1,
        distance: 0,
        decay: 2,
        angle: 45,
        penumbra: 0.2,
        castShadow: true,
        shadowStrength: 0.4,
        shadowBias: -0.003,
        shadowNormalBias: 0.12,
        shadowNear: 0.5,
        shadowRadius: 1,
      },
    },
  ];
  const graph = fakeGraph([host]);
  sync.rebuildAll(graph);
  const pl = findLight<THREE.PointLight>(objOf(sync, host), (l) => l.isPointLight === true);
  check("组件模式点光建出且 castShadow=true", !!pl && pl.castShadow === true);
  check(
    "组件阴影参数落到 three 灯光（浓度/偏移/法线偏移/near/软化半径）",
    !!pl &&
      approx(pl.shadow.intensity, 0.4) &&
      approx(pl.shadow.bias, -0.003) &&
      approx(pl.shadow.normalBias, 0.12) &&
      approx(pl.shadow.camera.near, 0.5) &&
      pl.shadow.radius === 1,
    pl
      ? JSON.stringify({ i: pl.shadow.intensity, b: pl.shadow.bias, nb: pl.shadow.normalBias, n: pl.shadow.camera.near, r: pl.shadow.radius })
      : "",
  );
  check(
    "组件点光贴图降档 1024",
    !!pl && pl.shadow.mapSize.width === SHADOW_MAP_SIZE_CUBE,
  );
}

// ---------- ⑤ 未开阴影的灯光不配置贴图 ----------
{
  const scene = new THREE.Scene();
  const sync = new SceneSynchronizer(scene);
  const light = new DirectionalLightNode({ castShadow: false });
  const p = new PointLightNode({ castShadow: false });
  const box = new MeshNode({ geometry: "box" });
  sync.rebuildAll(fakeGraph([light, p, box]));
  const dl = findLight<THREE.DirectionalLight>(objOf(sync, light), (l) => l.isDirectionalLight === true);
  const pl = findLight<THREE.PointLight>(objOf(sync, p), (l) => l.isPointLight === true);
  check("未开阴影的平行光 castShadow=false", !!dl && dl.castShadow === false);
  check("未开阴影的点光 castShadow=false", !!pl && pl.castShadow === false);
  check(
    "未开阴影时不预置贴图分辨率（保持 three 默认 512）",
    !!dl && dl.shadow.mapSize.width === 512,
    dl ? String(dl.shadow.mapSize.width) : "",
  );
}

console.log(failed === 0 ? "\n阴影系统冒烟：全部通过" : `\n阴影系统冒烟：${failed} 项失败`);
if (failed > 0) process.exitCode = 1;
