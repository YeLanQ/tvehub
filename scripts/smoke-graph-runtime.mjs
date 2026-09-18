// ---------------------------------------------------------------------------
// 场景图「网页运行时」冒烟（Node 直跑真实产物，不经打包）：
// 验证 public/engine/runtime/{graph-behaviors,graph-kernel,graph-core-modules}.mjs
// 与 nodes.mjs（真实场景构建器）/ 引擎内 three 的接线 —— 即 player 预览时的
// 同一条链路（源码级 mock 冒烟覆盖不到的：产物打包、场景 JSON→userData 标记、
// 装配时序、诊断输出）。
// 覆盖：
//   ① 真实场景构建：meshNode → userData.nodeId 标记（图按 id 匹配的根基）；
//   ② 目标口接线：原型 → 路径巡逻「目标」→ 每帧移动（玩家预览主用例）；
//   ③ 用户接线矩阵复核：只连「路径点」→ 不移动 + 无目标告警（可定位）；
//   ④ 实体缺失：原型引用 ghost id → 告警 + 不 crash；
//   ⑤ 装配摘要输出（确认"图是否被装载"）。
// 运行：npm run smoke:graph-runtime
// ---------------------------------------------------------------------------
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) {
    passed++;
    rawOut(`  ✓ ${label}`);
  } else {
    failed++;
    rawOut(`  ✗ ${label}`);
  }
}
/** 原始 stdout（console.log 在用例段被捕获，打印断言结果必须绕过） */
function rawOut(line) {
  process.stdout.write(`${line}\n`);
}
const approx = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// 最小 DOM 垫片（引擎模块导入期访问 window/document）
globalThis.window ??= globalThis;
globalThis.window.addEventListener ??= () => {};
globalThis.window.removeEventListener ??= () => {};
globalThis.document ??= { createElement: () => ({ style: {}, getContext: () => null }) };
globalThis.self ??= globalThis;

// 引擎日志捕获：内核诊断经 postLog（引擎日志通道）→ window.parent.postMessage，
// 与预览页回传编辑器控制台是同一条出口（console 不再承载引擎日志）
const posted = [];
globalThis.window.parent ??= {
  postMessage: (m) => {
    if (m && m.__editorPreviewLog === true) posted.push({ level: m.level, text: String(m.text) });
  },
};
const warnLines = () => posted.filter((l) => l.level === "warn").map((l) => l.text);
const infoLines = () => posted.filter((l) => l.level === "info").map((l) => l.text);

const root = resolve(import.meta.dirname, "..");
const engine = (rel) => pathToFileURL(resolve(root, "public/engine", rel)).href;

const THREE = await import(engine("core/three.module.min.js"));
const { buildSceneTree } = await import(engine("runtime/nodes.mjs"));
const { createGraphBehaviors, graphReferencedEntityIds } = await import(engine("runtime/graph-behaviors.mjs"));

