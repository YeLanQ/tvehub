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

console.log("[13] 中断开关 flow.gate：执行链与帧驱动器通断（状态机切换中断巡逻的实现路径）");
{
  // 场景：crate-1 = 巡逻者 B（运行中被「关」口中断）/ crate-2 = 巡逻者 A（初始断开）/ ball-1 = 距离参照
  posted.length = 0;
  const scene = new THREE.Scene();
  buildSceneTree(
    {
      id: "root",
      type: "sceneNode",
      name: "Scene",
      children: [
        { id: "crate-1", type: "meshNode", name: "Crate", source: "primitive", geometry: "box", size: { x: 1, y: 1, z: 1 }, transform: { position: { x: 0, y: 0, z: 0 } } },
        { id: "crate-2", type: "meshNode", name: "Crate2", source: "primitive", geometry: "box", size: { x: 1, y: 1, z: 1 }, transform: { position: { x: 0, y: 0, z: 10 } } },
        { id: "ball-1", type: "meshNode", name: "Ball", source: "primitive", geometry: "box", size: { x: 0.5, y: 0.5, z: 0.5 }, transform: { position: { x: 6, y: 0, z: 0 } } },
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
      { id: "et", type: "event.onTick", x: 0, y: 0 },
      { id: "eb", type: "event.onBegin", x: 0, y: 160 },
      { id: "p1", type: "entity.proto", x: 0, y: 320, entityId: "crate-1" },
      { id: "p2", type: "entity.proto", x: 0, y: 480, entityId: "crate-2" },
      { id: "pBall", type: "entity.proto", x: 0, y: 640, entityId: "ball-1" },
      { id: "dist", type: "sense.distance", x: 200, y: 640, params: {} },
      { id: "cmp", type: "flow.compare", x: 400, y: 640, params: { operator: "<", b: 5 } },
      { id: "br", type: "flow.branch", x: 600, y: 640, params: {} },
      { id: "gA", type: "flow.gate", x: 200, y: 0, params: {} },
      { id: "gB", type: "flow.gate", x: 400, y: 0, params: { initialOpen: true } },
      { id: "gC", type: "flow.gate", x: 200, y: 160, params: { initialOpen: true } },
      { id: "pt", type: "op.patrol", x: 600, y: 0, opType: "op.patrol", params: { speed: 2, axis: "x", distance: 20 } },
      { id: "pt2", type: "op.patrol", x: 400, y: 160, opType: "op.patrol", params: { speed: 2, axis: "x", distance: 20 } },
    ],
    edges: [
      // B 链：On Tick → 开关A（导通）→ 开关B（初始断开，On Begin「开」口闭合）→ 巡逻
      { id: "n1", srcNode: "et", srcPort: "next", dstNode: "gA", dstPort: "exec" },
      { id: "n2", srcNode: "gA", srcPort: "next", dstNode: "gB", dstPort: "exec" },
      { id: "n3", srcNode: "gB", srcPort: "next", dstNode: "pt", dstPort: "exec" },
      { id: "n4", srcNode: "p1", srcPort: "out", dstNode: "pt", dstPort: "in" },
      { id: "n5", srcNode: "eb", srcPort: "next", dstNode: "gB", dstPort: "on" },
      // 中断触发：距离 < 5 → 分支真 → 开关A「关」口（等价状态机追击态子链触发）
      { id: "n6", srcNode: "p1", srcPort: "out", dstNode: "dist", dstPort: "from" },
      { id: "n7", srcNode: "pBall", srcPort: "out", dstNode: "dist", dstPort: "to" },
      { id: "n8", srcNode: "dist", srcPort: "result", dstNode: "cmp", dstPort: "a" },
      { id: "n9", srcNode: "cmp", srcPort: "result", dstNode: "br", dstPort: "condition" },
      { id: "n10", srcNode: "et", srcPort: "next", dstNode: "br", dstPort: "exec" },
      { id: "n11", srcNode: "br", srcPort: "true", dstNode: "gA", dstPort: "off" },
      // A 链：On Tick → 开关C（初始断开，无「开」触发）→ 巡逻：永不步进
      { id: "n12", srcNode: "et", srcPort: "next", dstNode: "gC", dstPort: "exec" },
      { id: "n13", srcNode: "gC", srcPort: "next", dstNode: "pt2", dstPort: "exec" },
      { id: "n14", srcNode: "p2", srcPort: "out", dstNode: "pt2", dstPort: "in" },
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
  const crate2 = scene.getObjectByProperty("name", "Crate2");
  // A：初始断开且无「开」触发 → 下游巡逻驱动器永不步进
  advance(handle, 1);
  ok(approx(crate2.position.x, 0, 1e-9), `初始断开：下游巡逻 1s 零位移（x=${crate2.position.x.toFixed(3)}）`);
  ok(
    infoLines().some((l) => l.includes("中断开关") && l.includes("断开中")),
    "断开期间执行链被拦截有日志（可定位）",
  );
  // B：初始断开的开关B被 On Begin「开」口闭合 → 巡逻起步
  ok(crate.position.x > 0.5, `「开」口闭合后巡逻起步（0.5s x=${crate.position.x.toFixed(3)}；开口翻转失效会是 0）`);
  // B：距离 < 5 触发「关」口 → 巡逻冻结（等价状态机切入追击态）
  advance(handle, 0.5);
  const x1 = crate.position.x;
  ok(x1 > 1.0 && x1 < 1.1, `接近参照物后中断（1s x=${x1.toFixed(3)}，落在首个触达帧）`);
  advance(handle, 2);
  ok(approx(crate.position.x, x1, 1e-9), `中断后 2s 零位移（x=${crate.position.x.toFixed(3)}；门控失效会继续走到 ~5）`);
  ok(
    infoLines().some((l) => l.includes("中断开关") && l.includes("断开 → 下游中断")),
    "「关」口触发日志（确认翻转来自控制口）",
  );
  ok(warnLines().length === 0, `无诊断告警（warns=${warnLines().length}）`);
  handle.dispose();
}

console.log("[14] 朝向移动方向：巡逻/追击按位移写 yaw（+Z 前向；可关）");
{
  posted.length = 0;
  const scene = new THREE.Scene();
  buildSceneTree(
    {
      id: "root",
      type: "sceneNode",
      name: "Scene",
      children: [
        { id: "chaser-1", type: "meshNode", name: "Chaser", source: "primitive", geometry: "box", size: { x: 1, y: 1, z: 1 }, transform: { position: { x: 0, y: 0, z: 0 } } },
        { id: "ball-1", type: "meshNode", name: "Ball", source: "primitive", geometry: "box", size: { x: 0.5, y: 0.5, z: 0.5 }, transform: { position: { x: 8, y: 0, z: 0 } } },
        { id: "mover-1", type: "meshNode", name: "Mover", source: "primitive", geometry: "box", size: { x: 0.5, y: 0.5, z: 0.5 }, transform: { position: { x: 0, y: 0, z: 0 } } },
        { id: "wp-1", type: "meshNode", name: "WP", source: "primitive", geometry: "box", size: { x: 0.3, y: 0.3, z: 0.3 }, transform: { position: { x: 6, y: 0, z: 0 } } },
        { id: "mover-2", type: "meshNode", name: "Mover2", source: "primitive", geometry: "box", size: { x: 0.5, y: 0.5, z: 0.5 }, transform: { position: { x: 0, y: 0, z: 0 } } },
      ],
    },
    scene,
    { materialParams: new Map(), models: new Map() },
  );
  scene.updateMatrixWorld(true);
  const doc = {
    formatVersion: 2,
    modules: [{ id: "core-entity", version: 1 }, { id: "core-event", version: 1 }, { id: "core-op", version: 1 }],
    nodes: [
      // 追击：参数表不带 faceMove（旧场景回退路径）→ 缺省视为开
      { id: "pCh", type: "entity.proto", x: 0, y: 0, entityId: "chaser-1" },
      { id: "pBall", type: "entity.proto", x: 0, y: 0, entityId: "ball-1" },
      { id: "chs", type: "op.chase", x: 0, y: 0, opType: "op.chase", params: { speed: 4 } },
      // 巡逻路径点模式：同样缺省 faceMove
      { id: "pM1", type: "entity.proto", x: 0, y: 0, entityId: "mover-1" },
      { id: "pWp", type: "entity.proto", x: 0, y: 0, entityId: "wp-1" },
      { id: "pt1", type: "op.patrol", x: 0, y: 0, opType: "op.patrol", params: { speed: 4 } },
      // 关闭朝向的对照巡逻
      { id: "pM2", type: "entity.proto", x: 0, y: 0, entityId: "mover-2" },
      { id: "pt2", type: "op.patrol", x: 0, y: 0, opType: "op.patrol", params: { speed: 4, faceMove: false } },
    ],
    edges: [
      { id: "a", srcNode: "pCh", srcPort: "out", dstNode: "chs", dstPort: "in" },
      { id: "b", srcNode: "pBall", srcPort: "out", dstNode: "chs", dstPort: "prey" },
      { id: "c", srcNode: "pM1", srcPort: "out", dstNode: "pt1", dstPort: "in" },
      { id: "d", srcNode: "pWp", srcPort: "out", dstNode: "pt1", dstPort: "path" },
      { id: "e", srcNode: "pM2", srcPort: "out", dstNode: "pt2", dstPort: "in" },
      { id: "f", srcNode: "pWp", srcPort: "out", dstNode: "pt2", dstPort: "path" },
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
  const chaser = scene.getObjectByProperty("name", "Chaser");
  const mover = scene.getObjectByProperty("name", "Mover");
  const mover2 = scene.getObjectByProperty("name", "Mover2");
  advance(handle, 0.5);
  // 都朝 +x 移动 → yaw = atan2(1,0) = π/2（+Z 前向约定，与导航代理一致）
  ok(chaser.position.x > 1, `追击朝目标位移（0.5s x=${chaser.position.x.toFixed(2)}）`);
  ok(approx(chaser.rotation.y, Math.PI / 2), `追击朝向移动方向（yaw=${chaser.rotation.y.toFixed(3)} ≈ π/2）`);
  ok(mover.position.x > 1, `巡逻朝路径点位移（0.5s x=${mover.position.x.toFixed(2)}）`);
  ok(approx(mover.rotation.y, Math.PI / 2), `巡逻朝向移动方向（yaw=${mover.rotation.y.toFixed(3)} ≈ π/2）`);
  ok(approx(mover2.position.x, mover.position.x, 0.05) && approx(mover2.rotation.y, 0), `faceMove=false 同样移动但不改朝向（yaw=${mover2.rotation.y.toFixed(3)}）`);
  handle.dispose();
}

console.log("[15] 追击寻路：有导航区域 → 沿烘焙网格 A* 绕行障碍（无导航回退直线）");
{
  posted.length = 0;
  const scene = new THREE.Scene();

  // 地形：20×20 平地（高度场缓存在 mesh userData，与编辑器同一通道）
  const gridN = 33;
  const terrain = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  terrain.userData.terrainHeights = new Float32Array(gridN * gridN);
  terrain.userData.terrainGridSize = gridN;
  terrain.userData.terrainSize = 20;
  scene.add(terrain);

  // 障碍墙：x=4、z∈[-2.5,2.5]（带碰撞体、非动态刚体 → 计入烘焙障碍）
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 5));
  wall.position.set(4, 1, 0);
  scene.add(wall);

  const areaObj = new THREE.Group();
  scene.add(areaObj);

  // 追击者/目标（图驱动实体；目标在墙后——直线必然穿墙）
  const chaser = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5));
  chaser.position.set(0, 0, 0);
  chaser.userData.nodeId = "chaser-1";
  scene.add(chaser);
  const prey = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5));
  prey.position.set(8, 0, 0);
  prey.userData.nodeId = "prey-1";
  scene.add(prey);

  const { createNavRuntime } = await import(engine("runtime/nav.mjs"));
  const logs = [];
  const navApi = createNavRuntime({
    scene,
    nodes: [
      { json: { id: "terrain-1", type: "terrainNode", active: true, visible: true }, obj: terrain },
      { json: { id: "wall-1", type: "meshNode", active: true, visible: true, components: [{ id: "c1", type: "collider", enabled: true }] }, obj: wall },
      { json: { id: "area-1", type: "navAreaNode", active: true, visible: true, settings: {} }, obj: areaObj },
    ],
    onLog: (m) => logs.push(m),
  });
  ok(logs.some((l) => l.includes("区域 area-1 烘焙") && !l.includes("失败")), `导航区域烘焙成功（${logs.find((l) => l.includes("烘焙")) ?? "无日志"}）`);
  const path = navApi.pathBetween({ x: 0, z: 0 }, { x: 8, z: 0 });
  ok(!!path && path.length >= 3, `pathBetween 返回绕行折线（${path?.length ?? 0} 个路径点）`);

  const doc = {
    formatVersion: 2,
    modules: [{ id: "core-entity", version: 1 }, { id: "core-driver", version: 1 }],
    nodes: [
      { id: "pC", type: "entity.proto", x: 0, y: 0, entityId: "chaser-1" },
      { id: "pP", type: "entity.proto", x: 0, y: 0, entityId: "prey-1" },
      { id: "chs", type: "op.chase", x: 0, y: 0, opType: "op.chase", params: { speed: 4 } },
    ],
    edges: [
      { id: "a", srcNode: "pC", srcPort: "out", dstNode: "chs", dstPort: "in" },
      { id: "b", srcNode: "pP", srcPort: "out", dstNode: "chs", dstPort: "prey" },
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
    navApi,
  });

  // 逐帧推进追击：全程不得进入墙 AABB（外扩净空），且必须出现 z 向绕行
  let penetrated = false;
  let detoured = false;
  let reached = false;
  for (let i = 0; i < 600; i++) {
    handle.update(1 / 60);
    const cx = chaser.position.x;
    const cz = chaser.position.z;
    if (cx > 3.1 && cx < 4.9 && Math.abs(cz) < 2.9) penetrated = true;
    if (cx > 2.5 && cx < 5.5 && Math.abs(cz) > 1.5) detoured = true;
    if (Math.hypot(cx - 8, cz) < 0.6) {
      reached = true;
      break;
    }
  }
  ok(!penetrated, "全程未穿透障碍墙");
  ok(detoured, "出现 z 向绕行（直线轨迹不会有的特征）");
  ok(reached, `绕行后抵达目标（末帧 (${chaser.position.x.toFixed(2)}, ${chaser.position.z.toFixed(2)})，目标 (8, 0)）`);
  ok(warnLines().length === 0, `无诊断告警（warns=${warnLines().length}）`);
  navApi.dispose();
  handle.dispose();
}

