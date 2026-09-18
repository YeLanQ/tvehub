// ---------------------------------------------------------------------------
// 场景图（framework/graph + graph-window + runtime kernel）冒烟测试（headless）。
// 场景图是"另外的编辑模式"：层级实体拖入生成原型卡片，匹配节点按标签/类型
// 批量圈定，原子操作/驱动器/容器定义预览运行时执行的行为（不回写场景）。
// 覆盖六段：
// ① 会话模型 + 模块注册表：normalizeGraphDoc 收敛（kind 迁移/unresolved 保留/
//    参数钳制/连线通道/multi 汇聚/注释框/id 生成）、registerModule 注入通道
//    （冲突拒绝/整体替换/注销）、能力位判定、图变量；
// ② 操作目录：原子操作、触发时机固定、缺省参数、摘要；
// ③ 运行时真跑：kernel + 内置 core 模块在 mock 场景上逐语义执行
//    （start/frame/click 链、exec 级联、数据拉模型、循环、容器、驱动器、
//    自定义表达式、unresolved 跳过）+ 拆分后的文件契约字符串；
// ④ 窗口契约：tauri.conf 窗口、capabilities、Hub 入口、graph-main、蒙版；
// ⑤ 工作台契约：store（侧车自动保存/模块指纹/场景索引）、画布（注册表建卡/
//    卡片插槽路由/通用卡）、检查器、预览注入；
// ⑥ 模块注入端到端：注册表 manifest + runtime handler 模块 → kernel 执行。
// 跑法：npm run smoke:graph
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as THREE from "three";
import {
  GRAPH_OP_DEFS,
  canConnectPorts,
  emptyGraphDoc,
  graphOpDefaults,
  graphOpDef,
  graphNodeLabel,
  graphNodePorts,
  graphPort,
  hasNodeTypeCapability,
  isContainerType,
  isGraphDoc,
  listGraphModules,
  moduleOfNodeType,
  nodeTypeDef,
  nodeMenuGroups,
  normalizeGraphDoc,
  nextGraphVariableId,
  registerCustomNodeDefs,
  registerModule,
  unregisterModule,
  type GNode,
  type GPortInfo,
  type ScriptGraphDoc,
  type GCustomNodeDef,
} from "../src/framework/graph";
import { createGraphBehaviors } from "../src/runtime/runtime/graph-behaviors";
import type { GraphRuntimeModule, NodeObj } from "../src/runtime/runtime/graph-runtime";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const port = (id: string, dataType: GPortInfo["dataType"], direction: GPortInfo["direction"]): GPortInfo => ({
  id,
  dataType,
  direction,
});

