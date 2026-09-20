// 层级与标签系统冒烟测试（headless，无需 GPU）。
// 设计：节点单选一层（0~31，内置层 0 = Default），
//   相机/灯光节点与灯光组件带 cullingMask 位掩码（默认 -1 = 全部层）。
//   渲染侧相机层裁剪是 three 原生的；灯光"只照亮所选层"经「相机掩码收窄时按
//   在用层拆 pass」实现（light.layers vs 相机层的收集判定天然完成过滤）。
// 覆盖五段：
// ① 数据层：层表解析/收敛/存档往返、cullingMask 收敛与标签收敛、节点 layer
//   序列化往返与旧场景兼容（无字段 = 层 0）；
// ② 相机/灯光节点：cullingMask 默认值、序列化往返、旧场景兼容；
// ③ 渲染建出：three 对象 layers 落位（根/描边壳/模型实例）、灯光对象 layers
//   与阴影相机层同步、灯光组件同语义、层变更刷新；
// ④ 分层多 pass：populatedLayerBits / layerPassBits 决策与 renderLayerPasses
//   的清屏/背景/相机层/天空面门控与恢复。
// 跑法（同其余冒烟）：
//   npx vite build --ssr scripts/smoke-layers.ts --outDir .tmp-smoke --emptyOutDir
//   node .tmp-smoke/smoke-layers.js

import * as THREE from "three";
import { Node } from "../../../src/framework/prototype/Node";
import { MeshNode } from "../../../src/framework/prototype/nodes/MeshNode";
import { DirectionalLightNode } from "../../../src/framework/prototype/nodes/DirectionalLightNode";
import { PointLightNode } from "../../../src/framework/prototype/nodes/PointLightNode";
import { CameraNode } from "../../../src/framework/prototype/nodes/CameraNode";
import { isLightComponent } from "../../../src/framework/prototype/Node";
import {
  ALL_LAYERS_MASK,
  BUILTIN_LAYER_INDEX,
  BUILTIN_LAYER_NAME,
  MAX_LAYERS,
  clampLayerIndex,
  cullingMaskLabel,
  definedLayerIndices,
  isLayerDefined,
  layerIndexOfName,
  layerNameAt,
  layerTableToJSON,
  maskHasLayer,
  maskWithLayer,
  nextFreeLayerIndex,
  parseCullingMask,
  parseLayerTable,
  parseTagList,
} from "../../../src/framework/layers";
import { parseLightComponentSettings } from "../../../src/framework/lighting/types";
import { SceneSynchronizer } from "../../../src/framework/engine/modules/SceneSynchronizer";
import {
  SKY_ONLY_FIRST_PASS,
  layerPassBits,
  populatedLayerBits,
  renderLayerPasses,
} from "../../../src/framework/engine/modules/layerPass";
import type { GraphLike } from "../../../src/framework/scene/SceneClient";
import { createSuite } from "../harness.mjs";

const { check, finish } = createSuite();

/** 最小 GraphLike（同步器只用到 get/all） */
function fakeGraph(nodes: Node[]): GraphLike {
  const map = new Map(nodes.map((n) => [n.id, n]));
  return { get: (id: string) => map.get(id), all: () => [...nodes] };
}

function objOf(sync: SceneSynchronizer, node: Node): THREE.Object3D {
  const obj = sync.getObjectMap().get(node.id);
  if (!obj) throw new Error(`未映射到 three 对象: ${node.id}`);
  return obj;
}

function findLight(root: THREE.Object3D): THREE.Light | null {
  let hit: THREE.Light | null = null;
  root.traverse((o) => {
    if (!hit && (o as THREE.Light).isLight === true) hit = o as THREE.Light;
  });
  return hit;
}

