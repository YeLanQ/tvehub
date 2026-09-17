// ---------------------------------------------------------------------------
// 脚本图（framework/graph + graph-window）冒烟测试（headless，无需 GPU）。
// 脚本图是"另外的编辑模式"：层级实体拖入生成原型卡片，匹配节点按标签/类型
// 批量圈定，原子操作节点定义预览运行时执行的行为（不回写场景、无图资产）。
// 覆盖五段：
// ① 会话模型：normalizeGraphDoc 收敛（kind/未知操作剔除/参数钳制/连线通道/
//    自环/入端口唯一/注释框钳制）、id 生成、端口通道表；
// ② 操作目录：六种原子操作、触发时机固定、缺省参数、摘要；
// ③ 运行时契约：graph-behaviors 解释器（userData 匹配/交互/每帧）、
//    player.mjs 注入钩子（config.scriptGraph → 装配 → update → dispose）；
// ④ 窗口契约：tauri.conf 窗口、capabilities 授权、Hub 入口（graph-launch /
//    ProjectsSection）、graph.html/graph-main（布防/握手/不自行 show）、蒙版；
// ⑤ 工作台：store（侧车自动保存/场景索引/无图资产）、画布（三卡片/拖入/
//    校验）、检查器、预览注入；并断言旧资产化路线（scriptgraph_write/.graph
//    资产/保存按钮）确已移除。
// 跑法：npm run smoke:graph
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GRAPH_OP_DEFS,
  canConnectPorts,
  emptyGraphDoc,
  graphOpDefaults,
  graphOpDef,
  graphNodeLabel,
  graphNodePorts,
  graphPort,
  isGraphDoc,
  normalizeGraphDoc,
  nodeTypeDef,
  nodeMenuGroups,
  nextGraphVariableId,
  registerCustomNodeDefs,
  type GNode,
  type GPortInfo,
  type GVariable,
  type GCustomNodeDef,
} from "../src/framework/graph";

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
console.log("① 会话模型");
{
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
  check(doc.nodes.length === 3, `未知 kind / 未知操作剔除（实际 ${doc.nodes.length}）`);
  check(doc.nodes[1].matchMode === "tag", "非法匹配模式回退 tag");
  check(doc.nodes[1].x === 20000, "坐标钳制");
  const spin = doc.nodes.find((n) => n.opType === "op.spin");
  check(
    !!spin && spin.params?.speedX === 10 && spin.params?.speedY === 45 && spin.params?.speedZ === 999,
    "操作参数按字段收敛（非数值回退缺省）",
  );
  check(doc.edges.length === 1, `通道不符/自环剔除后剩 1 条（实际 ${doc.edges.length}）`);
  check(doc.edges[0].dstPort === "in", "保留实体集通道连线");
  check(doc.comments[0].w === 80 && doc.comments[0].h === 2000, "注释框尺寸钳制");
  check(doc.comments[0].color === "#dcdcaa", "非法颜色回退缺省");

  check(isGraphDoc({ nodes: [], edges: [] }), "isGraphDoc 接受空图");
  check(!isGraphDoc({}), "isGraphDoc 拒绝非图");

  // 端口通道表：原型/匹配只有实体集源；操作有实体入/执行入/实体出/执行出
  const proto: GNode = { id: "p", type: "entity.proto", x: 0, y: 0, entityId: "e" };
  const op: GNode = { id: "o", type: "op.spin", x: 0, y: 0, opType: "op.spin", params: {} };
  check(graphNodePorts(proto).length === 1 && graphNodePorts(proto)[0].dataType === "entities", "原型仅实体集源端口");
  check(graphNodePorts(op).length === 4, "操作节点四端口");
  check(graphPort(op, "in", "in")?.dataType === "entities", "op.in = 实体集入");
  check(graphPort(op, "exec", "in")?.dataType === "exec", "op.exec = 执行链入");
  check(!canConnectPorts(port("out", "entities", "out"), port("exec", "exec", "in")), "实体集 → 执行链拒绝");
  check(canConnectPorts(port("out", "entities", "out"), port("in", "entities", "in")), "实体集 → 实体集");

  // 事件节点端口：onBegin/onTick 仅有 next（exec 出）；onClick 有 in（entities 入）+ next
  const onBegin: GNode = { id: "eb", type: "event.onBegin", x: 0, y: 0 };
  const onTick: GNode = { id: "et", type: "event.onTick", x: 0, y: 0 };
  const onClick: GNode = { id: "ec", type: "event.onClick", x: 0, y: 0 };
  check(graphNodePorts(onBegin).length === 1 && graphPort(onBegin, "next", "out")?.dataType === "exec", "onBegin 仅 next(exec) 出端口");
  check(graphNodePorts(onTick).length === 1 && graphPort(onTick, "next", "out")?.dataType === "exec", "onTick 仅 next(exec) 出端口");
  check(graphNodePorts(onClick).length === 2 && graphPort(onClick, "in", "in")?.dataType === "entities", "onClick 有 in(entities) 入 + next(exec) 出");
  check(canConnectPorts(port("next", "exec", "out"), port("exec", "exec", "in")), "exec → exec 可连");

  // 节点类型注册表
  check(nodeTypeDef("event.onBegin")?.category === "event", "event.onBegin 注册为 event 类别");
  check(nodeTypeDef("entity.proto")?.category === "entity", "entity.proto 注册为 entity 类别");
  check(nodeTypeDef("op.spin")?.category === "op", "op.spin 注册为 op 类别");
  const groups = nodeMenuGroups();
  check(groups.some((g) => g.category === "event" && g.items.length === 3), "右键菜单含事件分组（3 个事件节点）");

  // 标签推导显示名
  const m: GNode = { id: "m", type: "entity.match", x: 0, y: 0, matchMode: "tag", matchPattern: "enemy" };
  check(graphNodeLabel(m).includes("enemy"), "匹配节点显示名含模式串");
  check(graphNodeLabel({ id: "x", type: "entity.proto", x: 0, y: 0 }, { entityName: () => "Box01" }) === "Box01", "原型显示名取实体名");

  // ----- 变量系统 -----
  // var.get / var.set 节点类型注册
  check(nodeTypeDef("var.get")?.category === "variable", "var.get 注册为 variable 类别");
  check(nodeTypeDef("var.set")?.category === "variable", "var.set 注册为 variable 类别");
  const vg: GNode = { id: "vg", type: "var.get", x: 0, y: 0, varId: "v1" };
  const vs: GNode = { id: "vs", type: "var.set", x: 0, y: 0, varId: "v1" };
  // var.get：仅 value 出引脚（any 类型）
  check(graphNodePorts(vg).length === 1 && graphPort(vg, "value", "out")?.dataType === "any", "var.get 仅 value(any) 出端口");
  // var.set：exec 入 + value 数据入 + next 出 + value 出
  check(graphNodePorts(vs).length === 4, "var.set 四端口（exec入/value入/next出/value出）");
  check(graphPort(vs, "exec", "in")?.dataType === "exec", "var.set.exec = 执行链入");
  check(graphPort(vs, "value", "in")?.dataType === "any", "var.set.value入 = any 数据入");
  check(graphPort(vs, "next", "out")?.dataType === "exec", "var.set.next = 执行链出");
  check(graphPort(vs, "value", "out")?.dataType === "any", "var.set.value出 = any 数据出");
  // any 类型可连 number/boolean/string
  check(canConnectPorts(port("value", "any", "out"), port("value", "any", "in")), "any → any 可连");
  check(canConnectPorts(port("value", "any", "out"), port("in", "entities", "in")), "any → entities 可连");

  // 变量收敛
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
      { id: "v3", name: "label", dataType: "string", value: "hello" },
      { id: "v4", name: "bad", dataType: "nope", value: 0 },
    ],
  });
  check(vDoc.variables?.length === 5, `变量 id 冲突生成新 id（5 个，实际 ${vDoc.variables?.length}）`);
  check(vDoc.variables?.[0].name === "speed", "变量名保留");
  check(vDoc.variables?.[2].name === "flag" && vDoc.variables?.[2].value === true, "布尔变量收敛");
  check(vDoc.variables?.[3].name === "label" && vDoc.variables?.[3].value === "hello", "字符串变量收敛");
  check(vDoc.variables?.[4].dataType === "number", "非法类型回退 number");
  // varId 收敛
  check(vDoc.nodes[0].varId === "v1", "var.get.varId 保留");
  check(vDoc.nodes[1].varId === "v_bad", "var.set.varId 保留（即使引用不存在的变量）");

  // 变量节点显示名
  const varNameResolver = (id: string): string | null => {
    const v = vDoc.variables?.find((x) => x.id === id);
    return v ? v.name : null;
  };
  check(graphNodeLabel({ id: "x", type: "var.get", x: 0, y: 0, varId: "v1" }, { varName: varNameResolver }) === "speed", "var.get 显示名取变量名");
  check(graphNodeLabel({ id: "x", type: "var.set", x: 0, y: 0 }, { varName: varNameResolver }) === "变量", "var.set 无 varId 显示「变量」");

  // 变量 id 生成
  check(nextGraphVariableId({ variables: [{ id: "v1", name: "a", dataType: "number", value: 0 }] }) === "v2", "nextGraphVariableId 跳过已有");

  // 右键菜单含变量分组
  const vGroups = nodeMenuGroups();
  check(vGroups.some((g) => g.category === "variable" && g.items.length === 2), "右键菜单含变量分组（var.get + var.set）");
  // 控制流节点注册
  check(nodeTypeDef("flow.branch")?.category === "flow", "flow.branch 注册为 flow 类别");
  check(nodeTypeDef("flow.compare")?.category === "flow", "flow.compare 注册为 flow 类别");
  check(nodeTypeDef("flow.for")?.category === "flow", "flow.for 注册为 flow 类别");
  check(nodeTypeDef("flow.forEach")?.category === "flow", "flow.forEach 注册为 flow 类别");
  check(nodeTypeDef("flow.while")?.category === "flow", "flow.while 注册为 flow 类别");
  check(vGroups.some((g) => g.category === "flow" && g.items.length === 5), "右键菜单含控制流分组（5 个节点）");
  // Branch 端口
  const branch: GNode = { id: "br", type: "flow.branch", x: 0, y: 0 };
  check(graphNodePorts(branch).length === 4, "flow.branch 四端口");
  check(graphPort(branch, "exec", "in")?.dataType === "exec", "branch.exec = 执行入");
  check(graphPort(branch, "condition", "in")?.dataType === "boolean", "branch.condition = 布尔入");
  check(graphPort(branch, "true", "out")?.dataType === "exec", "branch.true = 执行出");
  check(graphPort(branch, "false", "out")?.dataType === "exec", "branch.false = 执行出");
  // Compare 端口（纯数据）
  const cmp: GNode = { id: "cmp", type: "flow.compare", x: 0, y: 0, params: { operator: ">" } };
  check(graphNodePorts(cmp).length === 3, "flow.compare 三端口");
  check(graphPort(cmp, "a", "in")?.dataType === "number", "compare.a = 数值入");
  check(graphPort(cmp, "result", "out")?.dataType === "boolean", "compare.result = 布尔出");
  // For 端口
  const forNode: GNode = { id: "fo", type: "flow.for", x: 0, y: 0, params: { start: 0, end: 10, step: 1 } };
  check(graphNodePorts(forNode).length === 7, "flow.for 七端口");
  check(graphPort(forNode, "loop", "out")?.dataType === "exec", "for.loop = 执行出");
  check(graphPort(forNode, "index", "out")?.dataType === "number", "for.index = 数值出");
  check(graphPort(forNode, "completed", "out")?.dataType === "exec", "for.completed = 执行出");
  // ForEach 端口
  const feNode: GNode = { id: "fe", type: "flow.forEach", x: 0, y: 0 };
  check(graphNodePorts(feNode).length === 5, "flow.forEach 五端口");
  check(graphPort(feNode, "array", "in")?.dataType === "entities", "forEach.array = 实体集入");
  check(graphPort(feNode, "item", "out")?.dataType === "entity", "forEach.item = 实体出");
  // While 端口
  const whNode: GNode = { id: "wh", type: "flow.while", x: 0, y: 0 };
  check(graphNodePorts(whNode).length === 4, "flow.while 四端口");
  check(graphPort(whNode, "loop", "out")?.dataType === "exec", "while.loop = 执行出");
  check(graphPort(whNode, "completed", "out")?.dataType === "exec", "while.completed = 执行出");
  // 控制流连线兼容性
  check(canConnectPorts(port("result", "boolean", "out"), port("condition", "boolean", "in")), "compare.result → branch.condition 可连");
  check(canConnectPorts(port("true", "exec", "out"), port("exec", "exec", "in")), "branch.true → op.exec 可连");
  check(canConnectPorts(port("loop", "exec", "out"), port("exec", "exec", "in")), "for.loop → op.exec 可连");
  // 控制流节点 normalize
  const fDoc = normalizeGraphDoc({
    nodes: [
      { id: "n1", type: "flow.branch", x: 0, y: 0 },
      { id: "n2", type: "flow.compare", x: 0, y: 0, params: { operator: ">=" } },
      { id: "n3", type: "flow.for", x: 0, y: 0, params: { start: "x", end: 5, step: 1 } },
    ],
    edges: [],
    comments: [],
  });
  check(fDoc.nodes.length === 3, "控制流节点 normalize 保留");
  check(fDoc.nodes[1].params?.operator === ">=", "compare.operator 保留");
  check(fDoc.nodes[2].params?.start === 0 && fDoc.nodes[2].params?.end === 5, "for 循环参数收敛（非数值回退缺省）");

  // ----- 数学/工具节点 -----
  const mathTypes = ["math.add", "math.sub", "math.mul", "math.div", "math.mod", "math.sin", "math.cos", "math.tan", "math.vec3Make", "math.vec3Break", "math.stringConcat", "math.toString", "math.lerp", "math.clamp", "math.abs"];
  for (const mt of mathTypes) {
    check(nodeTypeDef(mt)?.category === "math", `${mt} 注册为 math 类别`);
  }
  check(vGroups.some((g) => g.category === "math" && g.items.length === mathTypes.length), `右键菜单含数学分组（${mathTypes.length} 个节点）`);
  // 算术端口
  const addN: GNode = { id: "add", type: "math.add", x: 0, y: 0 };
  check(graphNodePorts(addN).length === 3, "math.add 三端口（a/b 入 + result 出）");
  check(graphPort(addN, "a", "in")?.dataType === "number", "add.a = 数值入");
  check(graphPort(addN, "result", "out")?.dataType === "number", "add.result = 数值出");
  // 向量端口
  const v3m: GNode = { id: "v3m", type: "math.vec3Make", x: 0, y: 0 };
  check(graphNodePorts(v3m).length === 4, "math.vec3Make 四端口（x/y/z 入 + v 出）");
  check(graphPort(v3m, "v", "out")?.dataType === "vec3", "vec3Make.v = 向量出");
  const v3b: GNode = { id: "v3b", type: "math.vec3Break", x: 0, y: 0 };
  check(graphPort(v3b, "v", "in")?.dataType === "vec3", "vec3Break.v = 向量入");
  check(graphPort(v3b, "x", "out")?.dataType === "number", "vec3Break.x = 数值出");
  // 字符串端口
  const sc: GNode = { id: "sc", type: "math.stringConcat", x: 0, y: 0 };
  check(graphPort(sc, "a", "in")?.dataType === "string" && graphPort(sc, "result", "out")?.dataType === "string", "stringConcat 端口 = string");
  const ts: GNode = { id: "ts", type: "math.toString", x: 0, y: 0 };
  check(graphPort(ts, "value", "in")?.dataType === "any", "toString.value = any 入");
  // 数学节点连线兼容性
  check(canConnectPorts(port("result", "number", "out"), port("a", "number", "in")), "add.result → add.a 可连");
  check(canConnectPorts(port("result", "number", "out"), port("condition", "boolean", "in")) === false, "number → boolean 拒绝");
  check(canConnectPorts(port("v", "vec3", "out"), port("v", "vec3", "in")), "vec3 → vec3 可连");
  // 数学节点 normalize
  const mDoc = normalizeGraphDoc({
    nodes: [
      { id: "m1", type: "math.add", x: 0, y: 0 },
      { id: "m2", type: "math.vec3Make", x: 0, y: 0 },
      { id: "m3", type: "math.nope", x: 0, y: 0 },
    ],
    edges: [
      { id: "me1", srcNode: "m1", srcPort: "result", dstNode: "m2", dstPort: "x" },
    ],
    comments: [],
  });
  check(mDoc.nodes.length === 2, "数学节点 normalize 保留（未知 math 类型剔除）");
  check(mDoc.edges.length === 1, "数学节点数据流连线保留");

  // ----- 自定义节点定义 -----
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
  check(nodeTypeDef("custom.myAdd")?.label === "我的加法", "自定义节点 label");
  const customNode: GNode = { id: "cn", type: "custom.myAdd", x: 0, y: 0, params: { offset: 10 } };
  check(graphNodePorts(customNode).length === 3, "自定义节点三端口（a/b 入 + result 出）");
  check(graphPort(customNode, "a", "in")?.dataType === "number", "custom.a = 数值入");
  check(graphPort(customNode, "result", "out")?.dataType === "number", "custom.result = 数值出");
  // 自定义节点在右键菜单
  const cGroups = nodeMenuGroups();
  check(cGroups.some((g) => g.category === "custom" && g.items.some((i) => i.type === "custom.myAdd")), "右键菜单含自定义分组");
  // 自定义节点 normalize
  const cDoc = normalizeGraphDoc({
    nodes: [
      { id: "cn1", type: "custom.myAdd", x: 0, y: 0, params: { offset: 5 } },
      { id: "cn2", type: "custom.nope", x: 0, y: 0 },
    ],
    edges: [],
    comments: [],
    customNodes: [customDef, { id: "cd1", type: "custom.dup", label: "重复", desc: "", color: "#4ec9b0", inputs: [], outputs: [], fields: [], expressions: {} }],
  });
  check(cDoc.nodes.length === 1, "自定义节点 normalize 保留（未知 custom 类型因未注册而剔除）");
  check(cDoc.nodes[0].params?.offset === 5, "自定义节点参数保留");
  check(cDoc.customNodes?.length === 2, "自定义节点定义 normalize（id 冲突生成新 id）");
  check(cDoc.customNodes?.[0].type === "custom.myAdd", "自定义节点定义 type 保留");
  check(cDoc.customNodes?.[1].type === "custom.dup", "自定义节点定义 id 冲突但 type 不同仍保留");
  // 注册后未知类型变已知
  registerCustomNodeDefs(cDoc.customNodes ?? []);
  check(nodeTypeDef("custom.dup")?.category === "custom", "normalize 后自定义节点已注册");

  const g1 = normalizeGraphDoc(emptyGraphDoc());
  check(g1.nodes.length === 0, "空图合法");
}