// ===========================================================================
console.log("① 会话模型与模块注册表");
{
  // ----- 能力位与注册表基础 -----
  check(isContainerType("fsm.container") && isContainerType("bt.container"), "fsm/bt 容器类型（能力位）");
  check(!isContainerType("op.set"), "op.set 非容器");
  check(hasNodeTypeCapability("entity.proto", "entitySource"), "entity.proto 实体集源能力");
  check(hasNodeTypeCapability("event.onTick", "eventEntry"), "event.onTick 事件入口能力");
  check(hasNodeTypeCapability("op.spin", "driver"), "op.spin 驱动器能力（frame 触发）");
  check(!hasNodeTypeCapability("op.set", "driver"), "op.set 非驱动器（start 一次性）");
  check(listGraphModules().some((m) => m.id === "core-op"), "内置 core-op 模块已注册");
  check(moduleOfNodeType("op.spin") === "core-op", "类型归属模块查询");
  check(moduleOfNodeType("op.navMove") === "core-driver", "drive 类型归属 core-driver 模块");

  const doc = normalizeGraphDoc({
    nodes: [
      { id: "a", kind: "proto", x: 0, y: 0, entityId: "ent_1" },
      { id: "b", kind: "nope", x: 0, y: 0 },
      { id: "c", kind: "match", x: 9e9, y: 0, matchMode: "other", matchPattern: "enemy" },
      { id: "d", kind: "op", x: 0, y: 0, opType: "op.spin", params: { speedX: 10, speedY: "x", speedZ: 999 } },
      { id: "e", kind: "op", x: 0, y: 0, opType: "op.nope", params: {} },
    ],
    edges: [
      { id: "e1", srcNode: "a", srcPort: "out", dstNode: "d", dstPort: "in" },
      { id: "e2", srcNode: "a", srcPort: "out", dstNode: "c", dstPort: "in" },
      { id: "e3", srcNode: "d", srcPort: "out", dstNode: "d", dstPort: "in" },
      { id: "e4", srcNode: "a", srcPort: "out", dstNode: "d", dstPort: "exec" },
    ],
    comments: [{ id: "c1", x: 0, y: 0, w: 1, h: 99999, text: "note", color: "zzz" }],
  });
  check(doc.nodes.length === 3, `旧 kind 迁移未知操作仍剔除（实际 ${doc.nodes.length}）`);
  check(doc.nodes[1].matchMode === "tag", "非法匹配模式回退 tag");
  check(doc.nodes[1].x === 20000, "坐标钳制");
  const spin = doc.nodes.find((n) => n.opType === "op.spin");
  check(
    !!spin && spin.params?.speedX === 10 && spin.params?.speedY === 45 && spin.params?.speedZ === 999,
    "操作参数按字段收敛（非数值回退缺省）",
  );
  check(doc.edges.length === 1, `通道不符/自环剔除后剩 1 条（实际 ${doc.edges.length}）`);
  check(doc.edges[0].dstPort === "in", "保留实体集通道连线");

  // ----- unresolved 保留（显式 type 模块未装载） -----
  const uDoc = normalizeGraphDoc({
    nodes: [
      { id: "u1", type: "mymod.op", x: 5, y: 7, entityId: "keep", params: { k: 1 }, containerId: "ghost", title: "保留我" },
      { id: "u2", type: "entity.proto", x: 0, y: 0, entityId: "p1" },
    ],
    edges: [{ id: "ue", srcNode: "u2", srcPort: "out", dstNode: "u1", dstPort: "in" }],
    comments: [],
  });
  check(uDoc.nodes.length === 2, "未知显式类型不静默剔除");
  const un = uDoc.nodes.find((n) => n.id === "u1");
  check(un?.unresolved === true, "未装载类型标记 unresolved");
  check(un?.entityId === "keep" && un?.params?.k === 1 && un?.title === "保留我", "unresolved 节点字段全量留存");
  check(un?.containerId === undefined, "unresolved 幽灵容器归属剔除");
  check(uDoc.edges.length === 0, "unresolved 节点连线不可用（端口未知）");

  // multi 口多入汇聚（路径点巡回）：不同源保留、同源重复保首条
  const multiDoc = normalizeGraphDoc({
    nodes: [
      { id: "mv", type: "entity.proto", x: 0, y: 0, entityId: "mover" },
      { id: "w1", type: "entity.proto", x: 0, y: 0, entityId: "w1" },
      { id: "w2", type: "entity.proto", x: 0, y: 0, entityId: "w2" },
      { id: "pt", type: "op.patrol", x: 0, y: 0, params: {} },
    ],
    edges: [
      { id: "m1", srcNode: "mv", srcPort: "out", dstNode: "pt", dstPort: "path" },
      { id: "m2", srcNode: "w1", srcPort: "out", dstNode: "pt", dstPort: "path" },
      { id: "m3", srcNode: "w2", srcPort: "out", dstNode: "pt", dstPort: "path" },
      { id: "m4", srcNode: "w1", srcPort: "out", dstNode: "pt", dstPort: "path" },
    ],
    comments: [],
  });
  check(multiDoc.edges.length === 3, `multi 口多入保留 3 条（实际 ${multiDoc.edges.length}）`);
  check(doc.comments[0].w === 80 && doc.comments[0].h === 2000, "注释框尺寸钳制");
  check(doc.comments[0].color === "#dcdcaa", "非法颜色回退缺省");

  // ----- formatVersion / modules 元信息透传 -----
  const metaDoc = normalizeGraphDoc({ formatVersion: 7, modules: [{ id: "core-op", version: 2 }, { junk: 1 }], nodes: [], edges: [], comments: [] });
  check(metaDoc.formatVersion === 7, "formatVersion 透传");
  check(metaDoc.modules?.length === 1 && metaDoc.modules?.[0].id === "core-op", "modules 指纹收敛");
  check(emptyGraphDoc().formatVersion === 2, "空白图为当前格式版本");

  check(isGraphDoc({ nodes: [], edges: [] }), "isGraphDoc 接受空图");
  check(!isGraphDoc({}), "isGraphDoc 拒绝非图");

  // ----- registerModule 注入通道（替换语义 + 冲突拒绝） -----
  const okA = registerModule({
    id: "smoke-inject",
    version: 1,
    nodeTypes: [
      {
        type: "smoke.echo",
        category: "op",
        label: "回声",
        desc: "smoke 注入类型",
        color: "#88c0d0",
        inputs: [],
        outputs: [],
        trigger: "start",
        capabilities: { op: true },
      },
    ],
  });
  check(okA, "registerModule 成功");
  check(nodeTypeDef("smoke.echo")?.label === "回声", "注入类型可查");
  check(moduleOfNodeType("smoke.echo") === "smoke-inject", "注入类型归属模块");
  const conflict = registerModule({
    id: "smoke-clash",
    version: 1,
    nodeTypes: [{ type: "op.spin", category: "op", label: "x", desc: "", color: "#000000", inputs: [], outputs: [] }],
  });
  check(!conflict, "类型键冲突整模块拒绝");
  check(nodeTypeDef("op.spin")?.label === "持续旋转", "冲突不破坏原注册");
  registerModule({
    id: "smoke-inject",
    version: 2,
    nodeTypes: [{ type: "smoke.echo2", category: "math", label: "回声2", desc: "", color: "#88c0d0", inputs: [], outputs: [] }],
  });
  check(nodeTypeDef("smoke.echo") === null && !!nodeTypeDef("smoke.echo2"), "同模块重注册整体替换类型");
  unregisterModule("smoke-inject");
  check(nodeTypeDef("smoke.echo2") === null, "unregisterModule 摘除类型");

  // ----- 端口通道表 -----
  const proto: GNode = { id: "p", type: "entity.proto", x: 0, y: 0, entityId: "e" };
  const op: GNode = { id: "o", type: "op.spin", x: 0, y: 0, opType: "op.spin", params: {} };
  check(graphNodePorts(proto).length === 1 && graphNodePorts(proto)[0].dataType === "entities", "原型仅实体集源端口");
  check(graphNodePorts(op).length === 4, "操作节点四端口");
  check(graphPort(op, "in", "in")?.dataType === "entities", "op.in = 实体集入");
  check(graphPort(op, "exec", "in")?.dataType === "exec", "op.exec = 执行链入");
  check(!canConnectPorts(port("out", "entities", "out"), port("exec", "exec", "in")), "实体集 → 执行链拒绝");
  check(canConnectPorts(port("out", "entities", "out"), port("in", "entities", "in")), "实体集 → 实体集");

  const onBegin: GNode = { id: "eb", type: "event.onBegin", x: 0, y: 0 };
  const onClick: GNode = { id: "ec", type: "event.onClick", x: 0, y: 0 };
  check(graphNodePorts(onBegin).length === 1 && graphPort(onBegin, "next", "out")?.dataType === "exec", "onBegin 仅 next(exec) 出端口");
  check(graphNodePorts(onClick).length === 2 && graphPort(onClick, "in", "in")?.dataType === "entities", "onClick 有 in(entities) 入 + next(exec) 出");
  check(canConnectPorts(port("next", "exec", "out"), port("exec", "exec", "in")), "exec → exec 可连");

  check(nodeTypeDef("event.onBegin")?.category === "event", "event.onBegin 注册为 event 类别");
  check(nodeTypeDef("op.spin")?.category === "op", "op.spin 注册为 op 类别");
  const groups = nodeMenuGroups();
  check(groups.some((g) => g.category === "event" && g.items.length === 3), "右键菜单含事件分组（3 个事件节点）");
  const matchN: GNode = { id: "m", type: "entity.match", x: 0, y: 0, matchMode: "tag", matchPattern: "enemy" };
  check(graphNodeLabel(matchN).includes("enemy"), "匹配节点显示名含模式串");
  check(graphNodeLabel({ id: "x", type: "entity.proto", x: 0, y: 0 }, { entityName: () => "Box01" }) === "Box01", "原型显示名取实体名");

  // ----- 变量系统 -----
  const vg: GNode = { id: "vg", type: "var.get", x: 0, y: 0, varId: "v1" };
  const vs: GNode = { id: "vs", type: "var.set", x: 0, y: 0, varId: "v1" };
  check(graphNodePorts(vg).length === 1 && graphPort(vg, "value", "out")?.dataType === "any", "var.get 仅 value(any) 出端口");
  check(graphNodePorts(vs).length === 4, "var.set 四端口（exec入/value入/next出/value出）");
  check(canConnectPorts(port("value", "any", "out"), port("in", "entities", "in")), "any → entities 可连");

  const vDoc = normalizeGraphDoc({
    nodes: [
      { id: "n1", type: "var.get", x: 0, y: 0, varId: "v1" },
      { id: "n2", type: "var.set", x: 0, y: 0, varId: "v_bad" },
    ],
    edges: [],
    comments: [],
    variables: [
      { id: "v1", name: "speed", dataType: "number", value: 42 },
      { id: "v1", name: "dup", dataType: "number", value: 0 },
      { id: "v2", name: "flag", dataType: "boolean", value: true },
      { id: "v4", name: "bad", dataType: "nope", value: 0 },
    ],
  });
  check(vDoc.variables?.length === 4, `变量 id 冲突生成新 id（4 个，实际 ${vDoc.variables?.length}）`);
  check(vDoc.variables?.[2].name === "flag" && vDoc.variables?.[2].value === true, "布尔变量收敛");
  check(vDoc.variables?.[3].dataType === "number", "非法类型回退 number");
  check(vDoc.nodes[0].varId === "v1" && vDoc.nodes[1].varId === "v_bad", "varId 保留（即使引用不存在变量）");
  check(nextGraphVariableId({ variables: [{ id: "v1", name: "a", dataType: "number", value: 0 }] }) === "v2", "nextGraphVariableId 跳过已有");

  const vGroups = nodeMenuGroups();
  check(vGroups.some((g) => g.category === "variable" && g.items.length === 2), "右键菜单含变量分组");
  check(vGroups.some((g) => g.category === "flow" && g.items.length === 5), "右键菜单含控制流分组（5 个节点）");
  check(vGroups.some((g) => g.category === "logic" && g.items.length === 2), "右键菜单含逻辑容器分组");
  check(vGroups.some((g) => g.category === "driver" && g.items.some((i) => i.type === "op.patrol")), "右键菜单含驱动器分组（op.patrol 类别归 driver）");
  const feNode: GNode = { id: "fe", type: "flow.forEach", x: 0, y: 0 };
  check(graphPort(feNode, "item", "out")?.dataType === "entity", "forEach.item = 实体出");

  // ----- 数学/工具节点 -----
  const mathTypes = ["math.add", "math.sub", "math.mul", "math.div", "math.mod", "math.sin", "math.cos", "math.tan", "math.vec3Make", "math.vec3Break", "math.stringConcat", "math.toString", "math.lerp", "math.clamp", "math.abs"];
  for (const mt of mathTypes) {
    check(nodeTypeDef(mt)?.category === "math", `${mt} 注册为 math 类别`);
  }
  const v3m: GNode = { id: "v3m", type: "math.vec3Make", x: 0, y: 0 };
  check(graphPort(v3m, "v", "out")?.dataType === "vec3", "vec3Make.v = 向量出");

  // ----- 自定义节点定义（expression 能力，统一注入通道） -----
  const customDef: GCustomNodeDef = {
    id: "cd1",
    type: "custom.myAdd",
    label: "我的加法",
    desc: "a + b + offset",
    color: "#4ec9b0",
    inputs: [{ id: "a", label: "A", dataType: "number" }, { id: "b", label: "B", dataType: "number" }],
    outputs: [{ id: "result", label: "结果", dataType: "number" }],
    fields: [{ key: "offset", label: "偏移", kind: "number", fallback: 0 }],
    expressions: { result: "a + b + offset" },
  };
  registerCustomNodeDefs([customDef]);
  check(nodeTypeDef("custom.myAdd")?.category === "custom", "自定义节点注册为 custom 类别");
  check(hasNodeTypeCapability("custom.myAdd", "expression"), "自定义节点 expression 能力");
  check(moduleOfNodeType("custom.myAdd") === "custom", "自定义节点归 custom 模块（统一注入通道）");
  const cDoc = normalizeGraphDoc({
    nodes: [
      { id: "cn1", type: "custom.myAdd", x: 0, y: 0, params: { offset: 5 } },
      { id: "cn2", type: "custom.nope", x: 0, y: 0 },
    ],
    edges: [],
    comments: [],
    customNodes: [customDef, { id: "cd1", type: "custom.dup", label: "重复", desc: "", color: "#4ec9b0", inputs: [], outputs: [], fields: [], expressions: {} }],
  });
  check(cDoc.nodes.length === 2, "自定义 normalize：已注册保留 + 未注册 unresolved 保留");
  check(cDoc.nodes.find((n) => n.id === "cn2")?.unresolved === true, "未注册 custom 类型标记 unresolved");
  check(cDoc.customNodes?.length === 2, "自定义节点定义 normalize（id 冲突生成新 id）");
  registerCustomNodeDefs(cDoc.customNodes ?? []);
  check(nodeTypeDef("custom.dup")?.category === "custom", "normalize 后自定义节点已注册");

  check(normalizeGraphDoc(emptyGraphDoc()).nodes.length === 0, "空图合法");
}