console.log("[16] 状态机容器：迁移守卫（from>to）+ 同状态去重/可重入（多状态切换）");
{
  posted.length = 0;
  const scene = new THREE.Scene();
  buildSceneTree(
    {
      id: "root",
      type: "sceneNode",
      name: "Scene",
      children: [
        // host / host2：position.x 编码当前状态（100=a 200=b 300=c / 111 222）
        { id: "host-1", type: "meshNode", name: "Host", source: "primitive", geometry: "box", size: { x: 0.5, y: 0.5, z: 0.5 }, transform: { position: { x: 0, y: 0, z: 0 } } },
        { id: "host-2", type: "meshNode", name: "Host2", source: "primitive", geometry: "box", size: { x: 0.5, y: 0.5, z: 0.5 }, transform: { position: { x: 0, y: 0, z: 0 } } },
        // 巡逻 movers：位置越过 5 → 比较卡上升沿（触发对应状态）
        // mover-1：speed 2 → x=2t，t≈2.5s 越过 5（事件 b）
        { id: "mover-1", type: "meshNode", name: "Mover1", source: "primitive", geometry: "box", size: { x: 0.3, y: 0.3, z: 0.3 }, transform: { position: { x: 0, y: 0, z: 0 } } },
        // mover-2：speed 4、distance 20（周期 10s）→ t≈1.25s↑、8.75s↓、11.25s↑ 越过 5（事件 c）
        { id: "mover-2", type: "meshNode", name: "Mover2", source: "primitive", geometry: "box", size: { x: 0.3, y: 0.3, z: 0.3 }, transform: { position: { x: 0, y: 0, z: 0 } } },
      ],
    },
    scene,
    { materialParams: new Map(), models: new Map() },
  );
  scene.updateMatrixWorld(true);
  const doc = {
    formatVersion: 2,
    modules: [
      { id: "core-entity", version: 1 }, { id: "core-event", version: 1 },
      { id: "core-op", version: 1 }, { id: "core-flow", version: 1 }, { id: "core-containers", version: 1 },
    ],
    nodes: [
      { id: "eb", type: "event.onBegin", x: 0, y: 0 },
      // 容器 fsm1：states a/b/c，initial a，守卫 b>c（c 只允许从 b 进入）
      { id: "fsm1", type: "fsm.container", x: 0, y: 0, params: { states: "a,b,c", initial: "a", guards: "b>c" } },
      { id: "pH", type: "entity.proto", x: 0, y: 0, entityId: "host-1" },
      { id: "setA", type: "op.set", x: 0, y: 0, containerId: "fsm1", stateName: "a", opType: "op.set", params: { property: "position.x", value: 100 } },
      { id: "setB", type: "op.set", x: 0, y: 0, containerId: "fsm1", stateName: "b", opType: "op.set", params: { property: "position.x", value: 200 } },
      { id: "setC", type: "op.set", x: 0, y: 0, containerId: "fsm1", stateName: "c", opType: "op.set", params: { property: "position.x", value: 300 } },
      // 容器 fsm2：initial b + 重复进入；同一比较(cmp1)再触发同状态 → 允许重入
      { id: "fsm2", type: "fsm.container", x: 0, y: 0, params: { states: "a,b", initial: "b", reentry: true } },
      { id: "pH2", type: "entity.proto", x: 0, y: 0, entityId: "host-2" },
      { id: "set2B", type: "op.set", x: 0, y: 0, containerId: "fsm2", stateName: "b", opType: "op.set", params: { property: "position.y", value: 222 } },
      // 条件源：mover 位置 > 5
      { id: "pM1", type: "entity.proto", x: 0, y: 0, entityId: "mover-1" },
      { id: "pM2", type: "entity.proto", x: 0, y: 0, entityId: "mover-2" },
      { id: "prop1", type: "entity.prop", x: 0, y: 0, params: { property: "position.x" } },
      { id: "prop2", type: "entity.prop", x: 0, y: 0, params: { property: "position.x" } },
      { id: "cmp1", type: "flow.compare", x: 0, y: 0, params: { operator: ">", b: 5, event: "b" } },
      { id: "cmp2", type: "flow.compare", x: 0, y: 0, params: { operator: ">", b: 5, event: "c" } },
      // 两条巡逻腿（容器外，legacy 帧驱动）
      { id: "pt1", type: "op.patrol", x: 0, y: 0, opType: "op.patrol", params: { speed: 2, axis: "x", distance: 20 } },
      { id: "pt2", type: "op.patrol", x: 0, y: 0, opType: "op.patrol", params: { speed: 4, axis: "x", distance: 20 } },
    ],
    edges: [
      { id: "e0", srcNode: "eb", srcPort: "next", dstNode: "fsm1", dstPort: "exec" },
      { id: "e0b", srcNode: "eb", srcPort: "next", dstNode: "fsm2", dstPort: "exec" },
      { id: "h1", srcNode: "pH", srcPort: "out", dstNode: "setA", dstPort: "in" },
      { id: "h2", srcNode: "pH", srcPort: "out", dstNode: "setB", dstPort: "in" },
      { id: "h3", srcNode: "pH", srcPort: "out", dstNode: "setC", dstPort: "in" },
      { id: "h4", srcNode: "pH2", srcPort: "out", dstNode: "set2B", dstPort: "in" },
      { id: "c1", srcNode: "pM1", srcPort: "out", dstNode: "prop1", dstPort: "target" },
      { id: "c2", srcNode: "pM2", srcPort: "out", dstNode: "prop2", dstPort: "target" },
      { id: "c3", srcNode: "pM1", srcPort: "out", dstNode: "pt1", dstPort: "in" },
      { id: "c4", srcNode: "pM2", srcPort: "out", dstNode: "pt2", dstPort: "in" },
      { id: "d1", srcNode: "prop1", srcPort: "value", dstNode: "cmp1", dstPort: "a" },
      { id: "d2", srcNode: "prop2", srcPort: "value", dstNode: "cmp2", dstPort: "a" },
      { id: "x1", srcNode: "cmp1", srcPort: "result", dstNode: "fsm1", dstPort: "condition" },
      { id: "x2", srcNode: "cmp2", srcPort: "result", dstNode: "fsm1", dstPort: "condition" },
      { id: "x3", srcNode: "cmp1", srcPort: "result", dstNode: "fsm2", dstPort: "condition" },
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
  const host = scene.getObjectByProperty("name", "Host");
  const host2 = scene.getObjectByProperty("name", "Host2");

  // 初始进入：fsm1→a (x=100)；fsm2→b (y=222)
  handle.update(1 / 60);
  ok(approx(host.position.x, 100), `进入激活初始状态 a（x=${host.position.x}）`);
  ok(approx(host2.position.y, 222), `fsm2 初始状态 b（y=${host2.position.y}）`);

  // t≈1.25s mover-2 越过 5 → 事件 c，但守卫 b>c 且当前 a → 阻断
  advance(handle, 2);
  ok(approx(host.position.x, 100), `守卫阻断 a→c（t=2s x=${host.position.x}，无守卫会是 300）`);
  ok(infoLines().some((l) => l.includes("迁移守卫 b>c") && l.includes("当前状态「a」")), "阻断有可定位日志");

  // t≈2.5s mover-1 越过 5 → 事件 b（无守卫限制）→ 切到 b；同一上升沿打到
  // fsm2（当前 b + 重复进入）→ 重入
  advance(handle, 1);
  ok(approx(host.position.x, 200), `t=3s 切到 b（x=${host.position.x}）`);
  const fsm2SwitchB = infoLines().filter((l) => l.includes("状态机容器 (fsm2)") && l.includes("状态「b」") && !l.includes("忽略")).length;
  ok(fsm2SwitchB >= 2, `fsm2 重复进入：b 重入 ≥2 次（进入 + 同状态再触发，实际 ${fsm2SwitchB}）`);

  // t≈11.25s mover-2 第二次上升沿 → 当前 b，守卫放行 b→c
  advance(handle, 8.5);
  ok(approx(host.position.x, 300), `t=11.5s 守卫放行 b→c（x=${host.position.x}）`);

  // t≈21.25s mover-2 第三次上升沿 → 目标 c = 当前 c → 去重（入口链不重跑）
  advance(handle, 10.5);
  ok(approx(host.position.x, 300), `同状态重复触发被忽略（t=22s x=${host.position.x}）`);
  const fsm1SwitchC = infoLines().filter((l) => l.includes("状态机容器 (fsm1)") && l.includes("状态「c」") && !l.includes("忽略")).length;
  ok(fsm1SwitchC === 1, `fsm1 同状态去重：c 只切换 1 次（实际 ${fsm1SwitchC}）`);
  ok(infoLines().some((l) => l.includes("(fsm1)") && l.includes("已处于状态「c」")), "去重有可定位日志");
  ok(warnLines().length === 0, `无诊断告警（warns=${warnLines().length}）`);
  handle.dispose();
}

console.log("[17] 行为树容器：sequence 驱动器步进 / selector 条件配对 / parallel 每帧重跑");
{
  posted.length = 0;
  const scene = new THREE.Scene();
  buildSceneTree(
    {
      id: "root",
      type: "sceneNode",
      name: "Scene",
      children: [
        { id: "host-1", type: "meshNode", name: "Host1", source: "primitive", geometry: "box", size: { x: 0.5, y: 0.5, z: 0.5 }, transform: { position: { x: 0, y: 0, z: 0 } } },
        { id: "host-2", type: "meshNode", name: "Host2", source: "primitive", geometry: "box", size: { x: 0.5, y: 0.5, z: 0.5 }, transform: { position: { x: 0, y: 0, z: 0 } } },
        // mover-5：Y 轴巡逻（并行容器的成员把它的 X 钉在 5 → 每帧重跑可观测）
        { id: "mover-5", type: "meshNode", name: "Mover5", source: "primitive", geometry: "box", size: { x: 0.3, y: 0.3, z: 0.3 }, transform: { position: { x: 0, y: 0, z: 0 } } },
        // selector 条件源：mover-3（speed 2，t≈2.5s 越过 5）/ mover-4（speed 4，t≈1.25s 越过 5）
        { id: "mover-3", type: "meshNode", name: "Mover3", source: "primitive", geometry: "box", size: { x: 0.3, y: 0.3, z: 0.3 }, transform: { position: { x: 0, y: 0, z: 0 } } },
        { id: "mover-4", type: "meshNode", name: "Mover4", source: "primitive", geometry: "box", size: { x: 0.3, y: 0.3, z: 0.3 }, transform: { position: { x: 0, y: 0, z: 0 } } },
      ],
    },
    scene,
    { materialParams: new Map(), models: new Map() },
  );
  scene.updateMatrixWorld(true);
  const doc = {
    formatVersion: 2,
    modules: [
      { id: "core-entity", version: 1 }, { id: "core-event", version: 1 },
      { id: "core-op", version: 1 }, { id: "core-flow", version: 1 }, { id: "core-containers", version: 1 },
    ],
    nodes: [
      { id: "eb", type: "event.onBegin", x: 0, y: 0 },
      // bt1 sequence：进入跑全部成员；成员 2 是持续旋转驱动器（激活期间应被容器步进）
      { id: "bt1", type: "bt.container", x: 0, y: 0, params: { mode: "sequence", interval: 0 } },
      { id: "pH1", type: "entity.proto", x: 0, y: 0, entityId: "host-1" },
      { id: "s1", type: "op.set", x: 0, y: 0, containerId: "bt1", opType: "op.set", params: { property: "position.y", value: 50 } },
      { id: "sp1", type: "op.spin", x: 0, y: 0, containerId: "bt1", opType: "op.spin", params: { speedX: 0, speedY: 0, speedZ: 90 } },
      // bt2 selector：条件源与成员纵向配对——cmp1(y=0)↔m1(y=0)、cmp2(y=100)↔m2(y=100)
      // interval=1 每秒重新选择；命中「最上面的为真条件」所配对的成员
      { id: "bt2", type: "bt.container", x: 0, y: 0, params: { mode: "selector", interval: 1 } },
      { id: "pH2", type: "entity.proto", x: 0, y: 0, entityId: "host-2" },
      { id: "m1", type: "op.set", x: 0, y: 0, containerId: "bt2", opType: "op.set", params: { property: "position.x", value: 111 } },
      { id: "m2", type: "op.set", x: 0, y: 0, containerId: "bt2", opType: "op.set", params: { property: "position.x", value: 222 } },
      { id: "pM3", type: "entity.proto", x: 0, y: 0, entityId: "mover-3" },
      { id: "pM4", type: "entity.proto", x: 0, y: 0, entityId: "mover-4" },
      { id: "prop1", type: "entity.prop", x: 0, y: 0, params: { property: "position.x" } },
      { id: "prop2", type: "entity.prop", x: 0, y: 0, params: { property: "position.x" } },
      { id: "cmp1", type: "flow.compare", x: 0, y: 0, params: { operator: ">", b: 5 } },
      { id: "cmp2", type: "flow.compare", x: 100, y: 100, params: { operator: ">", b: 5 } },
      // 条件源巡逻腿（容器外 legacy 帧驱动）：mover-3 speed 2 / mover-4 speed 4
      { id: "pt3", type: "op.patrol", x: 0, y: 0, opType: "op.patrol", params: { speed: 2, axis: "x", distance: 20 } },
      { id: "pt4", type: "op.patrol", x: 0, y: 0, opType: "op.patrol", params: { speed: 4, axis: "x", distance: 20 } },
      // bt3 parallel：成员把 mover-5 的 X 钉在 5；mover-5 自带 Y 轴巡逻（容器外 legacy）
      { id: "bt3", type: "bt.container", x: 0, y: 0, params: { mode: "parallel", interval: 0 } },
      { id: "pM5", type: "entity.proto", x: 0, y: 0, entityId: "mover-5" },
      { id: "pin", type: "op.set", x: 0, y: 0, containerId: "bt3", opType: "op.set", params: { property: "position.x", value: 5 } },
      { id: "pt5", type: "op.patrol", x: 0, y: 0, opType: "op.patrol", params: { speed: 2, axis: "y", distance: 20 } },
    ],
    edges: [
      { id: "e0", srcNode: "eb", srcPort: "next", dstNode: "bt1", dstPort: "exec" },
      { id: "e0b", srcNode: "eb", srcPort: "next", dstNode: "bt2", dstPort: "exec" },
      { id: "e0c", srcNode: "eb", srcPort: "next", dstNode: "bt3", dstPort: "exec" },
      { id: "h1", srcNode: "pH1", srcPort: "out", dstNode: "s1", dstPort: "in" },
      { id: "h2", srcNode: "pH1", srcPort: "out", dstNode: "sp1", dstPort: "in" },
      { id: "h3", srcNode: "pH2", srcPort: "out", dstNode: "m1", dstPort: "in" },
      { id: "h4", srcNode: "pH2", srcPort: "out", dstNode: "m2", dstPort: "in" },
      { id: "h5", srcNode: "pM5", srcPort: "out", dstNode: "pin", dstPort: "in" },
      { id: "w1", srcNode: "pM3", srcPort: "out", dstNode: "prop1", dstPort: "target" },
      { id: "w2", srcNode: "pM4", srcPort: "out", dstNode: "prop2", dstPort: "target" },
      { id: "w3", srcNode: "pM5", srcPort: "out", dstNode: "pt5", dstPort: "in" },
      { id: "w4", srcNode: "pM3", srcPort: "out", dstNode: "pt3", dstPort: "in" },
      { id: "w5", srcNode: "pM4", srcPort: "out", dstNode: "pt4", dstPort: "in" },
      { id: "d1", srcNode: "prop1", srcPort: "value", dstNode: "cmp1", dstPort: "a" },
      { id: "d2", srcNode: "prop2", srcPort: "value", dstNode: "cmp2", dstPort: "a" },
      { id: "x1", srcNode: "cmp1", srcPort: "result", dstNode: "bt2", dstPort: "condition" },
      { id: "x2", srcNode: "cmp2", srcPort: "result", dstNode: "bt2", dstPort: "condition" },
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
  const host1 = scene.getObjectByProperty("name", "Host1");
  const host2 = scene.getObjectByProperty("name", "Host2");
  const mover5 = scene.getObjectByProperty("name", "Mover5");

  // 进入即执行：sequence 全部成员（y=50），激活后框内驱动器（spin）被容器步进
  handle.update(1 / 60);
  ok(approx(host1.position.y, 50), `sequence：进入执行全部成员（y=${host1.position.y}）`);
  advance(handle, 1);
  ok(host1.rotation.z > Math.PI / 2, `激活后容器步进框内驱动器（1s 旋转 z=${host1.rotation.z.toFixed(2)}rad ≈ 90°/s，此前驱动器在行为树容器内不会动）`);
  ok(approx(host2.position.x, 0), `selector：进入时无条件源为真 → 不执行成员（x=${host2.position.x}）`);
  // t≈2s：interval=1 重选——mover-4 已越过 5（cmp2 真）→ 命中第 2 个成员
  advance(handle, 1.5);
  ok(approx(host2.position.x, 222), `selector：cmp2 真 → 配对成员 2（x=${host2.position.x}）`);
  // t≈3s：mover-3 也越过 5 → 最上面的为真条件（cmp1）优先 → 成员 1
  advance(handle, 1.5);
  ok(approx(host2.position.x, 111), `selector：cmp1 优先（更靠上）→ 配对成员 1（x=${host2.position.x}）`);
  // parallel：mover-5 的 X 被成员每帧钉在 5，Y 被自己的巡逻推动
  const y5 = mover5.position.y;
  ok(approx(mover5.position.x, 5) && mover5.position.y > 1, `parallel：成员每帧重跑（x=${mover5.position.x} 被钉住，y=${mover5.position.y.toFixed(1)} 巡逻推进）`);
  advance(handle, 1);
  ok(approx(mover5.position.x, 5) && mover5.position.y > y5 + 1, `parallel：持续每帧钉 X（y 继续推进到 ${mover5.position.y.toFixed(1)}）`);
  ok(warnLines().length === 0, `无诊断告警（warns=${warnLines().length}）`);
  handle.dispose();
}

console.log("[18] 嵌套容器随父级调度：状态机内的行为树容器随状态启停");
{
  posted.length = 0;
  const scene = new THREE.Scene();
  buildSceneTree(
    {
      id: "root",
      type: "sceneNode",
      name: "Scene",
      children: [
        { id: "host-3", type: "meshNode", name: "Host3", source: "primitive", geometry: "box", size: { x: 0.5, y: 0.5, z: 0.5 }, transform: { position: { x: 0, y: 0, z: 0 } } },
        // 条件源：mover-6 speed 2 → t≈2.5s 越过 5（上升沿切 b），t≈17.5s 落回 5 下（切回 a）
        { id: "mover-6", type: "meshNode", name: "Mover6", source: "primitive", geometry: "box", size: { x: 0.3, y: 0.3, z: 0.3 }, transform: { position: { x: 0, y: 0, z: 0 } } },
      ],
    },
    scene,
    { materialParams: new Map(), models: new Map() },
  );
  scene.updateMatrixWorld(true);
  const doc = {
    formatVersion: 2,
    modules: [
      { id: "core-entity", version: 1 }, { id: "core-event", version: 1 },
      { id: "core-op", version: 1 }, { id: "core-flow", version: 1 }, { id: "core-containers", version: 1 },
    ],
    nodes: [
      { id: "eb", type: "event.onBegin", x: 0, y: 0 },
      // 状态机：a（无行为）/ b（行为树容器：持续旋转 host-3）
      { id: "fsm", type: "fsm.container", x: 0, y: 0, params: { states: "a,b", initial: "a" } },
      // 行为树容器打「所属状态 = b」：只在 b 态被父级调度
      { id: "bt", type: "bt.container", x: 0, y: 0, containerId: "fsm", stateName: "b", params: { mode: "sequence", interval: 0 } },
      { id: "pH", type: "entity.proto", x: 0, y: 0, entityId: "host-3" },
      { id: "sp", type: "op.spin", x: 0, y: 0, containerId: "bt", opType: "op.spin", params: { speedX: 0, speedY: 0, speedZ: 90 } },
      { id: "pM", type: "entity.proto", x: 0, y: 0, entityId: "mover-6" },
      { id: "prop", type: "entity.prop", x: 0, y: 0, params: { property: "position.x" } },
      { id: "cmp", type: "flow.compare", x: 0, y: 0, params: { operator: ">", b: 5, event: "b" } },
      { id: "cmpBack", type: "flow.compare", x: 0, y: 120, params: { operator: "<", b: 5, event: "a" } },
      { id: "pt", type: "op.patrol", x: 0, y: 0, opType: "op.patrol", params: { speed: 2, axis: "x", distance: 20 } },
    ],
    edges: [
      { id: "e0", srcNode: "eb", srcPort: "next", dstNode: "fsm", dstPort: "exec" },
      { id: "h1", srcNode: "pH", srcPort: "out", dstNode: "sp", dstPort: "in" },
      { id: "w1", srcNode: "pM", srcPort: "out", dstNode: "prop", dstPort: "target" },
      { id: "w2", srcNode: "pM", srcPort: "out", dstNode: "pt", dstPort: "in" },
      { id: "d1", srcNode: "prop", srcPort: "value", dstNode: "cmp", dstPort: "a" },
      { id: "x1", srcNode: "cmp", srcPort: "result", dstNode: "fsm", dstPort: "condition" },
      { id: "d2", srcNode: "prop", srcPort: "value", dstNode: "cmpBack", dstPort: "a" },
      { id: "x2", srcNode: "cmpBack", srcPort: "result", dstNode: "fsm", dstPort: "condition" },
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
  const host = scene.getObjectByProperty("name", "Host3");

  // a 态：行为树容器（b 态归属）帧钩子停摆 → 不旋转
  advance(handle, 1);
  ok(approx(host.rotation.z, 0, 1e-6), `a 态：嵌套行为树不调度（z=${host.rotation.z.toFixed(3)}rad）`);
  // t≈2.5s 切 b：容器被父级调度，进入跑成员，spin 开始步进
  advance(handle, 2);
  const zAtEnter = host.rotation.z;
  ok(zAtEnter > 0.5, `切 b 后行为树启动（z=${zAtEnter.toFixed(2)}rad，≈90°/s 步进中）`);
  // b 态持续旋转 1s
  advance(handle, 1);
  const zInB = host.rotation.z;
  ok(zInB - zAtEnter > (Math.PI / 2) * 0.9, `b 态持续旋转（+${((zInB - zAtEnter) * 180 / Math.PI).toFixed(0)}°/1s）`);
  // t≈17.5s mover-6 回落穿过 5 → cmpBack（<5, 事件 a）上升沿切回 a：
  // 行为树容器随父级停摆 → 旋转冻结（不恢复也不继续）
  advance(handle, 16);
  const zBackA = host.rotation.z;
  advance(handle, 1.5);
  ok(approx(host.rotation.z, zBackA, 1e-6), `切回 a 后行为树停摆、旋转冻结（1.5s 位移 ${Math.abs(host.rotation.z - zBackA).toExponential(1)}rad）`);
  ok(warnLines().length === 0, `无诊断告警（warns=${warnLines().length}）`);
  handle.dispose();
}

rawOut(passed === 0 && failed === 0 ? "无断言" : `\n场景图运行时冒烟：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