// ===========================================================================
console.log("② 操作目录");
{
  const types = GRAPH_OP_DEFS.map((d) => d.type);
  check(new Set(types).size === types.length, "操作类型唯一");
  check(types.includes("op.set") && types.includes("op.spin") && types.includes("op.bob") && types.includes("op.fireFsm") && types.includes("op.setFsmParam") && types.includes("op.toggleVisible"), "六种原子操作齐备");
  // 触发时机由类型固定
  check(graphOpDef("op.spin")?.trigger === "frame", "spin = 每帧");
  check(graphOpDef("op.set")?.trigger === "start", "set = 启动时");
  check(graphOpDef("op.toggleVisible")?.trigger === "click", "toggleVisible = 点击时");
  check(graphOpDef("op.fireFsm")?.trigger === "click", "fireFsm = 点击时");
  // 缺省参数
  const defaults = graphOpDefaults("op.spin");
  check(defaults.speedY === 45, "spin.speedY 缺省 45");
  check(Object.keys(graphOpDefaults("op.nope")).length === 0, "未知操作缺省参数为空");
}

// ===========================================================================
console.log("③ 运行时契约");
{
  const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf-8");

  const beh = read("src/runtime/runtime/graph-behaviors.ts");
  check(beh.includes("createGraphBehaviors"), "解释器导出 createGraphBehaviors");
  check(beh.includes("nodeTag") && beh.includes("nodeKind") && beh.includes("nodeId"), "按 userData 标签/类型/id 匹配");
  check(beh.includes("pointerdown") && beh.includes("Raycaster"), "点击行为走指针射线");
  check(beh.includes("logicApi") && beh.includes(".fire("), "FSM 事件经 engine.logic 语义");
  check(beh.includes("update(dt"), "每帧行为推进");
  check(beh.includes("cascadeExec") && beh.includes("execNext"), "exec 链级联（事件→exec→next→...）");
  check(beh.includes("event.onBegin") && beh.includes("event.onTick") && beh.includes("event.onClick"), "事件节点驱动（onBegin/onTick/onClick）");
  check(beh.includes("hasExecInput") && beh.includes("legacyOps"), "向后兼容：无 exec 入边的旧操作按 trigger 独立执行");
  // 数据流求值引擎
  check(beh.includes("DataValue") && beh.includes("evalDataOutput") && beh.includes("evalDataInput"), "数据流求值引擎（evalDataOutput/evalDataInput）");
  check(beh.includes("varStore"), "图变量存储（varStore）");
  check(beh.includes('node.type === "var.set"') && beh.includes("varStore.set"), "var.set 在 exec 链中写入变量");
  check(beh.includes('node.type === "var.get"') && beh.includes("varStore.get"), "var.get 输出求值读变量");
  check(beh.includes("tickChainVarSets") || beh.includes("tickChainEntries"), "tick 链每帧级联执行");
  // 控制流执行引擎
  check(beh.includes("execOut") && beh.includes("execNextOf"), "exec 出端口按端口索引（execOut/execNextOf）");
  check(beh.includes('node.type === "flow.branch"'), "flow.branch 条件分支执行");
  check(beh.includes('node.type === "flow.compare"') && beh.includes("operator"), "flow.compare 比较求值");
  check(beh.includes('node.type === "flow.for"') && beh.includes("loopIndex"), "flow.for 计数循环 + 索引上下文");
  check(beh.includes('node.type === "flow.forEach"') && beh.includes("loopItem"), "flow.forEach 实体遍历 + 当前项上下文");
  check(beh.includes('node.type === "flow.while"') && beh.includes("10000"), "flow.while 条件循环 + 死循环防护");
  // 数学求值引擎
  check(beh.includes("evalMath") || beh.includes('node.type === "math.add"'), "数学节点求值（evalMath / math.add 分支）");
  check(beh.includes("math.vec3Make") || beh.includes("vec3"), "向量节点求值（vec3 数据类型支持）");
  check(beh.includes("math.stringConcat") || beh.includes("toStr"), "字符串节点求值");
  // 自定义节点表达式求值
  check(beh.includes("customExprCache") || beh.includes("custom."), "自定义节点表达式编译缓存");
  check(beh.includes("new Function") || beh.includes("expressions"), "自定义节点表达式动态编译");
  check(beh.includes("customDefMap"), "自定义节点定义查找表");

  const player = read("public/web-preview/player.mjs");
  check(player.includes("engine/runtime/graph-behaviors.mjs"), "player 导入解释器");
  check(player.includes("cfg.scriptGraph") && player.includes("script-graph.json"), "player 按 config.scriptGraph 装配注入文档");
  check(player.includes("graphBehaviors.update(dt)"), "player 每帧推进行为");
  check(player.includes("graphBehaviors.dispose()"), "player 卸载时清理行为");
}