// ---------- ① 数据层 ----------
{
  check(
    "层表解析：空配置 → 仅内置层 0 Default；层 0 强制不可覆盖",
    (() => {
      const t = parseLayerTable(undefined);
      const t2 = parseLayerTable(["Ignored", "A", null, "B"]);
      return (
        t.length === MAX_LAYERS &&
        t[BUILTIN_LAYER_INDEX] === BUILTIN_LAYER_NAME &&
        !t.slice(1).some(Boolean) &&
        t2[0] === BUILTIN_LAYER_NAME &&
        t2[1] === "A" &&
        t2[3] === "B" &&
        !t2[2]
      );
    })(),
  );
  check(
    "层表收敛：重名保留首个、空白剔除、层 0 不受重名影响",
    (() => {
      const t = parseLayerTable(["Default", "Dup", " Dup ", "Dup"]);
      return t[0] === "Default" && t[1] === "Dup" && !t[2] && !t[3];
    })(),
  );
  check(
    "层表存档往返：toJSON 截尾部空位 → parse 还原一致",
    (() => {
      const t = parseLayerTable(["Default", "A", null, "B", ""]);
      const j = layerTableToJSON(t);
      return j.length === 4 && j[1] === "A" && j[3] === "B" && parseLayerTable(j)[3] === "B";
    })(),
  );
  check(
    "层工具：definedIndices 升序 / nextFree 跳过占用 / 按名查索引 / 未定义回退 Layer N",
    (() => {
      const t = parseLayerTable(["Default", "A", null, "B"]);
      return (
        JSON.stringify(definedLayerIndices(t)) === "[0,1,3]" &&
        nextFreeLayerIndex(t) === 2 &&
        layerIndexOfName(t, "B") === 3 &&
        layerIndexOfName(t, "无") === -1 &&
        layerNameAt(t, 2) === "Layer 2" &&
        isLayerDefined(t, 1) &&
        !isLayerDefined(t, 2)
      );
    })(),
  );
  check(
    "层索引收敛：越界/非数值回退 0，0~31 内四舍五入",
    clampLayerIndex(undefined) === 0 &&
      clampLayerIndex(-1) === 0 &&
      clampLayerIndex(32) === 0 &&
      clampLayerIndex(31) === 31 &&
      clampLayerIndex(1.6) === 2,
  );
  check(
    "cullingMask 收敛：缺省全部层 / int32 化",
    parseCullingMask(undefined) === ALL_LAYERS_MASK &&
      parseCullingMask(1 << 2) === 4 &&
      parseCullingMask(4294967295) === -1,
  );
  check(
    "掩码位运算：置位/清除/查询往返",
    (() => {
      const on = maskWithLayer(0, 3, true);
      const off = maskWithLayer(on, 3, false);
      return maskHasLayer(on, 3) && !maskHasLayer(off, 3) && off === 0;
    })(),
  );
  check(
    "掩码摘要：勾满已定义层 → Everything / 全不勾 → Nothing / 层名串（未定义层位不参与显示）",
    cullingMaskLabel(parseLayerTable(undefined), ALL_LAYERS_MASK) === "Everything" &&
      cullingMaskLabel(parseLayerTable(undefined), 0) === "Nothing" &&
      cullingMaskLabel(parseLayerTable(["Default", null, "Enemy"]), 1 | (1 << 2)) ===
        "Everything" &&
      cullingMaskLabel(parseLayerTable(["Default", "A", "B"]), 1 | 4) === "Default, B" &&
      cullingMaskLabel(parseLayerTable(["Default"]), 1 | (1 << 5)) === "Everything",
  );
  check(
    "标签收敛：trim/去空/去重保序",
    JSON.stringify(parseTagList([" A ", "A", "", "B"])) === '["A","B"]',
  );

  // 节点 layer 字段：默认/收敛/序列化往返/旧场景兼容
  const n = new Node();
  check("Node.layer 默认 0；越界 init 收敛", n.layer === 0 && new Node({ layer: 9 }).layer === 9);
  const m = new MeshNode();
  m.layer = 3;
  const json = m.toJSON() as Record<string, unknown>;
  const m2 = new MeshNode();
  m2.applyJSON(JSON.parse(JSON.stringify(json)) as Record<string, unknown>);
  check("layer 序列化往返：非 0 写入并还原", json.layer === 3 && m2.layer === 3);
  const z = new MeshNode();
  const zjson = z.toJSON() as Record<string, unknown>;
  check("layer = 0 不写入场景（旧场景字节兼容）", !("layer" in zjson));
  const old = new MeshNode();
  old.applyJSON({ type: "meshNode" });
  check("旧场景无 layer 字段回退 0", old.layer === 0);
  const cloned = m.clone();
  check("clone 携带 layer", cloned.layer === 3);
}