// ===========================================================================
console.log("② 操作目录");
{
  const types = GRAPH_OP_DEFS.map((d) => d.type);
  check(new Set(types).size === types.length, "操作类型唯一");
  check(types.includes("op.set") && types.includes("op.spin") && types.includes("op.bob") && types.includes("op.fireFsm") && types.includes("op.setFsmParam") && types.includes("op.toggleVisible"), "六种原子操作齐备");
  check(graphOpDef("op.spin")?.trigger === "frame", "spin = 每帧");
  check(graphOpDef("op.set")?.trigger === "start", "set = 启动时");
  check(graphOpDef("op.toggleVisible")?.trigger === "click", "toggleVisible = 点击时");
  check(graphOpDef("op.fireFsm")?.trigger === "click", "fireFsm = 点击时");
  const defaults = graphOpDefaults("op.spin");
  check(defaults.speedY === 45, "spin.speedY 缺省 45");
  check(Object.keys(graphOpDefaults("op.nope")).length === 0, "未知操作缺省参数为空");
}

// ===========================================================================
console.log("③ 运行时真跑（kernel + core 模块 on mock 场景）");
{
  const fires: { id: string; event: string }[] = [];
  const paramSets: { id: string; key: string; value: number }[] = [];

  /** 假 DOM（addEventListener/getBoundingClientRect + 手动派发） */
  function createFakeDom() {
    const listeners = new Map<string, ((e: unknown) => void)[]>();
    return {
      addEventListener(t: string, fn: (e: unknown) => void) {
        const list = listeners.get(t) ?? [];
        list.push(fn);
        listeners.set(t, list);
      },
      removeEventListener(t: string, fn: (e: unknown) => void) {
        listeners.set(t, (listeners.get(t) ?? []).filter((x) => x !== fn));
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      dispatch(t: string, e: unknown) {
        for (const fn of [...(listeners.get(t) ?? [])]) fn(e);
      },
    };
  }

  /** mock 场景实体（userData 标记 + 可选射线可命中盒子） */
  function makeEntity(id: string, opts: { x?: number; tag?: string; box?: boolean } = {}): THREE.Object3D {
    const obj = opts.box ? new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)) : new THREE.Object3D();
    obj.position.set(opts.x ?? 0, 0, 0);
    obj.userData = { nodeId: id, nodeKind: "mesh", nodeTag: opts.tag ?? "" };
    return obj;
  }

  function boot(
    g: ScriptGraphDoc,
    entities: THREE.Object3D[],
    navApi?: { setAgentPaused(id: string, paused: boolean): void },
    modules: GraphRuntimeModule[] = [],
  ) {
    const scene = new THREE.Scene();
    for (const o of entities) scene.add(o);
    scene.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const dom = createFakeDom();
    const handle = createGraphBehaviors(
      {
        scene,
        dom: dom as unknown as HTMLElement,
        camera,
        logicApi: {
          fire: (entity, event) => fires.push({ id: entity.id, event }),
          setParam: (entity, key, value) => paramSets.push({ id: entity.id, key, value }),
        },
        graph: g,
        navApi,
      },
      modules,
    );
    return { scene, dom, handle };
  }

  /** 快速构造图文档（raw，不经 normalize——运行时按注册表/边表解释） */
  function nd(id: string, type: string, extra: Partial<GNode> = {}): GNode {
    return { id, type, x: 0, y: 0, opType: type.startsWith("op.") ? type : undefined, params: {}, ...extra } as GNode;
  }
  function ed(id: string, srcNode: string, srcPort: string, dstNode: string, dstPort: string): ScriptGraphDoc["edges"][number] {
    return { id, srcNode, srcPort, dstNode, dstPort };
  }
  function doc(
    nodes: GNode[],
    edges: ScriptGraphDoc["edges"] = [],
    variables: ScriptGraphDoc["variables"] = [],
    customNodes: ScriptGraphDoc["customNodes"] = [],
  ): ScriptGraphDoc {
    return { nodes, edges, comments: [], variables, customNodes };
  }
  const APPROX = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) < eps;

  // ----- 旧式 trigger 桥：无 exec 入边的 op.set 启动即执行 -----
  {
    const e1 = makeEntity("e1");
    boot(doc([nd("p", "entity.proto", { entityId: "e1" }), nd("s", "op.set", { params: { property: "position.x", value: 7 } })], [ed("x1", "p", "out", "s", "in")]), [e1]);
    check(e1.position.x === 7, `旧式 start：op.set 装配即执行（x=${e1.position.x}）`);
  }

  // ----- 事件链：onBegin → exec 入边级联 -----
  {
    const e1 = makeEntity("e1");
    boot(
      doc(
        [nd("eb", "event.onBegin"), nd("p", "entity.proto", { entityId: "e1" }), nd("s", "op.set", { params: { property: "position.y", value: 3 } })],
        [ed("a", "p", "out", "s", "in"), ed("b", "eb", "next", "s", "exec")],
      ),
      [e1],
    );
    check(e1.position.y === 3, "onBegin → op.set 链执行");
  }

  // ----- 驱动器：onTick → spin 每帧角速度累计 -----
  {
    const e1 = makeEntity("e1");
    const { handle } = boot(
      doc(
        [nd("et", "event.onTick"), nd("p", "entity.proto", { entityId: "e1" }), nd("sp", "op.spin", { params: { speedY: 90 } })],
        [ed("a", "p", "out", "sp", "in"), ed("b", "et", "next", "sp", "exec")],
      ),
      [e1],
    );
    handle.update(1);
    check(APPROX(e1.rotation.y, Math.PI / 2), `spin 驱动器 90°/s × 1s ≈ π/2（实际 ${e1.rotation.y}）`);
  }

  // ----- 驱动器基准捕获：bob 以 start 落位后为基准（frameOps 装配在 start 之后） -----
  {
    const e1 = makeEntity("e1");
    const { handle } = boot(
      doc(
        [nd("p", "entity.proto", { entityId: "e1" }), nd("s", "op.set", { params: { property: "position.y", value: 10 } }), nd("b", "op.bob", { params: { amplitude: 1, period: 2 } })],
        [ed("a", "p", "out", "s", "in"), ed("c", "p", "out", "b", "in")],
      ),
      [e1],
    );
    handle.update(0.5); // elapsed=0.5 半周期 → sin(π/2)=1 → 基准 10 + 1
    check(APPROX(e1.position.y, 11), `bob 基准位取 start 落位后（实际 ${e1.position.y}）`);
  }

  // ----- 巡逻往返（三角波）；接线矩阵：目标口 = 被移动实体，路径点口 = 路径点 -----
  {
    const e1 = makeEntity("e1");
    const { handle } = boot(
      doc([nd("p", "entity.proto", { entityId: "e1" }), nd("pt", "op.patrol", { params: { distance: 4, speed: 2, axis: "x" } })], [ed("a", "p", "out", "pt", "in")]),
      [e1],
    );
    handle.update(1);
    check(APPROX(e1.position.x, 2), `patrol 1s → +2（实际 ${e1.position.x}）`);
    handle.update(1.5);
    check(APPROX(e1.position.x, 3), `patrol 折返 2.5s → +3（实际 ${e1.position.x}）`);
  }
  {
    // 接线矩阵 A：只连「路径点」不连「目标」——驱动器无被移动对象，静默不动作
    // （用户常见接线错误：把要移动的实体连到了路径点口）
    const e1 = makeEntity("e1");
    const { handle } = boot(
      doc(
        [nd("p", "entity.proto", { entityId: "e1" }), nd("pt", "op.patrol", { params: { distance: 20, speed: 2, axis: "x" } })],
        [ed("a", "p", "out", "pt", "path")],
      ),
      [e1],
    );
    for (let i = 0; i < 120; i++) handle.update(1 / 60);
    check(e1.position.x === 0, `只连路径点无目标：不移动（2s 后 x=${e1.position.x}，目标口为空时驱动器跳过）`);
  }
  {
    // 接线矩阵 B：目标口正确接线 → 轴往返（默认轴 x，起点为首次执行位置）
    const e1 = makeEntity("e1");
    const { handle } = boot(
      doc(
        [nd("p", "entity.proto", { entityId: "e1" }), nd("pt", "op.patrol", { params: { distance: 20, speed: 2, axis: "x" } })],
        [ed("a", "p", "out", "pt", "in")],
      ),
      [e1],
    );
    for (let i = 0; i < 60; i++) handle.update(1 / 60);
    check(APPROX(e1.position.x, 2), `目标口接线 1s → +2（实际 ${e1.position.x}）`);
    for (let i = 0; i < 60 * 19; i++) handle.update(1 / 60);
    check(e1.position.x > 0 && e1.position.x <= 20.001, `长跑始终在 [起点, 起点+20] 内往返（实际 ${e1.position.x}）`);
  }
  {
    // 接线矩阵 D：同一实体同时接目标与路径点——它已在路径点上（距离 0 < 到达阈值），
    // 驱动器判定到达即换下一路径点（单点循环）→ 不移动（退化配置，非 bug）
    const e1 = makeEntity("e1", { x: 5 });
    const { handle } = boot(
      doc(
        [nd("p", "entity.proto", { entityId: "e1" }), nd("pt", "op.patrol", { params: { speed: 2, axis: "x" } })],
        [ed("a", "p", "out", "pt", "in"), ed("b", "p", "out", "pt", "path")],
      ),
      [e1],
    );
    for (let i = 0; i < 60; i++) handle.update(1 / 60);
    check(e1.position.x === 5, `同一实体双接：已在路径点上不移动（x=${e1.position.x}）`);
  }
  {
    // 接线矩阵 C：目标 = 移动者，路径点 = 途经点（waypoint 模式，到点即换下一个）
    const mover = makeEntity("mover");
    const wp = makeEntity("wp", { x: 10 });
    const { handle } = boot(
      doc(
        [nd("pm", "entity.proto", { entityId: "mover" }), nd("pw", "entity.proto", { entityId: "wp" }), nd("pt", "op.patrol", { params: { speed: 2, axis: "x" } })],
        [ed("a", "pm", "out", "pt", "in"), ed("b", "pw", "out", "pt", "path")],
      ),
      [mover, wp],
    );
    handle.update(1);
    check(APPROX(mover.position.x, 2), `waypoint 模式 1s → 朝路径点移动 2（实际 ${mover.position.x}）`);
    for (let i = 0; i < 60 * 5; i++) handle.update(1 / 60);
    check(APPROX(mover.position.x, 10, 0.35), `到点后停在路径点附近（实际 ${mover.position.x}）`);
  }

  // ----- 追击 / 导航移动 -----
  {
    const e1 = makeEntity("e1");
    const prey = makeEntity("prey", { x: 10 });
    const { handle } = boot(
      doc(
        [nd("p", "entity.proto", { entityId: "e1" }), nd("pr", "entity.proto", { entityId: "prey" }), nd("ch", "op.chase", { params: { speed: 3 } })],
        [ed("a", "p", "out", "ch", "in"), ed("b", "pr", "out", "ch", "prey")],
      ),
      [e1, prey],
    );
    handle.update(1);
    check(APPROX(e1.position.x, 3), `chase 1s 速度3 → x=3（实际 ${e1.position.x}）`);
  }
  {
    const e1 = makeEntity("e1");
    const agent = makeEntity("ag", { x: 5 });
    agent.rotation.y = 1.2;
    const { handle } = boot(
      doc(
        [nd("p", "entity.proto", { entityId: "e1" }), nd("ag", "entity.proto", { entityId: "ag" }), nd("nm", "op.navMove", { params: { yOffset: 2 } })],
        [ed("a", "p", "out", "nm", "in"), ed("b", "ag", "out", "nm", "agent")],
      ),
      [e1, agent],
    );
    handle.update(0.016);
    check(e1.position.x === 5 && e1.position.y === 2 && e1.rotation.y === 1.2, "navMove 贴合代理位姿 + 高度偏移");
  }

  // ----- 真实管线集成：raw（旧 kind 形状）→ normalizeGraphDoc → kernel 执行 -----
  {
    const crate = makeEntity("crate-1");
    const g = normalizeGraphDoc({
      nodes: [
        { id: "n1", kind: "proto", x: 0, y: 0, entityId: "crate-1" },
        { id: "n2", kind: "op", x: 200, y: 0, opType: "op.patrol", params: { distance: 20, speed: 2, axis: "x" } },
      ],
      edges: [{ id: "e1", srcNode: "n1", srcPort: "out", dstNode: "n2", dstPort: "in" }],
      comments: [],
    });
    check(g.nodes.length === 2 && g.edges.length === 1, "集成：收敛保留原型/巡逻与目标连线");
    const { handle } = boot(g, [crate]);
    for (let i = 0; i < 60; i++) handle.update(1 / 60);
    check(APPROX(crate.position.x, 2), `集成：normalize → kernel 巡逻 1s → +2（实际 ${crate.position.x}）`);
  }
  {
    // 实体缺失：控制台输出原型缺失告警，不 crash（诊断链路可用）
    const g = normalizeGraphDoc({
      nodes: [
        { id: "p", type: "entity.proto", x: 0, y: 0, entityId: "ghost" },
        { id: "pt", type: "op.patrol", x: 0, y: 0, params: {} },
      ],
      edges: [{ id: "e", srcNode: "p", srcPort: "out", dstNode: "pt", dstPort: "in" }],
      comments: [],
    });
    let crashed = false;
    try {
      boot(g, []);
    } catch {
      crashed = true;
    }
    check(!crashed, "实体缺失：不 crash（原型缺失告警经控制台回传）");
  }

  // ----- 点击射线（旧式 click op + onClick 事件链） -----
  {
    const e1 = makeEntity("e1", { box: true });
    const { dom, handle } = boot(
      doc([nd("p", "entity.proto", { entityId: "e1" }), nd("tv", "op.toggleVisible")], [ed("a", "p", "out", "tv", "in")]),
      [e1],
    );
    dom.dispatch("pointerdown", { clientX: 50, clientY: 50 });
    check(e1.visible === false, "指针射线命中 → toggleVisible 翻转");
    dom.dispatch("pointerdown", { clientX: 50, clientY: 50 });
    check(e1.visible === true, "再点翻转回");
    handle.dispose();
    dom.dispatch("pointerdown", { clientX: 50, clientY: 50 });
    check(e1.visible === true, "dispose 后不再响应");
  }
  {
    // onClick 事件链：命中 → 下游 op.fireFsm（显式命中项 + 链级联，与旧实现双路一致）
    const e1 = makeEntity("e1", { box: true });
    fires.length = 0;
    const { dom } = boot(
      doc(
        [nd("ec", "event.onClick"), nd("p", "entity.proto", { entityId: "e1" }), nd("ff", "op.fireFsm", { params: { event: "hit" } })],
        [ed("a", "p", "out", "ec", "in"), ed("b", "ec", "next", "ff", "exec")],
      ),
      [e1],
    );
    dom.dispatch("pointerdown", { clientX: 50, clientY: 50 });
    check(fires.some((f) => f.id === "e1" && f.event === "hit"), `onClick 命中级联 fireFsm（fires=${fires.length}）`);
  }

  // ----- 拉模型数据流：var.set ← var.get；branch ← compare；消费落位 -----
  {
    const e1 = makeEntity("e1");
    boot(
      doc(
        [
          nd("eb", "event.onBegin"),
          nd("vget", "var.get", { varId: "v1" }),
          nd("vset", "var.set", { varId: "v2" }),
          nd("cmp", "flow.compare", { params: { operator: ">", b: 5 } }),
          nd("br", "flow.branch"),
          nd("p", "entity.proto", { entityId: "e1" }),
          nd("s", "op.set", { params: { property: "position.z", value: 42 } }),
        ],
        [
          ed("a", "eb", "next", "vset", "exec"),
          ed("b", "vget", "value", "vset", "value"),
          ed("c", "vset", "next", "br", "exec"),
          ed("d", "vget", "value", "cmp", "a"),
          ed("e", "cmp", "result", "br", "condition"),
          ed("f", "br", "true", "s", "exec"),
          ed("g", "p", "out", "s", "in"),
        ],
        [{ id: "v1", name: "speed", dataType: "number", value: 10 }, { id: "v2", name: "copy", dataType: "number", value: 0 }],
      ),
      [e1],
    );
    check(e1.position.z === 42, "branch true 分支（compare 拉取 var.get=10 > 5）执行下游 op.set");
  }

  // ----- var.set 写入回读 -----
  {
    const e1 = makeEntity("e1");
    fires.length = 0;
    boot(
      doc(
        [nd("eb", "event.onBegin"), nd("vg1", "var.get", { varId: "v1" }), nd("vs", "var.set", { varId: "v2" }), nd("vg2", "var.get", { varId: "v2" }), nd("cmp", "flow.compare", { params: { operator: ">", b: 5 } }), nd("br", "flow.branch"), nd("p", "entity.proto", { entityId: "e1" }), nd("ff", "op.fireFsm", { params: { event: "copied" } })],
        [
          ed("1", "eb", "next", "vs", "exec"),
          ed("2", "vg1", "value", "vs", "value"),
          ed("3", "vs", "next", "br", "exec"),
          ed("4", "vg2", "value", "cmp", "a"),
          ed("5", "cmp", "result", "br", "condition"),
          ed("6", "br", "true", "ff", "exec"),
          ed("7", "p", "out", "ff", "in"),
        ],
        [{ id: "v1", name: "a", dataType: "number", value: 9 }, { id: "v2", name: "b", dataType: "number", value: 0 }],
      ),
      [e1],
    );
    check(fires.some((f) => f.event === "copied"), "var.set 写入 → var.get 回读（9 > 5 真分支）");
  }

  // ----- flow.for 循环体 ×N -----
  {
    const e1 = makeEntity("e1");
    fires.length = 0;
    boot(
      doc(
        [nd("eb", "event.onBegin"), nd("f", "flow.for", { params: { start: 0, end: 3, step: 1 } }), nd("p", "entity.proto", { entityId: "e1" }), nd("ff", "op.fireFsm", { params: { event: "tick" } })],
        [ed("a", "eb", "next", "f", "exec"), ed("b", "f", "loop", "ff", "exec"), ed("c", "p", "out", "ff", "in")],
      ),
      [e1],
    );
    check(fires.length === 3 && fires.every((x) => x.id === "e1" && x.event === "tick"), `for 循环体执行 3 次（实际 ${fires.length}）`);
  }

  // ----- flow.forEach 遍历匹配实体集 -----
  {
    const e1 = makeEntity("e1", { tag: "mob" });
    const e2 = makeEntity("e2", { tag: "other" });
    fires.length = 0;
    boot(
      doc(
        [nd("eb", "event.onBegin"), nd("fe", "flow.forEach"), nd("m", "entity.match", { matchMode: "tag", matchPattern: "mob" }), nd("ff", "op.fireFsm", { params: { event: "each" } })],
        [ed("a", "eb", "next", "fe", "exec"), ed("b", "m", "out", "fe", "array"), ed("c", "fe", "loop", "ff", "exec"), ed("d", "m", "out", "ff", "in")],
      ),
      [e1, e2],
    );
    check(fires.length === 1 && fires[0].id === "e1", `forEach 遍历匹配实体（tag=mob 命中 1，实际 ${fires.length}）`);
  }

  // ----- flow.while 条件即假 → completed 分支 -----
  {
    const e1 = makeEntity("e1");
    fires.length = 0;
    boot(
      doc(
        [nd("eb", "event.onBegin"), nd("wh", "flow.while"), nd("cmp", "flow.compare", { params: { operator: ">", b: 100 } }), nd("p", "entity.proto", { entityId: "e1" }), nd("ff", "op.fireFsm", { params: { event: "done" } })],
        [ed("a", "eb", "next", "wh", "exec"), ed("b", "cmp", "result", "wh", "condition"), ed("c", "wh", "completed", "ff", "exec"), ed("d", "p", "out", "ff", "in")],
      ),
      [e1],
    );
    check(fires.length === 1 && fires[0].event === "done", "while 假条件 → completed 级联");
  }

  // ----- 数学链：math.mul → compare → branch -----
  {
    const e1 = makeEntity("e1");
    fires.length = 0;
    boot(
      doc(
        [
          nd("eb", "event.onBegin"),
          nd("vg", "var.get", { varId: "v1" }),
          nd("vg2", "var.get", { varId: "v2" }),
          nd("mul", "math.mul"),
          nd("cmp", "flow.compare", { params: { operator: ">=", b: 42 } }),
          nd("br", "flow.branch"),
          nd("p", "entity.proto", { entityId: "e1" }),
          nd("ff", "op.fireFsm", { params: { event: "math" } }),
        ],
        [
          ed("a", "eb", "next", "br", "exec"),
          ed("b", "vg", "value", "mul", "a"),
          ed("g", "vg2", "value", "mul", "b"),
          ed("c", "mul", "result", "cmp", "a"),
          ed("d", "cmp", "result", "br", "condition"),
          ed("e", "br", "true", "ff", "exec"),
          ed("f", "p", "out", "ff", "in"),
        ],
        [{ id: "v1", name: "n", dataType: "number", value: 21 }, { id: "v2", name: "m", dataType: "number", value: 2 }],
      ),
      [e1],
    );
    check(fires.length === 1 && fires[0].event === "math", "math.mul(21×2=42) ≥ 42 → 真分支");
  }

  // ----- 自定义节点表达式（doc.customNodes → 编译求值） -----
  {
    const e1 = makeEntity("e1");
    fires.length = 0;
    const dblDef: GCustomNodeDef = {
      id: "cd1",
      type: "custom.dbl",
      label: "翻倍",
      desc: "",
      color: "#4ec9b0",
      inputs: [{ id: "a", label: "A", dataType: "number" }],
      outputs: [{ id: "result", label: "结果", dataType: "number" }],
      fields: [],
      expressions: { result: "a * 2" },
    };
    boot(
      doc(
        [
          nd("eb", "event.onBegin"),
          nd("vg", "var.get", { varId: "v1" }),
          nd("cst", "custom.dbl"),
          nd("vs", "var.set", { varId: "v2" }),
          nd("vg2", "var.get", { varId: "v2" }),
          nd("cmp", "flow.compare", { params: { operator: ">=", b: 42 } }),
          nd("br", "flow.branch"),
          nd("p", "entity.proto", { entityId: "e1" }),
          nd("ff", "op.fireFsm", { params: { event: "expr" } }),
        ],
        [
          ed("a", "eb", "next", "vs", "exec"),
          ed("b", "vg", "value", "cst", "a"),
          ed("c", "cst", "result", "vs", "value"),
          ed("d", "vs", "next", "br", "exec"),
          ed("e", "vg2", "value", "cmp", "a"),
          ed("f", "cmp", "result", "br", "condition"),
          ed("g", "br", "true", "ff", "exec"),
          ed("h", "p", "out", "ff", "in"),
        ],
        [{ id: "v1", name: "n", dataType: "number", value: 21 }, { id: "v2", name: "d", dataType: "number", value: 0 }],
        [dblDef],
      ),
      [e1],
    );
    check(fires.length === 1 && fires[0].event === "expr", "custom.dbl 表达式 21×2=42 → var.set → 真分支");
  }

  // ----- fsm 容器：event 入口切换（事件名 = 链上游节点 params.event） -----
  {
    const e1 = makeEntity("e1");
    fires.length = 0;
    boot(
      doc(
        [
          nd("eb", "event.onBegin"),
          nd("cmp", "flow.compare", { params: { operator: ">", b: -1, event: "run" } }),
          nd("c", "fsm.container", { params: { states: "idle,run", initial: "idle" } }),
          nd("p", "entity.proto", { entityId: "e1" }),
          nd("child", "op.fireFsm", { containerId: "c", stateName: "run", params: { event: "entered" } }),
        ],
        [
          ed("a", "eb", "next", "cmp", "exec"),
          ed("g", "cmp", "next", "c", "event"), // compare 透传 fireEv（params.event="run"）
          ed("b", "p", "out", "c", "in"),
          ed("d", "p", "out", "child", "in"),
        ],
      ),
      [e1],
    );
    check(fires.length === 1 && fires[0].event === "entered", `fsm event 口切换到 run 执行归属子链（实际 fires=${fires.length}）`);
  }
  {
    // 进入 initial idle → run 归属子链不执行；条件边首帧仅记基线不切换
    const e1 = makeEntity("e1");
    fires.length = 0;
    const { handle } = boot(
      doc(
        [
          nd("eb", "event.onBegin"),
          nd("c", "fsm.container", { params: { states: "idle,run", initial: "idle" } }),
          nd("p", "entity.proto", { entityId: "e1" }),
          nd("child", "op.fireFsm", { containerId: "c", stateName: "run", params: { event: "entered" } }),
          nd("cmp", "flow.compare", { params: { operator: ">", b: -1, event: "run" } }),
        ],
        [
          ed("a", "eb", "next", "c", "exec"),
          ed("b", "p", "out", "c", "in"),
          ed("d", "p", "out", "child", "in"),
          ed("e", "cmp", "result", "c", "event"),
        ],
      ),
      [e1],
    );
    check(fires.length === 0, "idle 状态：run 归属子链不执行");
    handle.update(0.016);
    handle.update(0.016);
    check(fires.length === 0, "条件恒真无上升沿：不切换（基线帧不触发）");
  }

  // ----- bt 容器：按子节点顺序执行 -----
  {
    const e1 = makeEntity("e1");
    fires.length = 0;
    paramSets.length = 0;
    boot(
      doc(
        [
          nd("eb", "event.onBegin"),
          nd("c", "bt.container", { params: { mode: "sequence" } }),
          nd("p", "entity.proto", { entityId: "e1" }),
          nd("a", "op.fireFsm", { containerId: "c", params: { event: "A" } }),
          nd("b", "op.setFsmParam", { containerId: "c", params: { param: "hp", value: 5 } }),
        ],
        [ed("x", "eb", "next", "c", "exec"), ed("y", "p", "out", "a", "in"), ed("z", "p", "out", "b", "in")],
      ),
      [e1],
    );
    check(fires.length === 1 && paramSets.length === 1 && paramSets[0].key === "hp", "bt 容器按子节点顺序执行归属链");
  }

  // ----- fsm 激活状态内的驱动器步进（容器 frame 钩子） -----
  {
    const e1 = makeEntity("e1");
    const { handle } = boot(
      doc(
        [
          nd("eb", "event.onBegin"),
          nd("c", "fsm.container", { params: { states: "go", initial: "go" } }),
          nd("p", "entity.proto", { entityId: "e1" }),
          nd("pt", "op.patrol", { containerId: "c", stateName: "go", params: { distance: 4, speed: 2, axis: "x" } }),
        ],
        [ed("a", "eb", "next", "c", "exec"), ed("b", "p", "out", "pt", "in")],
      ),
      [e1],
    );
    handle.update(1);
    check(APPROX(e1.position.x, 2), `fsm 激活状态内 patrol 步进（实际 ${e1.position.x}）`);
  }

  // ----- 追击联动导航暂停（fsm 状态内 chase） -----
  {
    const e1 = makeEntity("e1");
    const prey = makeEntity("prey", { x: 10 });
    const navCalls: { id: string; paused: boolean }[] = [];
    const { handle } = boot(
      doc(
        [
          nd("eb", "event.onBegin"),
          nd("c", "fsm.container", { params: { states: "hunt", initial: "hunt" } }),
          nd("p", "entity.proto", { entityId: "e1" }),
          nd("pr", "entity.proto", { entityId: "prey" }),
          nd("ch", "op.chase", { containerId: "c", stateName: "hunt", params: { speed: 3 } }),
        ],
        [ed("a", "eb", "next", "c", "exec"), ed("b", "p", "out", "ch", "in"), ed("d", "pr", "out", "ch", "prey")],
      ),
      [e1, prey],
      { setAgentPaused: (id, paused) => navCalls.push({ id, paused }) },
    );
    handle.update(0.5);
    check(navCalls.some((c) => c.id === "e1" && c.paused === true), "激活状态 chase 步进 → 目标导航巡回暂停");
  }

  // ----- unresolved 节点安全跳过 -----
  {
    const e1 = makeEntity("e1");
    let crashed = false;
    try {
      boot(
        doc(
          [nd("u", "ghostmod.op", { unresolved: true }), nd("eb", "event.onBegin"), nd("p", "entity.proto", { entityId: "e1" }), nd("s", "op.set", { params: { property: "position.x", value: 9 } })],
          [ed("a", "eb", "next", "u", "exec"), ed("b", "eb", "next", "s", "exec"), ed("c", "p", "out", "s", "in")],
        ),
        [e1],
      );
    } catch {
      crashed = true;
    }
    check(!crashed && e1.position.x === 9, "unresolved 节点跳过不 crash，正常链路仍执行");
  }

  // ----- 文件契约（拆分后的运行时结构） -----
  const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf-8");
  const beh = read("src/runtime/runtime/graph-behaviors.ts");
  check(beh.includes("createGraphBehaviors"), "解释器门面导出 createGraphBehaviors");
  check(beh.includes("createGraphKernel") && beh.includes("createCoreGraphModules"), "门面装配 kernel + core 模块（modules 注入参数）");
  const kern = read("src/runtime/runtime/graph-kernel.ts");
  check(kern.includes("nodeTag") && kern.includes("nodeKind") && kern.includes("nodeId"), "kernel 按 userData 标签/类型/id 匹配");
  check(kern.includes("pointerdown") && kern.includes("Raycaster"), "kernel 点击行为走指针射线");
  check(kern.includes("update(dt"), "kernel 每帧推进");
  check(kern.includes("cascadeExec") && kern.includes("execNextOf"), "kernel exec 链级联");
  check(kern.includes("hasExecInput") && kern.includes("legacyOps"), "旧式 trigger 兼容在 kernel");
  check(kern.includes("evalDataOutput") && kern.includes("evalDataInput"), "数据流拉模型求值引擎");
  check(kern.includes("varStore"), "图变量存储");
  check(kern.includes("driverInst") && kern.includes("boot?.("), "驱动器实例缓存 + 基准捕获");
  check(kern.includes("eventEntry") && kern.includes("hasNodeTypeCapability"), "kernel 按能力位分发（无类型键特判）");
  const rt = read("src/runtime/runtime/graph-runtime.ts");
  check(rt.includes("GraphRuntimeModule") && rt.includes("OpExecutor") && rt.includes("DriverFactory"), "契约：模块/op/驱动 handler 接口");
  const core = read("src/runtime/runtime/graph-core-modules.ts");
  check(core.includes('"var.set"') && core.includes('"flow.branch"') && core.includes('"flow.for"') && core.includes('"flow.forEach"') && core.includes('"flow.while"'), "执行链路由语义在 core-exec 模块");
  check(core.includes("logicApi") && core.includes(".fire(") && core.includes(".setParam("), "FSM 操作经 engine.logic 语义（core-ops）");
  check(core.includes('"op.spin"') && core.includes('"op.bob"') && core.includes('"op.patrol"') && core.includes('"op.chase"') && core.includes('"op.navMove"'), "驱动器语义在 core-drivers");
  check(core.includes("math.vec3Make") && core.includes("math.stringConcat") && core.includes("sense.distance"), "数学/感知求值在 core-data");
  check(core.includes("customExprCache") && core.includes("new Function"), "自定义节点表达式编译缓存");
  check(core.includes("fsmCurrent") && core.includes("fsmCondState") && core.includes("navPausedTargets"), "FSM 容器状态在 core-containers");
  check(core.includes("entity.proto") && core.includes("entity.match"), "实体集源解析在 core-entity");
  const player = read("public/web-preview/player.mjs");
  check(player.includes("engine/runtime/graph-behaviors.mjs"), "player 导入解释器");
  check(player.includes("cfg.scriptGraph") && player.includes("script-graph.json"), "player 按 config.scriptGraph 装配注入文档");
  check(player.includes("graphBehaviors.update(dt)"), "player 每帧推进行为");
  check(player.includes("graphBehaviors.dispose()"), "player 卸载时清理行为");
  check(player.includes("scriptGraphModules"), "player 支持注入式图模块（L1 通道）");
}