/** 导出场景 JSON（与编辑器保存的场景文档同形状的最小集） */
function sceneJson(cratePos) {
  return {
    id: "root",
    type: "sceneNode",
    name: "Scene",
    children: [
      {
        id: "crate-1",
        type: "meshNode",
        name: "Crate", source: "primitive",
        tag: "pickup",
        geometry: "box",
        size: { x: 1, y: 1, z: 1 },
        transform: { position: cratePos, rotation: { x: 0, y: 20, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      },
    ],
  };
}

/** 图会话文档（侧车 .graph 同形状；目标口 / 路径点口接线由参数决定） */
function graphDoc(wiring) {
  const edges = [];
  if (wiring.includes("target")) edges.push({ id: "e1", srcNode: "n1", srcPort: "out", dstNode: "n2", dstPort: "in" });
  if (wiring.includes("path")) edges.push({ id: "e2", srcNode: "n1", srcPort: "out", dstNode: "n2", dstPort: "path" });
  return {
    formatVersion: 2,
    modules: [{ id: "core-entity", version: 1 }, { id: "core-driver", version: 1 }],
    nodes: [
      { id: "n1", type: "entity.proto", x: 0, y: 0, entityId: "crate-1" },
      { id: "n2", type: "op.patrol", x: 240, y: 0, opType: "op.patrol", params: { distance: 20, speed: 2, axis: "x" } },
    ],
    edges,
    comments: [],
    variables: [],
    customNodes: [],
  };
}

function boot(doc, opts = {}) {
  const scene = new THREE.Scene();
  const built = buildSceneTree(sceneJson(opts.cratePos ?? { x: 1.1, y: 8.7, z: -1.2 }), scene, {
    materialParams: new Map(),
    models: new Map(),
  });
  scene.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.updateMatrixWorld(true);
  const dom = {
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
  const handle = createGraphBehaviors({
    scene,
    dom,
    camera,
    logicApi: { fire() {}, setParam() {} },
    graph: doc,
    scriptApi: opts.scriptApi,
  });
  return { scene, handle, built };
}

function advance(handle, seconds, step = 1 / 60) {
  const n = Math.max(1, Math.round(seconds / step));
  for (let i = 0; i < n; i++) handle.update(step);
}

console.log("[1] 真实场景构建与实体标记");
{
  const { scene, built } = boot(graphDoc([]));
  const crate = scene.getObjectByProperty("name", "Crate");
  ok(!!crate, "meshNode 构建（场景含 Crate）");
  ok(crate?.userData.nodeId === "crate-1", `userData.nodeId 标记（${crate?.userData.nodeId}）——图按 id 匹配的根基`);
  ok(crate?.userData.nodeTag === "pickup", "userData.nodeTag 标记");
  ok((built.meshes ?? []).length >= 1, "meshes 清单登记");
  ok(approx(crate.position.x, 1.1) && approx(crate.position.y, 8.7), "transform 应用（1.1, 8.7, -1.2）");
}

console.log("[2] 目标口接线 → 每帧巡逻移动（玩家预览主用例）");
{
  posted.length = 0;
  const { scene, handle } = boot(graphDoc(["target"]));
  const crate = scene.getObjectByProperty("name", "Crate");
  const x0 = crate.position.x;
  advance(handle, 1);
  ok(approx(crate.position.x, x0 + 2), `1s 移动 +2（起点 ${x0.toFixed(1)} → ${crate.position.x.toFixed(1)}）`);
  advance(handle, 4);
  ok(crate.position.x > x0 && crate.position.x <= x0 + 20.001, `持续在 [起点, 起点+20] 内往返（当前 ${crate.position.x.toFixed(1)}）`);
  ok(warnLines().length === 0, `无诊断告警（warns=${warnLines().length}）`);
  ok(
    infoLines().some((l) => l.includes("场景图行为已装配") && l.includes("帧驱动器 1")),
    "装配摘要：帧驱动器 1（图已装载且驱动器入列）",
  );
  // 采样诊断：t=1s/2s 各一条，世界位置不同（内核确实在写位置）
  const samples = infoLines().filter((l) => l.includes("帧驱动采样")).map((l) => l.match(/世界位置 \(([-\d.]+)/)?.[1]);
  ok(samples.length === 2, `帧驱动采样 2 条（实际 ${samples.length}）`);
  ok(samples.length === 2 && samples[0] !== samples[1], `两次采样位移非零（${samples.join(" → ")}）——采样诊断可区分"没写位置"与"看错对象"`);
  ok(infoLines().some((l) => l.includes("（名称 Crate）")), "采样行带目标名称（核对被观察对象）");
}

console.log("[3] 只连「路径点」不连「目标」（静默不动 → 必须可见告警）");
{
  posted.length = 0;
  const { scene, handle } = boot(graphDoc(["path"]));
  const crate = scene.getObjectByProperty("name", "Crate");
  const x0 = crate.position.x;
  advance(handle, 2);
  ok(approx(crate.position.x, x0), "实体不移动（被移动对象接「目标」口才生效）");
  ok(
    warnLines().some((w) => w.includes("无目标实体") && w.includes("路径点口只接路径点")),
    "告警可定位：提示检查「目标」口连线",
  );
}

console.log("[4] 原型实体缺失（删除/重建/换场景）→ 告警 + 不 crash");
{
  posted.length = 0;
  const doc = graphDoc(["target"]);
  doc.nodes[0].entityId = "ghost";
  let crashed = false;
  try {
    boot(doc);
  } catch {
    crashed = true;
  }
  ok(!crashed, "不 crash");
  ok(warnLines().some((w) => w.includes("引用的场景实体") && w.includes("ghost")), "告警可定位：原型引用的实体不存在");
}

console.log("[5] 产物契约");
{
  ok(typeof createGraphBehaviors === "function", "graph-behaviors.mjs 导出 createGraphBehaviors");
  ok(typeof buildSceneTree === "function", "nodes.mjs 导出 buildSceneTree");
  ok(typeof graphReferencedEntityIds === "function", "graph-behaviors.mjs 导出 graphReferencedEntityIds（批处理排除用）");
}

console.log("[6] 静态批处理排除（图驱动实体不被烘焙）");
{
  const { optimizeScene } = await import(engine("runtime/batching.mjs"));

  // 引用集：原型 + 匹配命中（tag/type）；unresolved 跳过
  const ids = graphReferencedEntityIds(
    {
      nodes: [
        { id: "n1", type: "entity.proto", x: 0, y: 0, entityId: "crate-1" },
        { id: "n2", type: "entity.match", x: 0, y: 0, matchMode: "tag", matchPattern: "pickup" },
        { id: "n3", type: "entity.match", x: 0, y: 0, matchMode: "type", matchPattern: "meshNode" },
        { id: "n4", type: "ghost.op", x: 0, y: 0, unresolved: true, entityId: "ignored" },
      ],
      edges: [],
      comments: [],
    },
    [{ json: { id: "crate-1", type: "meshNode", tag: "pickup" } }],
  );
  ok(ids.includes("crate-1"), "引用集含原型实体");
  ok(!ids.includes("ignored"), "unresolved 节点不参与排除集");

  /** 三个同构静态盒子（满足实例化分组条件） */
  function buildThreeBoxes() {
    const scene = new THREE.Scene();
    const built = buildSceneTree(
      {
        id: "root",
        type: "sceneNode",
        children: [0, 1, 2].map((i) => ({
          id: `box-${i}`,
          type: "meshNode",
          source: "primitive",
          name: `Box${i}`,
          geometry: "box",
          size: { x: 1, y: 1, z: 1 },
          transform: { position: { x: i * 3, y: 0, z: 0 } },
        })),
      },
      scene,
      { materialParams: new Map(), models: new Map() },
    );
    return { scene, built };
  }

  {
    // 陷阱复现：无排除 → 实例化烘焙，原网格 visible=false（图再移动也不可见）
    const { scene, built } = buildThreeBoxes();
    optimizeScene(scene, built.meshes, built.clips, {});
    const box1 = scene.getObjectByProperty("name", "Box1");
    ok(box1?.visible === false, "无排除：静态网格被实例化吞掉（原对象隐藏）——这正是图移动无视觉表现的根因");
  }
  {
    // 修复语义：图引用实体排除 → 原对象保持可见；其余网格照常优化
    const { scene, built } = buildThreeBoxes();
    optimizeScene(scene, built.meshes, built.clips, { excludeNodeIds: ["box-1"] });
    const box1 = scene.getObjectByProperty("name", "Box1");
    ok(box1?.visible === true, "有排除：图驱动网格保持可见（图移动有视觉表现）");
    const box0 = scene.getObjectByProperty("name", "Box0");
    ok(box0?.visible === false, "其余静态网格仍参与批处理（优化不失效）");
  }
  {
    // 端到端：排除后，图驱动在渲染可见的对象上生效（世界位置随帧变化）
    const scene = new THREE.Scene();
    const built = buildSceneTree(
      {
        id: "root",
        type: "sceneNode",
        children: [
          { id: "crate-1", type: "meshNode", name: "Crate", source: "primitive", geometry: "box", size: { x: 1, y: 1, z: 1 }, transform: { position: { x: 1.1, y: 8.7, z: -1.2 } } },
          { id: "wall-1", type: "meshNode", name: "Wall", source: "primitive", geometry: "box", size: { x: 1, y: 1, z: 1 }, transform: { position: { x: 9, y: 0, z: 0 } } },
          { id: "wall-2", type: "meshNode", name: "Wall2", source: "primitive", geometry: "box", size: { x: 1, y: 1, z: 1 }, transform: { position: { x: 12, y: 0, z: 0 } } },
        ],
      },
      scene,
      { materialParams: new Map(), models: new Map() },
    );
    scene.updateMatrixWorld(true);
    const doc = graphDoc(["target"]);
    optimizeScene(scene, built.meshes, built.clips, { excludeNodeIds: graphReferencedEntityIds(doc, built.nodes) });
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.updateMatrixWorld(true);
    const handle = createGraphBehaviors({
      scene,
      dom: { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) },
      camera,
      logicApi: { fire() {}, setParam() {} },
      graph: doc,
    });
    const crate = scene.getObjectByProperty("name", "Crate");
    advance(handle, 1);
    ok(crate?.visible === true, "排除后 Crate 仍可见（未被烘焙）");
    ok(approx(crate.position.x, 3.1), `排除后巡逻位移可见生效（x=${crate.position.x.toFixed(2)}）`);
  }
}

console.log("[7] 通用属性路径（属性读取卡 entity.prop / 设置属性卡通用写：灯光·visible；子级路径已去寻址，经获取子级卡）");
{
  posted.length = 0;
  const scene = new THREE.Scene();
  buildSceneTree(
    {
      id: "root",
      type: "sceneNode",
      name: "Scene",
      children: [
        {
          id: "crate-1",
          type: "meshNode",
          name: "Crate",
          source: "primitive",
          geometry: "box",
          size: { x: 1, y: 1, z: 1 },
          transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 20, z: 0 } },
          children: [
            { id: "wheel-1", type: "meshNode", name: "Wheel", source: "primitive", geometry: "box", size: { x: 0.5, y: 0.5, z: 0.5 }, transform: { position: { x: 7, y: 0, z: 0 } } },
            { id: "lamp-1", type: "pointLightNode", name: "Lamp", lightColor: 0xffffff, intensity: 2.5, distance: 8, transform: { position: { x: 0, y: 1, z: 0 } } },
          ],
        },
      ],
    },
    scene,
    { materialParams: new Map(), models: new Map() },
  );
  scene.updateMatrixWorld(true);
  const doc = {
    formatVersion: 2,
    modules: [
      { id: "core-entity", version: 1 },
      { id: "core-event", version: 1 },
      { id: "core-op", version: 1 },
      { id: "core-flow", version: 1 },
    ],
    nodes: [
      { id: "eb", type: "event.onBegin", x: 0, y: 0 },
      { id: "p", type: "entity.proto", x: 0, y: 0, entityId: "crate-1" },
      { id: "ch", type: "op.children", x: 0, y: 0, opType: "op.children", params: {} },
      { id: "g1", type: "entity.prop", x: 0, y: 0, params: { property: "position.x" } },
      { id: "c1", type: "flow.compare", x: 0, y: 0, params: { operator: ">", b: 5 } },
      { id: "b1", type: "flow.branch", x: 0, y: 0, params: {} },
      { id: "s1", type: "op.set", x: 0, y: 0, opType: "op.set", params: { property: "position.y", value: 99 } },
      { id: "g2", type: "entity.prop", x: 0, y: 0, params: { property: "light.intensity" } },
      { id: "c2", type: "flow.compare", x: 0, y: 0, params: { operator: ">", b: 2 } },
      { id: "b2", type: "flow.branch", x: 0, y: 0, params: {} },
      { id: "s2", type: "op.set", x: 0, y: 0, opType: "op.set", params: { property: "visible", value: 0 } },
      { id: "s3", type: "op.set", x: 0, y: 0, opType: "op.set", params: { property: "Wheel.rotation.z", value: 45 } },
    ],
    edges: [
      { id: "x0", srcNode: "p", srcPort: "out", dstNode: "ch", dstPort: "in" },
      { id: "x1", srcNode: "ch", srcPort: "out", dstNode: "g1", dstPort: "target" },
      { id: "x2", srcNode: "eb", srcPort: "next", dstNode: "b1", dstPort: "exec" },
      { id: "x3", srcNode: "g1", srcPort: "value", dstNode: "c1", dstPort: "a" },
      { id: "x4", srcNode: "c1", srcPort: "result", dstNode: "b1", dstPort: "condition" },
      { id: "x5", srcNode: "b1", srcPort: "true", dstNode: "s1", dstPort: "exec" },
      { id: "x6", srcNode: "p", srcPort: "out", dstNode: "s1", dstPort: "in" },
      { id: "x7", srcNode: "p", srcPort: "out", dstNode: "g2", dstPort: "target" },
      { id: "x8", srcNode: "eb", srcPort: "next", dstNode: "b2", dstPort: "exec" },
      { id: "x9", srcNode: "g2", srcPort: "value", dstNode: "c2", dstPort: "a" },
      { id: "x10", srcNode: "c2", srcPort: "result", dstNode: "b2", dstPort: "condition" },
      { id: "x11", srcNode: "b2", srcPort: "true", dstNode: "s2", dstPort: "exec" },
      { id: "x12", srcNode: "p", srcPort: "out", dstNode: "s2", dstPort: "in" },
      { id: "x13", srcNode: "p", srcPort: "out", dstNode: "s3", dstPort: "in" },
    ],
    comments: [],
    variables: [],
    customNodes: [],
  };
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.updateMatrixWorld(true);
  const handle = createGraphBehaviors({
    scene,
    dom: { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) },
    camera,
    logicApi: { fire() {}, setParam() {} },
    graph: doc,
  });
  advance(handle, 0.1);
  const crate = scene.getObjectByProperty("name", "Crate");
  const wheel = scene.getObjectByProperty("name", "Wheel");
  ok(crate?.position.y === 99, `子级属性读取经「获取子级」换目标为真 → 分支执行 op.set（position.y=${crate?.position.y}）`);
  ok(crate?.visible === false, `灯光分量读取为真 → 通用写 visible（visible=${crate?.visible}）`);
  ok(!!wheel && wheel.rotation.z === 0, `子级路径不再经 op.set 寻址（Wheel.rotation.z 保持 ${(wheel?.rotation.z ?? -1)}；要写子级先接获取子级）`);
  ok(
    warnLines().some((w) => w.includes("设置属性") && w.includes("失败") && w.includes("Wheel.rotation.z")),
    "子级路径写入失败有可定位告警（warnOnce）",
  );
  handle.dispose();
}

