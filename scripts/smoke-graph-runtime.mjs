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
    infoLines().some((l) => l.includes("脚本图行为已装配") && l.includes("帧驱动器 1")),
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

rawOut(passed === 0 && failed === 0 ? "无断言" : `\n场景图运行时冒烟：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