// ===========================================================================
console.log("④ 窗口契约");
{
  const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf-8");

  // 多会话窗口架构：graph-N 动态创建（WebviewWindowBuilder 隐藏建窗，前端布防后
  // 主动 show），关闭即销毁；不再使用 tauri.conf 静态隐藏窗口
  const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as {
    app: { windows: { label: string; url: string }[] };
  };
  check(!conf.app.windows.some((w) => w.label === "graph"), "graph 窗口为动态创建（静态窗口表无 graph）");

  const cap = JSON.parse(read("src-tauri/capabilities/default.json")) as {
    windows: string[];
    permissions: string[];
  };
  check(cap.windows.includes("graph") || cap.windows.includes("*"), "capabilities：graph 窗口已授权（精确或通配）");
  check(cap.permissions.includes("core:window:allow-hide"), "capabilities：窗口 hide 权限在授权表");

  const lib = read("src-tauri/src/lib.rs");
  check(lib.includes("async fn show_window_with_project") && lib.includes("show_window_with_project,"), "lib.rs show_window_with_project 统一命令与注册");
  check(lib.includes('WebviewUrl::App("graph.html".into())') && lib.includes(".visible(false)") && lib.includes("graph-"), "lib.rs graph-N 动态建窗（隐藏，前端揭幕）");
  check(lib.includes("WINDOW_LIFECYCLE"), "lib.rs 声明式窗口生命周期表");

  const sceneMod = read("src-tauri/src/scene/mod.rs");
  check(
    sceneMod.includes("sessions: std::collections::HashMap<SessionKey, SessionCore>") && sceneMod.includes("current: std::collections::HashMap<String, SessionKey>"),
    "后端：会话按 (root,rel) 复合键分键 + 各窗口当前指针",
  );
  check(
    sceneMod.includes("webview: tauri::Webview,") && !sceneMod.includes("tauri::WebviewWindow"),
    "后端：命令参数用可注入的 tauri::Webview（WebviewWindow 无法注入会导致运行时全失败）",
  );

  const launch = read("src/app/lib/graph-launch.ts");
  check(launch.includes("handoffToWindow") && launch.includes("graph-"), "Hub 侧打开助手（graph-N 统一窗口交接 handoffToWindow）");
  const projects = read("src/app/components/home/ProjectsSection.vue");
  check(projects.includes("openScriptGraphWindow") && projects.includes("打开场景图"), "项目卡片菜单「打开场景图」");

  check(read("graph.html").includes("src/graph-main.ts"), "graph.html 入口");
  const gmain = read("src/graph-main.ts");
  check(
    gmain.includes("window:project-open") && gmain.includes("takePendingProject") && gmain.includes("getGraphBootStore().standby()"),
    "graph-main 统一交接事件 + 冷启动拉取 + 蒙版布防",
  );
  check(!gmain.includes("getCurrentWindow().show"), "graph-main 不自行显示窗口（由 show_window_with_project 控制）");
  const mask = read("src/graph-window/components/GraphBootMask.vue");
  check(mask.includes("boot-mask") && mask.includes("TVE <span>GRAPH</span>"), "装载蒙版复用编辑器 boot-mask 视觉");

  const toolbar = read("src/app/components/Toolbar.vue");
  check(!toolbar.includes("场景图"), "编辑器工具栏未加场景图入口");
}