// ===========================================================================
console.log("④ 窗口契约");
{
  const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf-8");

  const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as {
    app: { windows: { label: string; url: string; visible: boolean }[] };
  };
  const gw = conf.app.windows.find((w) => w.label === "graph");
  check(!!gw && gw.url === "graph.html" && gw.visible === false, "tauri.conf.json graph 窗口（隐藏常驻）");

  const cap = JSON.parse(read("src-tauri/capabilities/default.json")) as {
    windows: string[];
    permissions: string[];
  };
  check(cap.windows.includes("graph"), "capabilities：graph 窗口已授权");
  check(cap.permissions.includes("core:window:allow-hide"), "capabilities：graph 关闭按钮需要 allow-hide");

  const lib = read("src-tauri/src/lib.rs");
  check(lib.includes("async fn show_window_with_project") && lib.includes("show_window_with_project,"), "lib.rs show_window_with_project 统一命令与注册");
  check(lib.includes("WINDOW_LIFECYCLE") && lib.includes("CloseAction::Hide"), "lib.rs 声明式窗口生命周期表");

  // 场景会话按场景 rel 分键：同一场景全窗口共享一份数据（含未保存修改），
  // 不同场景各自会话互不冲突；会话按 (root,rel) 复合键分，事件载荷带 root+rel
  const sceneMod = read("src-tauri/src/scene/mod.rs");
  check(
    sceneMod.includes("sessions: std::collections::HashMap<SessionKey, SessionCore>") && sceneMod.includes("current: std::collections::HashMap<String, SessionKey>"),
    "后端：会话按 (root,rel) 复合键分键 + 各窗口当前指针",
  );
  check(sceneMod.includes("pub root: Option<String>,") && sceneMod.includes("pub rel: String,") && sceneMod.includes('app.emit("scene:changed"'), "后端：scene:changed 载荷带 root+rel 全局广播");
  check(
    sceneMod.includes("webview: tauri::Webview,") && !sceneMod.includes("tauri::WebviewWindow"),
    "后端：命令参数用可注入的 tauri::Webview（WebviewWindow 无法注入会导致运行时全失败）",
  );

  const launch = read("src/app/lib/graph-launch.ts");
  check(
    launch.includes("handoffToWindow") && launch.includes('"graph"'),
    "Hub 侧打开助手（统一窗口交接 handoffToWindow）",
  );
  const projects = read("src/app/components/home/ProjectsSection.vue");
  check(projects.includes("openScriptGraphWindow") && projects.includes("打开脚本图"), "项目卡片菜单「打开脚本图」");

  check(read("graph.html").includes("src/graph-main.ts"), "graph.html 入口");
  const gmain = read("src/graph-main.ts");
  check(
    gmain.includes("window:project-open") && gmain.includes("takePendingProject") && gmain.includes("getGraphBootStore().standby()"),
    "graph-main 统一交接事件 + 冷启动拉取 + 蒙版布防",
  );
  check(!gmain.includes("getCurrentWindow().show"), "graph-main 不自行显示窗口（由 show_window_with_project 控制）");
  const mask = read("src/graph-window/components/GraphBootMask.vue");
  check(mask.includes("boot-mask") && mask.includes("TVE <span>GRAPH</span>"), "装载蒙版复用编辑器 boot-mask 视觉");

  // 编辑器界面不被改动（入口只在 Hub）
  const toolbar = read("src/app/components/Toolbar.vue");
  check(!toolbar.includes("脚本图"), "编辑器工具栏未加脚本图入口");
}