console.log("[8] 获取子级卡 op.children（目标集 → 直属子级实体集，批量操作）");
{
  posted.length = 0;
  const scene = new THREE.Scene();
  buildSceneTree(
    {
      id: "root",
      type: "sceneNode",
      name: "Scene",
      children: [
        {
          id: "crate-1",
          type: "meshNode",
          name: "Crate",
          source: "primitive",
          geometry: "box",
          size: { x: 1, y: 1, z: 1 },
          transform: { position: { x: 0, y: 0, z: 0 } },
          children: [
            { id: "kid-a", type: "meshNode", name: "KidA", source: "primitive", geometry: "box", size: { x: 0.5, y: 0.5, z: 0.5 }, transform: { position: { x: 1, y: 0, z: 0 } } },
            { id: "kid-b", type: "meshNode", name: "KidB", source: "primitive", geometry: "box", size: { x: 0.5, y: 0.5, z: 0.5 }, transform: { position: { x: -1, y: 0, z: 0 } } },
          ],
        },
      ],
    },
    scene,
    { materialParams: new Map(), models: new Map() },
  );
  scene.updateMatrixWorld(true);
  const doc = {
    formatVersion: 2,
    modules: [{ id: "core-entity", version: 1 }, { id: "core-op", version: 1 }],
    nodes: [
      { id: "p", type: "entity.proto", x: 0, y: 0, entityId: "crate-1" },
      { id: "ch", type: "op.children", x: 0, y: 0, opType: "op.children", params: {} },
      { id: "s", type: "op.set", x: 0, y: 0, opType: "op.set", params: { property: "position.y", value: 4 } },
    ],
    edges: [
      { id: "x1", srcNode: "p", srcPort: "out", dstNode: "ch", dstPort: "in" },
      { id: "x2", srcNode: "ch", srcPort: "out", dstNode: "s", dstPort: "in" },
    ],
    comments: [],
    variables: [],
    customNodes: [],
  };
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.updateMatrixWorld(true);
  const handle = createGraphBehaviors({
    scene,
    dom: { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) },
    camera,
    logicApi: { fire() {}, setParam() {} },
    graph: doc,
  });
  const crate = scene.getObjectByProperty("name", "Crate");
  const kidA = scene.getObjectByProperty("name", "KidA");
  const kidB = scene.getObjectByProperty("name", "KidB");
  ok(kidA?.position.y === 4 && kidB?.position.y === 4, `子级批量设置（KidA/KidB y=${kidA?.position.y}/${kidB?.position.y}）`);
  ok(crate?.position.y === 0, "父实体不受影响（op.children 输出的是子级集）");
  ok(warnLines().length === 0, "无诊断告警（子级解析正常，无空目标）");
  handle.dispose();
}