// ===========================================================================
console.log("⑤ 工作台契约");
{
  const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf-8");

  const store = read("src/graph-window/graphStore.ts");
  check(
    store.includes("sidecarRel") && store.includes("graph/") && store.includes(".graph") && store.includes("writeText"),
    "store：图会话 graph/ 目录自动保存（.graph 后缀）",
  );
  check(
    store.includes("fetchSceneEntities") && store.includes("markGraphDirty") && store.includes("flushGraph"),
    "store：场景实体索引/脏标记/卸载冲刷",
  );
  check(store.includes("async openScene(rel)") && store.includes("sceneApi.open"), "store：双击场景资产 → openScene 切当前场景");
  check(
    store.includes("docModuleRefs") && store.includes("GRAPH_FORMAT_VERSION") && store.includes("moduleOfNodeType"),
    "store：自动保存写 formatVersion + 节点引用模块指纹",
  );
  check(store.includes("registerCustomNodeDefs"), "store：自定义节点注册表同步");

  const canvas = read("src/graph-window/components/GraphCanvas.vue");
  check(
    canvas.includes("#node-gproto") && canvas.includes("#node-gmatch") && canvas.includes("#node-gop") && canvas.includes("#node-gcomment") && canvas.includes("#node-gvar") && canvas.includes("#node-gcard"),
    "画布：类型卡 + 通用卡插槽",
  );
  check(canvas.includes("application/x-tve-entity") && canvas.includes("addProto"), "画布：层级拖入生成原型");
  check(canvas.includes("is-valid-connection") && canvas.includes("requestSnapshot"), "画布：连线校验/会话快照");
  check(canvas.includes("dp?.multi"), "画布：multi 入端口追加连线");
  check(canvas.includes("addNode(") && canvas.includes("nodeDefaults") && canvas.includes("CONTAINER_DEFAULT_SIZE"), "画布：注册表驱动统一建卡入口（addNode）");
  check(canvas.includes("buildAddGroups") && canvas.includes("nodeMenuGroups"), "画布：右键菜单 nodeMenuGroups 全量驱动");
  check(canvas.includes("cardSlotFor") && !canvas.includes("flowNodeType"), "画布：插槽路由收敛到 card-registry");

  const registry = read("src/graph-window/lib/card-registry.ts");
  check(registry.includes("registerCardSlot") && registry.includes("cardSlotFor") && registry.includes("GRAPH_GENERIC_SLOT"), "卡片注册表：类型/类别 → 插槽三级路由");

  const generic = read("src/graph-window/components/GraphGenericCard.vue");
  check(generic.includes("nodeTypeDef") && generic.includes("unresolved") && generic.includes("Handle"), "通用卡：注册表驱动端口渲染 + unresolved 缺失态");

  const inspector = read("src/graph-window/components/NodeInspector.vue");
  check(
    inspector.includes("sceneEntities") && inspector.includes("commitParam") && inspector.includes("G_OP_TRIGGER_LABEL"),
    "检查器：实体属性参照/操作参数表/触发徽标",
  );
  check(inspector.includes("varDef") && inspector.includes("commitVarId") && inspector.includes("graphVariables"), "检查器：变量节点面板");
  check(inspector.includes("flowDef") && inspector.includes("commitFlowParam") && inspector.includes("G_COMPARE_OPERATORS"), "检查器：控制流面板");

  const preview = read("src/graph-window/components/GraphPreview.vue");
  check(
    preview.includes("script-graph.json") && preview.includes("scriptGraph") && preview.includes("exportWebPreviewFromScene"),
    "预览：注入场景图文档 + config 标记",
  );
  const hierarchy = read("src/graph-window/components/GraphHierarchy.vue");
  check(hierarchy.includes("dragstart") && hierarchy.includes("addProto"), "层级：行拖入生成原型");
  const docks = read("src/graph-window/docks.ts");
  check(docks.includes("tve:graph:dock-layout:v2") && docks.includes("createDockSystem"), "dock：图窗口布局实例（v2：面板集变更后重置新默认）");
  check(docks.includes('"console"') && docks.includes("控制台"), "dock：控制台面板注册");
  check(docks.includes('assets: "场景"'), "dock：资产面板收敛为「场景」");
  check(
    docs_bottom_side_by_side(docks),
    "dock：控制台与场景默认同处底部停靠区（并排页签）",
  );
  // 布局装载：新面板落其默认停靠区（而非旧兜底左区），保证与默认相邻关系一致
  const dockFactory2 = read("src/docks/create-docks.ts");
  check(
    dockFactory2.includes("DOCK_ZONES.find((z) => d.zones[z].includes(p))") && dockFactory2.includes("defaultIdx"),
    "dock：装载旧布局时新面板按默认停靠区/顺序插入",
  );

  function docs_bottom_side_by_side(src: string): boolean {
    const zone = src.match(/bottom:\s*\[([^\]]*)\]/)?.[1] ?? "";
    return zone.includes('"console"') && zone.includes('"assets"');
  }

  // 资产面板只呈现场景（场景文件 + 通往场景的目录；无类型筛选；筛选状态不同步类型）
  const assetsPanel = read("src/graph-window/components/GraphAssets.vue");
  check(assetsPanel.includes("sceneAssets") && assetsPanel.includes('a.kind === "scene"'), "资产面板：只呈现场景资产");
  check(assetsPanel.includes(':show-type-filter="false"') && !assetsPanel.includes("typeFilter.value = f.typeFilter"), "资产面板：隐藏类型筛选且不被编辑器筛选状态覆盖");
  const toolbarSrc = read("src/app/components/AssetToolbar.vue");
  check(toolbarSrc.includes("showTypeFilter?: boolean") && toolbarSrc.includes('v-if="showTypeFilter !== false"'), "工具栏：类型筛选可选隐藏（编辑器缺省仍显示）");

  // 控制台 dock：引擎日志通道（postLog）→ 预览 iframe 转发 → logStore
  const graphApp = read("src/graph-window/GraphApp.vue");
  check(graphApp.includes("ConsolePanel") && graphApp.includes("console: ConsolePanel"), "工作区：控制台面板接入停靠区");
  const gPreview = read("src/graph-window/components/GraphPreview.vue");
  check(
    gPreview.includes("__editorPreviewLog") && gPreview.includes("logStore.log") && gPreview.includes("onPreviewLog"),
    "预览：引擎日志（postLog 转发）落控制台",
  );
  check(!gPreview.includes("console.log"), "预览：日志走引擎通道而非 console");

  // 运行时诊断统一走引擎日志出口（不与 console 混用）
  const kernelSrc = read("src/runtime/runtime/graph-kernel.ts");
  check(kernelSrc.includes('from "../core/log"') && kernelSrc.includes("postLog("), "kernel：诊断日志走引擎日志通道 postLog");
  check(!/console\.(log|warn)\(/.test(kernelSrc), "kernel：无 console 直写（引擎通道单一出口）");

  // 旧资产化路线确已移除
  const logic = read("src-tauri/src/scene/logic_assets.rs");
  check(!logic.includes("scriptgraph"), "Rust 无 scriptgraph 资产命令");
  const api = read("src/lib/api.ts");
  check(!api.includes("scriptGraphWrite") && !api.includes("scriptgraph_write"), "api.ts 无图资产门面");
}