// ---------- ② 相机/灯光节点 cullingMask ----------
{
  check(
    "CameraNode 默认 cullingMask = -1；收敛与序列化往返；旧场景回退 -1",
    (() => {
      const c = new CameraNode();
      const c2 = new CameraNode({ cullingMask: (1 << 1) | (1 << 4) });
      const j = c2.toJSON() as Record<string, unknown>;
      const c3 = new CameraNode();
      c3.applyJSON(JSON.parse(JSON.stringify(j)) as Record<string, unknown>);
      const old = new CameraNode();
      old.applyJSON({});
      return (
        c.cullingMask === -1 &&
        c2.cullingMask === ((1 << 1) | (1 << 4)) &&
        c3.cullingMask === ((1 << 1) | (1 << 4)) &&
        old.cullingMask === -1
      );
    })(),
  );
  check(
    "PointLightNode cullingMask 走公共字段：往返 + 旧场景回退 + clone 携带",
    (() => {
      const p = new PointLightNode({ cullingMask: 1 << 2 });
      const j = p.toJSON() as Record<string, unknown>;
      const p2 = new PointLightNode();
      p2.applyJSON(JSON.parse(JSON.stringify(j)) as Record<string, unknown>);
      const old = new PointLightNode();
      old.applyJSON({ type: "pointLightNode" });
      return p2.cullingMask === (1 << 2) && old.cullingMask === -1 && p.clone().cullingMask === (1 << 2);
    })(),
  );
  check(
    "DirectionalLightNode cullingMask 往返（writeCommon/readCommon 覆盖全部灯型）",
    (() => {
      const d = new DirectionalLightNode({ cullingMask: -1 });
      const j = d.toJSON() as Record<string, unknown>;
      const d2 = new DirectionalLightNode();
      d2.applyJSON(j);
      return j.cullingMask === -1 && d2.cullingMask === -1;
    })(),
  );
  check(
    "灯光组件设置收敛：cullingMask 缺省 -1、往返、clone 保留",
    (() => {
      const s = parseLightComponentSettings({});
      const s2 = parseLightComponentSettings({ ...s, cullingMask: 1 << 3 });
      const s3 = JSON.parse(JSON.stringify(s2)) as Record<string, unknown>;
      return (
        s.cullingMask === -1 &&
        s2.cullingMask === (1 << 3) &&
        parseLightComponentSettings(s3).cullingMask === (1 << 3)
      );
    })(),
  );
}

// ---------- ③ 渲染建出（SceneSynchronizer） ----------
{
  const mesh = new MeshNode();
  mesh.layer = 2;
  const light = new PointLightNode({ cullingMask: (1 << 1) | (1 << 2) });
  light.castShadow = true;
  light.layer = 1;
  const plain = new Node();
  const compHost = new MeshNode();
  compHost.layer = 3;
  compHost.components.push({
    id: "comp1",
    type: "light",
    enabled: true,
    light: parseLightComponentSettings({ cullingMask: 1 << 4 }),
  });
  const scene = new THREE.Scene();
  const sync = new SceneSynchronizer(scene);
  const nodes = [mesh, light, plain, compHost];
  sync.rebuildAll(fakeGraph(nodes));

  const meshObj = objOf(sync, mesh);
  check(
    "网格节点打层：根对象 layers = 1<<layer，userData.nodeLayer 记录",
    meshObj.layers.mask === (1 << 2) && (meshObj.userData as { nodeLayer?: number }).nodeLayer === 2,
  );
  check("普通组节点打层", objOf(sync, plain).layers.mask === (1 << 0));

  const lightObj = objOf(sync, light);
  const lightInner = findLight(lightObj);
  check(
    "灯光节点：包装组随节点层，真实灯光对象 layers = cullingMask，阴影相机层同步",
    lightObj.layers.mask === (1 << 1) &&
      lightInner?.layers.mask === ((1 << 1) | (1 << 2)) &&
      lightInner?.shadow.camera.layers.mask === ((1 << 1) | (1 << 2)),
  );

  const compObj = objOf(sync, compHost);
  const compLight = findLight(compObj);
  check(
    "灯光组件：内层灯光 layers = 组件 cullingMask，宿主网格保持节点层",
    compLight?.layers.mask === (1 << 4) && compObj.layers.mask === (1 << 3),
  );

  // 层/掩码变更 → properties 刷新重新落位
  mesh.layer = 5;
  light.cullingMask = ALL_LAYERS_MASK;
  sync.onGraphChange({ kind: "properties", nodeId: mesh.id }, fakeGraph(nodes));
  sync.onGraphChange({ kind: "properties", nodeId: light.id }, fakeGraph(nodes));
  check(
    "属性补丁后层落位跟随（节点层与灯光掩码刷新）",
    objOf(sync, mesh).layers.mask === (1 << 5) && findLight(objOf(sync, light))?.layers.mask === -1,
  );
  sync.dispose();
}