console.log("[9] 获取子级 → ForEach「当前」按序索引子级（当前引脚参与操作目标通道）");
{
  posted.length = 0;
  const scene = new THREE.Scene();
  buildSceneTree(
    {
      id: "root",
      type: "sceneNode",
      name: "Scene",
      children: [
        {
          id: "rig-1",
          type: "meshNode",
          name: "Rig",
          source: "primitive",
          geometry: "box",
          size: { x: 1, y: 1, z: 1 },
          transform: { position: { x: 0, y: 0, z: 0 } },
          children: [
            { id: "w-a", type: "meshNode", name: "WheelA", source: "primitive", geometry: "box", size: { x: 0.5, y: 0.5, z: 0.5 }, transform: { position: { x: 1, y: 0, z: 0 } } },
            { id: "w-b", type: "meshNode", name: "WheelB", source: "primitive", geometry: "box", size: { x: 0.5, y: 0.5, z: 0.5 }, transform: { position: { x: -1, y: 0, z: 0 } } },
          ],
        },
      ],
    },
    scene,
    { materialParams: new Map(), models: new Map() },
  );
  scene.updateMatrixWorld(true);
  const doc = {
    formatVersion: 2,
    modules: [{ id: "core-entity", version: 1 }, { id: "core-event", version: 1 }, { id: "core-op", version: 1 }, { id: "core-flow", version: 1 }],
    nodes: [
      { id: "eb", type: "event.onBegin", x: 0, y: 0 },
      { id: "p", type: "entity.proto", x: 0, y: 0, entityId: "rig-1" },
      { id: "ch", type: "op.children", x: 0, y: 0, opType: "op.children", params: {} },
      { id: "fe", type: "flow.forEach", x: 0, y: 0, params: {} },
      { id: "s", type: "op.set", x: 0, y: 0, opType: "op.set", params: { property: "rotation.z", value: 45 } },
    ],
    edges: [
      { id: "y1", srcNode: "p", srcPort: "out", dstNode: "ch", dstPort: "in" },
      { id: "y2", srcNode: "ch", srcPort: "out", dstNode: "fe", dstPort: "array" },
      { id: "y3", srcNode: "eb", srcPort: "next", dstNode: "fe", dstPort: "exec" },
      { id: "y4", srcNode: "fe", srcPort: "loop", dstNode: "s", dstPort: "exec" },
      { id: "y5", srcNode: "fe", srcPort: "item", dstNode: "s", dstPort: "in" },
    ],
    comments: [],
    variables: [],
    customNodes: [],
  };
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.updateMatrixWorld(true);
  const handle = createGraphBehaviors({
    scene,
    dom: { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) },
    camera,
    logicApi: { fire() {}, setParam() {} },
    graph: doc,
  });
  const rig = scene.getObjectByProperty("name", "Rig");
  const wheelA = scene.getObjectByProperty("name", "WheelA");
  const wheelB = scene.getObjectByProperty("name", "WheelB");
  ok(Math.abs((wheelA?.rotation.z ?? 0) - Math.PI / 4) < 1e-6, `ForEach 按序索引子级 1/2：WheelA rotation.z=45°（实际 ${(wheelA?.rotation.z ?? -1).toFixed(3)} rad）`);
  ok(Math.abs((wheelB?.rotation.z ?? 0) - Math.PI / 4) < 1e-6, `ForEach 按序索引子级 2/2：WheelB 同步生效（实际 ${(wheelB?.rotation.z ?? -1).toFixed(3)} rad）`);
  ok(rig?.rotation.z === 0, "父实体不受影响（作用对象=ForEach 当前子级）");
  ok(warnLines().length === 0, "无诊断告警");
  handle.dispose();
}