// ===========================================================================
console.log("⑥ 模块注入端到端（manifest + runtime handler）");
{
  const ok = registerModule({
    id: "smoke-e2e",
    version: 1,
    nodeTypes: [
      {
        type: "smoke-e2e.flag",
        category: "op",
        label: "打标记",
        desc: "smoke 注入原子操作",
        color: "#4ec9b0",
        inputs: [
          { id: "in", label: "目标", direction: "in", dataType: "entities", multi: true },
          { id: "exec", label: "", direction: "in", dataType: "exec" },
        ],
        outputs: [],
        trigger: "start",
        capabilities: { op: true },
      },
    ],
  });
  check(ok, "注入模块注册成功");
  check(nodeMenuGroups().some((g) => g.category === "op" && g.items.some((i) => i.type === "smoke-e2e.flag")), "注入类型进右键菜单");

  const e1 = new THREE.Object3D();
  e1.userData = { nodeId: "ee1", nodeKind: "mesh", nodeTag: "" };
  const flagged = new Set<string>();
  const handler: GraphRuntimeModule = {
    id: "smoke-e2e",
    ops: {
      "smoke-e2e.flag": (_k, _node, targets: NodeObj[]) => {
        for (const t of targets) flagged.add(t.id);
      },
    },
  };
  const scene = new THREE.Scene();
  scene.add(e1);
  scene.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.updateMatrixWorld(true);
  const dom = {
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }),
  };
  const docGraph: ScriptGraphDoc = {
    nodes: [
      { id: "p", type: "entity.proto", x: 0, y: 0, entityId: "ee1", params: {} },
      { id: "f", type: "smoke-e2e.flag", x: 0, y: 0, opType: "smoke-e2e.flag", params: {} },
    ],
    edges: [{ id: "e", srcNode: "p", srcPort: "out", dstNode: "f", dstPort: "in" }],
    comments: [],
  };
  createGraphBehaviors(
    { scene, dom: dom as unknown as HTMLElement, camera, logicApi: { fire() {}, setParam() {} }, graph: docGraph },
    [handler],
  );
  check(flagged.has("ee1"), "注入模块 handler 在 start 装配期执行（legacy trigger 路径）");
  unregisterModule("smoke-e2e");
  check(nodeTypeDef("smoke-e2e.flag") === null, "注入模块注销后类型回落未知");
}

// ===========================================================================
console.log(passed === 0 && failed === 0 ? "无断言" : `\n${passed} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