// ---------- ④ 分层多 pass（layerPass.ts） ----------
{
  const scene = new THREE.Scene();
  const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  a.layers.set(0);
  const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  b.layers.set(1);
  const c = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  c.layers.set(3);
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  hidden.layers.set(7);
  hidden.visible = false;
  scene.add(a, b, c, hidden);
  const lightOn1 = new THREE.PointLight();
  lightOn1.layers.set(1);
  scene.add(lightOn1);

  check(
    "populatedLayerBits：只收集可见可渲染体（灯/不可见体不计）",
    populatedLayerBits(scene) === (1 | (1 << 1) | (1 << 3)),
  );

  const cam = new THREE.PerspectiveCamera();
  check("掩码全开 → 无需拆 pass（null）", layerPassBits(scene, cam) === null);
  cam.layers.mask = 1 << 1;
  check("掩码内只占用一层 → 单 pass（null）", layerPassBits(scene, cam) === null);
  cam.layers.mask = (1 << 1) | (1 << 3) | (1 << 20);
  check(
    "掩码内多层占用 → 升序单层位列表（掩码外层不参与）",
    JSON.stringify(layerPassBits(scene, cam)) === JSON.stringify([1 << 1, 1 << 3]),
  );
  cam.layers.mask = 1 << 20;
  check("掩码与在用层无交集 → null（单 pass 画空场）", layerPassBits(scene, cam) === null);
  // 相机掩码全开 + 部分掩码灯光：灯光 Culling Mask 恒生效，多层占用仍拆分
  const sceneB = new THREE.Scene();
  const l0 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  l0.layers.set(0);
  const l1 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  l1.layers.set(1);
  const maskedLight = new THREE.PointLight();
  maskedLight.layers.mask = 1; // 只照亮层 0
  sceneB.add(l0, l1, maskedLight);
  const freeCam = new THREE.PerspectiveCamera(); // 掩码全开
  freeCam.layers.enableAll(); // three 默认 mask=1（仅层 0），显式全开
  check(
    "掩码全开 + 部分掩码灯光 + 多层占用 → 按在用层拆分（灯光掩码恒生效）",
    JSON.stringify(layerPassBits(sceneB, freeCam)) === JSON.stringify([1, 1 << 1]),
  );
  sceneB.remove(maskedLight);
  const fullLight = new THREE.PointLight();
  // three 新建灯光默认 mask=1（仅层 0）即"部分掩码"；显式全开才是全层灯光
  fullLight.layers.mask = -1;
  sceneB.add(fullLight);
  check(
    "掩码全开 + 全层灯光 → 单 pass（零开销）",
    layerPassBits(sceneB, freeCam) === null,
  );

  // renderLayerPasses：调用序列、清屏/背景/相机层/天空面门控与恢复
  const calls: Array<{ mask: number; clearColor: boolean; clearDepth: boolean; bg: unknown }> = [];
  const fakeRenderer = {
    autoClearColor: true,
    autoClearDepth: true,
    render(s: THREE.Object3D, camera: THREE.Camera) {
      calls.push({
        mask: camera.layers.mask,
        clearColor: this.autoClearColor,
        clearDepth: this.autoClearDepth,
        bg: (s as THREE.Scene).background,
      });
    },
  };
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
  sky.userData[SKY_ONLY_FIRST_PASS] = true;
  scene.add(sky);
  scene.background = new THREE.Color(0x112233);
  cam.layers.mask = (1 << 1) | (1 << 3);
  renderLayerPasses(fakeRenderer, scene, cam, layerPassBits(scene, cam)!);
  check(
    "多 pass：首 pass 全清 + 背景 + 天空面，后续 pass 不清屏无背景无天空、逐层收窄",
    calls.length === 2 &&
      calls[0].mask === (1 << 1) &&
      calls[0].clearColor &&
      calls[0].bg !== null &&
      sky.visible &&
      calls[1].mask === (1 << 3) &&
      !calls[1].clearColor &&
      !calls[1].clearDepth &&
      calls[1].bg === null,
  );
  check(
    "多 pass 后恢复：相机层掩码/背景/autoClear 原样",
    cam.layers.mask === ((1 << 1) | (1 << 3)) &&
      scene.background !== null &&
      fakeRenderer.autoClearColor &&
      fakeRenderer.autoClearDepth &&
      sky.visible,
  );
}

finish();