console.log("[10] 卡片诊断与执行日志（无目标告警 / FSM 缺运行器 / 执行日志）");
{
  posted.length = 0;
  const scene = new THREE.Scene();
  buildSceneTree(
    {
      id: "root",
      type: "sceneNode",
      name: "Scene",
      children: [
        { id: "crate-1", type: "meshNode", name: "Crate", source: "primitive", geometry: "box", size: { x: 1, y: 1, z: 1 }, transform: { position: { x: 0, y: 0, z: 0 } } },
      ],
    },
    scene,
    { materialParams: new Map(), models: new Map() },
  );
  scene.updateMatrixWorld(true);
  const doc = {
    formatVersion: 2,
    modules: [{ id: "core-entity", version: 1 }, { id: "core-op", version: 1 }],
    nodes: [
      { id: "p", type: "entity.proto", x: 0, y: 0, entityId: "crate-1" },
      // 目标缺失：只填参数不接「目标」口 → 必须告警（原先静默跳过）
      { id: "s1", type: "op.set", x: 0, y: 0, opType: "op.set", params: { property: "position.y", value: 3 } },
      // 正常执行：接入目标 → 应有执行日志
      { id: "s2", type: "op.set", x: 0, y: 0, opType: "op.set", params: { property: "position.y", value: 3 } },
      // FSM 参数：目标无状态机运行器 → 必须告警（start 触发，装配即执行）
      { id: "f1", type: "op.setFsmParam", x: 0, y: 0, opType: "op.setFsmParam", params: { param: "hp", value: 1 } },
    ],
    edges: [
      { id: "x1", srcNode: "p", srcPort: "out", dstNode: "s2", dstPort: "in" },
      { id: "x2", srcNode: "p", srcPort: "out", dstNode: "f1", dstPort: "in" },
    ],
    comments: [],
    variables: [],
    customNodes: [],
  };
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.updateMatrixWorld(true);
  const handle = createGraphBehaviors({
    scene,
    dom: { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) },
    camera,
    logicApi: {
      fire() { throw new Error("no fsm runner"); },
      setParam() { throw new Error("no fsm runner"); },
    },
    graph: doc,
  });
  const crate = scene.getObjectByProperty("name", "Crate");
  ok(crate?.position.y === 3, `接线的设置属性执行生效（position.y=${crate?.position.y}）`);
  ok(
    warnLines().some((w) => w.includes("无目标实体") && w.includes("s1")),
    "无目标操作给出可定位告警（含节点 id）",
  );
  ok(
    warnLines().some((w) => w.includes("FSM 参数写入失败") && w.includes("crate-1")),
    "FSM 操作无运行器：不再静默（告警含目标实体）",
  );
  ok(
    infoLines().some((l) => l.includes("执行「设置属性」") && l.includes("s2")),
    "操作执行日志（引擎日志通道可见：确认卡片真的在跑）",
  );
  handle.dispose();
}