// ===========================================================================
console.log("⑤ 工作台与无图资产契约");
{
  const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf-8");

  const store = read("src/graph-window/graphStore.ts");
  check(
    store.includes("sidecarRel") && store.includes(".tve/script-graph/") && store.includes("writeText"),
    "store：图会话侧车自动保存（.tve 旁路，无图资产）",
  );
  check(
    store.includes("fetchSceneEntities") && store.includes("markGraphDirty") && store.includes("flushGraph"),
    "store：场景实体索引/脏标记/卸载冲刷",
  );
  check(
    store.includes("async openScene(rel)") && store.includes("sceneApi.open"),
    "store：双击场景资产 → openScene 切当前场景",
  );
  // 两窗口仅资产数据共享：无跨窗口场景事件
  const project = read("src/app/stores/project.ts");
  check(!project.includes("editor:scene-open"), "编辑器不广播场景指针（窗口独立）");
  check(!store.includes("editor:scene-open"), "图窗口不跟随编辑器场景指针");

  const canvas = read("src/graph-window/components/GraphCanvas.vue");
  check(
    canvas.includes("#node-gproto") && canvas.includes("#node-gmatch") && canvas.includes("#node-gop") && canvas.includes("#node-gcomment") && canvas.includes("#node-gvar"),
    "画布：原型/匹配/操作/变量/注释框五类插槽",
  );
  check(
    canvas.includes("application/x-tve-entity") && canvas.includes("addProto"),
    "画布：层级拖入生成原型",
  );
  check(canvas.includes("is-valid-connection") && canvas.includes("requestSnapshot"), "画布：连线校验/会话快照");
  check(canvas.includes("addVarNode") && canvas.includes("var.get") && canvas.includes("var.set"), "画布：变量节点创建（addVarNode）");
  check(canvas.includes("addFlowNode") && canvas.includes("flow.branch") && canvas.includes("flow.compare") && canvas.includes("flow.for"), "画布：控制流节点创建（addFlowNode）");
  check(canvas.includes("#node-gflow"), "画布：控制流卡片插槽");
  check(canvas.includes("addMathNode") && canvas.includes("math.") && canvas.includes("#node-gmath"), "画布：数学节点创建 + 卡片插槽");
  check(canvas.includes("nodeMenuGroups") && canvas.includes("mathItems"), "画布：右键菜单数学分组（nodeMenuGroups 驱动）");
  check(canvas.includes("addCustomNode") && canvas.includes("#node-gcustom"), "画布：自定义节点创建 + 卡片插槽");
  check(canvas.includes("customItems") || canvas.includes("custom."), "画布：右键菜单自定义分组");

  const inspector = read("src/graph-window/components/NodeInspector.vue");
  check(
    inspector.includes("sceneEntities") && inspector.includes("commitParam") && inspector.includes("G_OP_TRIGGER_LABEL"),
    "检查器：实体属性参照/操作参数表/触发徽标",
  );
  check(inspector.includes("varDef") && inspector.includes("commitVarId") && inspector.includes("graphVariables"), "检查器：变量节点面板（变量选择器）");
  check(inspector.includes("flowDef") && inspector.includes("commitFlowParam") && inspector.includes("G_COMPARE_OPERATORS"), "检查器：控制流面板（运算符/循环参数）");
  check(inspector.includes("mathDef"), "检查器：数学节点面板（mathDef）");
  check(inspector.includes("customDef") && inspector.includes("commitCustomParam"), "检查器：自定义节点面板（customDef + commitCustomParam）");

  // 数学卡片
  const mathCard = read("src/graph-window/components/GraphMathCard.vue");
  check(mathCard.includes("nodeTypeDef") && mathCard.includes("pinColor"), "数学卡片：注册表驱动端口 + dataType 配色");

  // 自定义节点卡片
  const customCard = read("src/graph-window/components/GraphCustomCard.vue");
  check(customCard.includes("nodeTypeDef") && customCard.includes("gcustom"), "自定义卡片：注册表驱动 + gcustom 类");

  // 自定义节点定义面板
  const customPanel = read("src/graph-window/components/GraphCustomNodePanel.vue");
  check(customPanel.includes("addCustomNodeDef") && customPanel.includes("updateCustomNodeDef") && customPanel.includes("deleteCustomNodeDef"), "自定义节点面板：增删改方法");
  check(customPanel.includes("expressions") && customPanel.includes("addPort"), "自定义节点面板：表达式编辑 + 端口增删");

  // store 自定义节点管理
  check(
    store.includes("graphCustomNodes") && store.includes("addCustomNodeDef") && store.includes("updateCustomNodeDef") && store.includes("deleteCustomNodeDef"),
    "store：自定义节点定义管理方法",
  );
  check(store.includes("registerCustomNodeDefs"), "store：自定义节点注册表同步");
  check(store.includes("customNodes: state.graphCustomNodes"), "store：自动保存合并自定义节点定义表");

  // 变量面板
  const varPanel = read("src/graph-window/components/GraphVariablePanel.vue");
  check(varPanel.includes("addVariable") && varPanel.includes("renameVariable") && varPanel.includes("deleteVariable"), "变量面板：增删改方法");
  check(varPanel.includes("setVariableType") && varPanel.includes("setVariableValue"), "变量面板：类型/值编辑");

  // store 变量管理
  check(
    store.includes("graphVariables") && store.includes("addVariable") && store.includes("renameVariable") && store.includes("deleteVariable") && store.includes("setVariableType") && store.includes("setVariableValue"),
    "store：图变量管理方法",
  );
  check(store.includes("serializeDoc") && store.includes("variables: state.graphVariables"), "store：自动保存合并变量表");


  const preview = read("src/graph-window/components/GraphPreview.vue");
  check(
    preview.includes("script-graph.json") && preview.includes("scriptGraph") && preview.includes("exportWebPreviewFromScene"),
    "预览：注入脚本图文档 + config 标记（与编辑器同一导出链路）",
  );
  const assetsPanel = read("src/graph-window/components/GraphAssets.vue");
  check(
    assetsPanel.includes('item.kind === "scene"') && assetsPanel.includes("openScene") && !assetsPanel.includes("clipboard"),
    "资产面板：双击场景打开（无复制路径）",
  );

  const hierarchy = read("src/graph-window/components/GraphHierarchy.vue");
  check(hierarchy.includes("dragstart") && hierarchy.includes("addProto"), "层级：行拖入生成原型");
  // 面板与编辑器一致性：同款样式类/真件复用/同源数据
  check(
    hierarchy.includes("hierarchy-panel.scss") && hierarchy.includes("panel hierarchy") && hierarchy.includes("NODE_ICONS"),
    "层级：编辑器同款结构/样式/图标",
  );
  const assets = read("src/graph-window/components/GraphAssets.vue");
  check(
    assets.includes("getAssetsStore") && assets.includes("AssetToolbar") && assets.includes("AssetEntryCell") && assets.includes("assets-panel.scss"),
    "资产：编辑器同源数据 + 真件复用（工具栏/条目）",
  );

  // 停靠系统：图窗口复刻编辑器 docks（页签拖拽/浮动/分隔条调宽），布局键隔离
  const docks = read("src/graph-window/docks.ts");
  check(
    docks.includes("tve:graph:dock-layout:v1") && docks.includes("initGraphDocks") && docks.includes("uiStateSet"),
    "dock：图窗口布局注册表（层级/检查器/变量/资产）+ 后端 UI 状态 KV 持久化",
  );
  check(docks.includes('"variables"') && docks.includes("变量"), "dock：变量面板注册");
  check(docks.includes('"customNodes"') && docks.includes("自定义"), "dock：自定义节点面板注册");
  const dnd = read("src/graph-window/graph-dock-dnd.ts");
  check(dnd.includes("beginTabDrag") && dnd.includes("dock-dragging"), "dock：页签拖拽（移动/停靠/浮动）");
  const zone = read("src/graph-window/components/GraphDockZone.vue");
  check(
    zone.includes('class="dock-zone"') && zone.includes("data-dock-tab") && zone.includes("dock-body"),
    "dock：停靠区同款页签/落点/空区细条",
  );
  const appSrc = read("src/graph-window/GraphApp.vue");
  check(
    appSrc.includes("GraphDockZone") && appSrc.includes("beginZoneResize") && appSrc.includes("splitter") && appSrc.includes("GraphFloatingDock") && appSrc.includes("dock-ghost"),
    "工作区：停靠区 + 分隔条调宽 + 浮动面板 + 拖拽幽灵",
  );

  // 旧资产化路线确已移除
  const logic = read("src-tauri/src/scene/logic_assets.rs");
  check(!logic.includes("scriptgraph"), "Rust 无 scriptgraph 资产命令");
  const api = read("src/lib/api.ts");
  check(!api.includes("scriptGraphWrite") && !api.includes("scriptgraph_write"), "api.ts 无图资产门面");
  const app = read("src/graph-window/GraphApp.vue");
  check(!app.includes("store.save()"), "工作台无保存按钮（自动保存）");
  const graphAppSrc = read("src/graph-window/graphStore.ts");
  check(!graphAppSrc.includes("scriptGraphWrite"), "store 无图资产写入");
}

// ===========================================================================
console.log(passed === 0 && failed === 0 ? "无断言" : `\n${passed} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