console.log("[11] 路径点接线：获取子级输出直连（按序巡回）/ ForEach「当前」误接（可定位告警）");
{
  posted.length = 0;
  const scene = new THREE.Scene();
  buildSceneTree(
    {
      id: "root",
      type: "sceneNode",
      name: "Scene",
      children: [
        {
          id: "rig-1",
          type: "meshNode",
          name: "Rig",
          source: "primitive",
          geometry: "box",
          size: { x: 1, y: 1, z: 1 },
          transform: { position: { x: 0, y: 0, z: 0 } },
          children: [
            { id: "wa", type: "meshNode", name: "WA", source: "primitive", geometry: "box", size: { x: 0.3, y: 0.3, z: 0.3 }, transform: { position: { x: 10, y: 0, z: 0 } } },
            { id: "wb", type: "meshNode", name: "WB", source: "primitive", geometry: "box", size: { x: 0.3, y: 0.3, z: 0.3 }, transform: { position: { x: -10, y: 0, z: 0 } } },
          ],
        },
        { id: "mover-1", type: "meshNode", name: "Mover", source: "primitive", geometry: "box", size: { x: 0.5, y: 0.5, z: 0.5 }, transform: { position: { x: 0, y: 0, z: 0 } } },
        { id: "mover-2", type: "meshNode", name: "Mover2", source: "primitive", geometry: "box", size: { x: 0.5, y: 0.5, z: 0.5 }, transform: { position: { x: 0, y: 0, z: 0 } } },
        {
          id: "rig-2",
          type: "meshNode",
          name: "Rig2",
          source: "primitive",
          geometry: "box",
          size: { x: 1, y: 1, z: 1 },
          transform: { position: { x: 100, y: 0, z: 0 } },
          children: [
            { id: "ra", type: "meshNode", name: "RA", source: "primitive", geometry: "box", size: { x: 0.3, y: 0.3, z: 0.3 }, transform: { position: { x: 10, y: 0, z: 0 } } },
            { id: "rb", type: "meshNode", name: "RB", source: "primitive", geometry: "box", size: { x: 0.3, y: 0.3, z: 0.3 }, transform: { position: { x: -10, y: 0, z: 0 } } },
          ],
        },
        { id: "mover-3", type: "meshNode", name: "Mover3", source: "primitive", geometry: "box", size: { x: 0.5, y: 0.5, z: 0.5 }, transform: { position: { x: 0, y: 0, z: 0 } } },
      ],
    },
    scene,
    { materialParams: new Map(), models: new Map() },
  );
  scene.updateMatrixWorld(true);
  const doc = {
    formatVersion: 2,
    modules: [{ id: "core-entity", version: 1 }, { id: "core-event", version: 1 }, { id: "core-op", version: 1 }, { id: "core-flow", version: 1 }],
    nodes: [
      { id: "pRig", type: "entity.proto", x: 0, y: 0, entityId: "rig-1" },
      { id: "pM1", type: "entity.proto", x: 0, y: 0, entityId: "mover-1" },
      { id: "pM2", type: "entity.proto", x: 0, y: 0, entityId: "mover-2" },
      { id: "ch", type: "op.children", x: 0, y: 0, opType: "op.children", params: {} },
      { id: "pt1", type: "op.patrol", x: 0, y: 0, opType: "op.patrol", params: { speed: 4, axis: "x", distance: 20 } },
      { id: "eb", type: "event.onBegin", x: 0, y: 0 },
      { id: "fe", type: "flow.forEach", x: 0, y: 0, params: {} },
      { id: "pt2", type: "op.patrol", x: 0, y: 0, opType: "op.patrol", params: { speed: 4, axis: "x", distance: 20 } },
      // 跨父级：路径点挂在偏移父级下（世界 ±100±10）——必须按世界坐标巡回
      { id: "pRig2", type: "entity.proto", x: 0, y: 0, entityId: "rig-2" },
      { id: "pM3", type: "entity.proto", x: 0, y: 0, entityId: "mover-3" },
      { id: "ch2", type: "op.children", x: 0, y: 0, opType: "op.children", params: {} },
      { id: "pt3", type: "op.patrol", x: 0, y: 0, opType: "op.patrol", params: { speed: 4, axis: "x", distance: 20 } },
    ],
    edges: [
      { id: "a", srcNode: "pRig", srcPort: "out", dstNode: "ch", dstPort: "in" },
      // 正例：子级集直连路径点
      { id: "b", srcNode: "ch", srcPort: "out", dstNode: "pt1", dstPort: "path" },
      { id: "c", srcNode: "pM1", srcPort: "out", dstNode: "pt1", dstPort: "in" },
      // 误接线：ForEach「当前」→ 路径点（遍历期引脚，帧驱动器求值时不在上下文）
      { id: "d", srcNode: "eb", srcPort: "next", dstNode: "fe", dstPort: "exec" },
      { id: "e", srcNode: "ch", srcPort: "out", dstNode: "fe", dstPort: "array" },
      { id: "f", srcNode: "fe", srcPort: "item", dstNode: "pt2", dstPort: "path" },
      { id: "g", srcNode: "pM2", srcPort: "out", dstNode: "pt2", dstPort: "in" },
      // 跨父级正例：路径点挂在偏移父级下
      { id: "h", srcNode: "pRig2", srcPort: "out", dstNode: "ch2", dstPort: "in" },
      { id: "i", srcNode: "ch2", srcPort: "out", dstNode: "pt3", dstPort: "path" },
      { id: "j", srcNode: "pM3", srcPort: "out", dstNode: "pt3", dstPort: "in" },
    ],
    comments: [],
    variables: [],
    customNodes: [],
  };
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.updateMatrixWorld(true);
  const handle = createGraphBehaviors({
    scene,
    dom: { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) },
    camera,
    logicApi: { fire() {}, setParam() {} },
    graph: doc,
  });
  advance(handle, 1);
  const m1 = scene.getObjectByProperty("name", "Mover");
  ok(approx(m1?.position.x, 4), `子级集直连路径点：1s 朝第一个子级移动 4（x=${m1?.position.x.toFixed(1)}）`);
  advance(handle, 4);
  ok(m1?.position.x <= 6, `按序巡回（5s 时 x=${m1?.position.x.toFixed(1)}；轴往返会是 20）`);
  ok(
    warnLines().some((w) => w.includes("路径点") && w.includes("解析不到实体")),
    "ForEach「当前」接路径点：给出可定位告警（含正确接法提示）",
  );
  ok(
    infoLines().some((l) => l.includes("ForEach 循环") && l.includes("遍历 2 个实体")),
    "ForEach 遍历数量日志（引擎日志通道可见）",
  );
  // 跨父级：路径点世界坐标 ±100±10，移动者在原点——必须按世界坐标走（局部坐标会永远停在 10 附近）
  advance(handle, 26);
  const m3 = scene.getObjectByProperty("name", "Mover3");
  ok(
    (m3?.position.x ?? 0) > 90,
    `跨父级路径点按世界坐标巡回（31s 后 x=${m3?.position.x.toFixed(1)}；局部坐标实现只会停在 10 附近）`,
  );
  handle.dispose();
}

console.log("[12] 原型卡「接入」口：实体集/数据交付给实体上的脚本（onGraphInput 通道）");
{
  // 场景 A：匹配卡实体集 → 原型接入口；装配期交付初值，值不变不重复回调
  posted.length = 0;
  const deliveries = [];
  const doc = {
    formatVersion: 2,
    modules: [{ id: "core-entity", version: 1 }],
    nodes: [
      { id: "n1", type: "entity.proto", x: 0, y: 0, entityId: "crate-1" },
      { id: "n2", type: "entity.match", x: 0, y: 160, matchMode: "tag", matchPattern: "pickup" },
      { id: "n3", type: "var.get", x: 0, y: 300, varId: "v1" },
    ],
    edges: [
      { id: "eA", srcNode: "n2", srcPort: "out", dstNode: "n1", dstPort: "in" },
      { id: "eB", srcNode: "n3", srcPort: "value", dstNode: "n1", dstPort: "in" },
    ],
    comments: [],
    variables: [{ id: "v1", name: "power", dataType: "number", value: 7 }],
    customNodes: [],
  };
  const { handle } = boot(doc, {
    scriptApi: {
      getProp: () => null,
      setProp: () => false,
      setGraphInput: (nodeId, _rel, value) => {
        deliveries.push({ nodeId, value });
        return true;
      },
    },
  });
  ok(deliveries.length === 1, `装配期交付初值 1 次（实际 ${deliveries.length}）`);
  const v = deliveries[0]?.value;
  ok(
    Array.isArray(v) && v.length === 2 && v[0]?.id === "crate-1" && v[1] === 7,
    `初值 = [实体 crate-1, 标量 7]（实际 ${JSON.stringify(v?.map((x) => (x?.id ?? x)))}）`,
  );
  ok(deliveries[0]?.nodeId === "crate-1", "交付按原型引用的实体 id 寻址");
  advance(handle, 0.5);
  ok(deliveries.length === 1, `值不变不重复回调（30 帧 still ${deliveries.length}）`);
  ok(
    infoLines().some((l) => l.includes("接入口") && l.includes("crate-1")),
    "接入口交付日志（引擎日志通道可见）",
  );
  handle.dispose();

  // 场景 B：实体上没有脚本实例（setGraphInput 回 false）→ 可定位告警
  posted.length = 0;
  const doc2 = {
    ...doc,
    nodes: [
      { id: "n1", type: "entity.proto", x: 0, y: 0, entityId: "crate-1" },
      { id: "n2", type: "entity.match", x: 0, y: 160, matchMode: "tag", matchPattern: "pickup" },
    ],
    edges: [{ id: "eA", srcNode: "n2", srcPort: "out", dstNode: "n1", dstPort: "in" }],
    variables: [],
  };
  const { handle: h2 } = boot(doc2, {
    scriptApi: { getProp: () => null, setProp: () => false, setGraphInput: () => false },
  });
  advance(h2, 0.1);
  ok(
    warnLines().some((w) => w.includes("接入口") && w.includes("没有存活的脚本实例")),
    "无人接收给出可定位告警（实体未挂脚本）",
  );
  h2.dispose();
}

rawOut(passed === 0 && failed === 0 ? "无断言" : `\n场景图运行时冒烟：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
