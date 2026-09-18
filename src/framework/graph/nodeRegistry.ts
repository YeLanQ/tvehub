// ---------------------------------------------------------------------------
// 场景图节点类型注册表（通用节点类型系统）：
// 每种节点类型定义其端口（输入/输出 + 数据类型）与可编辑字段，
// 取代 graphTypes.ts 中按 kind 硬编码端口的旧模式。
//
// 内置类型分五大类：
// - entity：原型（拖入实体）/ 匹配（标签|类型筛选）—— 实体集源
// - event：OnBegin / OnTick / OnClick —— 执行链入口（触发时机）
// - op：原子操作（设置/旋转/浮动/FSM…）—— 有 exec 入端口 + next 出端口
// - flow：控制流（Branch/Switch/比较/循环…）—— 阶段3
// - math：数学/工具（加减乘除/sin/cos/lerp…）—— 阶段4
// ---------------------------------------------------------------------------

import { GRAPH_OP_DEFS, G_OP_TRIGGER_LABEL, type GOpDef, type GOpFieldDef } from "./opRegistry";
import type { GCustomNodeDef, GCustomPort, GCustomField } from "./graphTypes";

// ---------------------------------------------------------------------------
// 数据类型
// ---------------------------------------------------------------------------

/** 端口数据类型（决定连线兼容性与运行时求值语义） */
export type GDataType = "exec" | "entity" | "entities" | "number" | "boolean" | "string" | "vec3" | "any";

/** 数据类型显示名 */
export const G_DATA_TYPE_LABEL: Record<GDataType, string> = {
  exec: "执行",
  entity: "实体",
  entities: "实体集",
  number: "数值",
  boolean: "布尔",
  string: "字符串",
  vec3: "向量3",
  any: "任意",
};

/** 两数据类型能否相连（同类型 / any 通配 / entity→entities 提升） */
export function canConnectDataTypes(src: GDataType, dst: GDataType): boolean {
  if (src === dst) return true;
  if (src === "any" || dst === "any") return true;
  if (src === "entity" && dst === "entities") return true;
  if (src === "entities" && dst === "entity") return true;
  return false;
}

// ---------------------------------------------------------------------------
// 端口与字段定义
// ---------------------------------------------------------------------------

/** 端口定义（节点的输入/输出连接点） */
export interface GPortDef {
  id: string;
  label: string;
  direction: "in" | "out";
  dataType: GDataType;
  /** 可多连（实体集等汇聚语义）；缺省 = 单入替换 */
  multi?: boolean;
}

/** 可编辑字段（非引脚输入的字面量参数，在检查器编辑） */
export type GFieldDef = GOpFieldDef;

// ---------------------------------------------------------------------------
// 节点类型定义
// ---------------------------------------------------------------------------

/** 节点类别（右键菜单分组 + 颜色基调） */
export type GNodeCategory = "entity" | "event" | "op" | "flow" | "math" | "variable" | "custom" | "logic" | "driver";

/** 节点类型定义（注册表条目） */
export interface GNodeTypeDef {
  /** 唯一键（如 "entity.proto"、"op.spin"、"event.onBegin"） */
  type: string;
  category: GNodeCategory;
  label: string;
  desc: string;
  color: string;
  inputs: GPortDef[];
  outputs: GPortDef[];
  fields?: GFieldDef[];
  /** 事件节点触发时机（仅 category="event"） */
  trigger?: "start" | "frame" | "click";
}

// ---------------------------------------------------------------------------
// 端口工厂（简化注册）
// ---------------------------------------------------------------------------

const P_EXEC_IN: GPortDef = { id: "exec", label: "", direction: "in", dataType: "exec" };
const P_EXEC_OUT: GPortDef = { id: "next", label: "", direction: "out", dataType: "exec" };
const P_ENTITIES_IN: GPortDef = { id: "in", label: "目标", direction: "in", dataType: "entities", multi: true };
const P_ENTITIES_OUT: GPortDef = { id: "out", label: "输出", direction: "out", dataType: "entities" };

// ---------------------------------------------------------------------------
// 内置节点类型注册
// ---------------------------------------------------------------------------

/** 实体类节点 */
const ENTITY_TYPES: GNodeTypeDef[] = [
  {
    type: "entity.proto",
    category: "entity",
    label: "原型",
    desc: "拖入场景实体生成原型卡片，属性以场景当前值为参照",
    color: "#4ec9b0",
    inputs: [],
    outputs: [{ id: "out", label: "输出", direction: "out", dataType: "entities" }],
  },
  {
    type: "entity.match",
    category: "entity",
    label: "匹配",
    desc: "按标签或类型批量匹配场景实体",
    color: "#4ec9b0",
    inputs: [],
    outputs: [{ id: "out", label: "输出", direction: "out", dataType: "entities" }],
  },
];

/** 事件类节点（执行链入口） */
const EVENT_TYPES: GNodeTypeDef[] = [
  {
    type: "event.onBegin",
    category: "event",
    label: "On Begin",
    desc: "运行时启动时触发一次（执行链入口）",
    color: "#c586c0",
    inputs: [],
    outputs: [P_EXEC_OUT],
    trigger: "start",
  },
  {
    type: "event.onTick",
    category: "event",
    label: "On Tick",
    desc: "每帧触发（执行链入口，驱动持续行为）",
    color: "#c586c0",
    inputs: [],
    outputs: [P_EXEC_OUT],
    trigger: "frame",
  },
  {
    type: "event.onClick",
    category: "event",
    label: "On Click",
    desc: "指针射线命中目标实体时触发（执行链入口）",
    color: "#c586c0",
    inputs: [P_ENTITIES_IN],
    outputs: [P_EXEC_OUT],
    trigger: "click",
  },
];

/** 操作类节点（从 opRegistry 的 GRAPH_OP_DEFS 转换） */
const OP_TYPES: GNodeTypeDef[] = GRAPH_OP_DEFS.map((op: GOpDef): GNodeTypeDef => ({
  type: op.type,
  category: "op",
  label: op.label,
  desc: op.desc,
  color: op.color,
  inputs: [P_ENTITIES_IN, P_EXEC_IN],
  outputs: [P_ENTITIES_OUT, P_EXEC_OUT],
  fields: op.fields,
  trigger: op.trigger,
}));

// op.patrol：追加「路径点」引脚（路径口接入路径点实体 → 依次巡回），并归入驱动器分组
const patrolDef = OP_TYPES.find((d) => d.type === "op.patrol");
if (patrolDef) {
  patrolDef.inputs.splice(1, 0, {
    id: "path", label: "路径点", direction: "in", dataType: "entities", multi: true,
  });
  patrolDef.category = "driver";
}

/**
 * 驱动器（帧驱动的移动类操作）：对象贴合导航代理位姿 / 追击目标 / 路径巡逻。
 * 独立成组——它们是"驱动对象运动"的持续行为，与一次性原子操作（设置/显隐）语义不同。
 */
const DRIVER_TYPES: GNodeTypeDef[] = [
  {
    type: "op.navMove",
    category: "driver",
    label: "导航移动",
    desc: "被移动对象跟随导航代理位姿（代理由导航运行时沿路径点巡回驱动）；「导航代理」口接入 Nav Agent 原型卡，「目标」接要移动的对象",
    color: "#dcdcaa",
    trigger: "frame",
    inputs: [
      P_ENTITIES_IN,
      P_EXEC_IN,
      { id: "agent", label: "导航代理", direction: "in", dataType: "entity" },
    ],
    outputs: [P_ENTITIES_OUT, P_EXEC_OUT],
    fields: [{ key: "yOffset", label: "高度偏移", kind: "number", fallback: 0, step: 0.1 }],
  },
  {
    type: "op.chase",
    category: "driver",
    label: "追击目标",
    desc: "每帧朝 prey 引脚接入的实体移动（速度 units/s）；常与 sense.distance + 分支组合成追击/放弃",
    color: "#dcdcaa",
    trigger: "frame",
    inputs: [
      P_ENTITIES_IN,
      P_EXEC_IN,
      { id: "prey", label: "追击目标", direction: "in", dataType: "entity" },
    ],
    outputs: [P_ENTITIES_OUT, P_EXEC_OUT],
    fields: [{ key: "speed", label: "速度", kind: "number", fallback: 3, step: 0.1 }],
  },
];

/** 变量类节点（var.get 纯数据读 / var.set exec 链写） */
const VARIABLE_TYPES: GNodeTypeDef[] = [
  {
    type: "var.get",
    category: "variable",
    label: "Get 变量",
    desc: "读取图变量的当前值（纯数据节点，拉模型求值）",
    color: "#88c0d0",
    inputs: [],
    outputs: [{ id: "value", label: "值", direction: "out", dataType: "any" }],
  },
  {
    type: "var.set",
    category: "variable",
    label: "Set 变量",
    desc: "写入图变量（执行链节点：从 value 入引脚取值写入变量）",
    color: "#88c0d0",
    inputs: [
      P_EXEC_IN,
      { id: "value", label: "值", direction: "in", dataType: "any" },
    ],
    outputs: [
      P_EXEC_OUT,
      { id: "value", label: "值", direction: "out", dataType: "any" },
    ],
  },
];

/** 控制流类节点（Branch/Compare/For/ForEach/While） */
const FLOW_TYPES: GNodeTypeDef[] = [
  {
    type: "flow.branch",
    category: "flow",
    label: "分支",
    desc: "条件为真走 true 分支，否则走 false 分支",
    color: "#c586c0",
    inputs: [P_EXEC_IN, { id: "condition", label: "条件", direction: "in", dataType: "boolean" }],
    outputs: [
      { id: "true", label: "真", direction: "out", dataType: "exec" },
      { id: "false", label: "假", direction: "out", dataType: "exec" },
    ],
  },
  {
    type: "flow.compare",
    category: "flow",
    label: "比较",
    desc: "比较两个数值（> < == >= <= !=），输出布尔；B 未连线时用参数值；event 填事件名可接入逻辑容器事件口",
    color: "#c586c0",
    inputs: [
      { id: "a", label: "A", direction: "in", dataType: "number" },
      { id: "b", label: "B", direction: "in", dataType: "number" },
    ],
    outputs: [{ id: "result", label: "结果", direction: "out", dataType: "boolean" }],
    fields: [
      { key: "operator", label: "运算", kind: "string", fallback: ">" },
      { key: "b", label: "B 值（未连线时）", kind: "number", fallback: 0, step: 0.1 },
      { key: "event", label: "触发事件名", kind: "string", fallback: "" },
    ],
  },
  {
    type: "flow.for",
    category: "flow",
    label: "For 循环",
    desc: "从 start 到 end 步进 step，每次触发 loop（索引可拉取）",
    color: "#c586c0",
    inputs: [
      P_EXEC_IN,
      { id: "start", label: "起始", direction: "in", dataType: "number" },
      { id: "end", label: "结束", direction: "in", dataType: "number" },
      { id: "step", label: "步长", direction: "in", dataType: "number" },
    ],
    outputs: [
      { id: "loop", label: "循环", direction: "out", dataType: "exec" },
      { id: "index", label: "索引", direction: "out", dataType: "number" },
      { id: "completed", label: "完成", direction: "out", dataType: "exec" },
    ],
    fields: [
      { key: "start", label: "起始", kind: "number", fallback: 0, step: 1 },
      { key: "end", label: "结束", kind: "number", fallback: 10, step: 1 },
      { key: "step", label: "步长", kind: "number", fallback: 1, step: 1 },
    ],
  },
  {
    type: "flow.forEach",
    category: "flow",
    label: "ForEach 循环",
    desc: "遍历实体集，每次触发 loop（当前实体可拉取）",
    color: "#c586c0",
    inputs: [P_EXEC_IN, { id: "array", label: "集合", direction: "in", dataType: "entities" }],
    outputs: [
      { id: "loop", label: "循环", direction: "out", dataType: "exec" },
      { id: "item", label: "当前", direction: "out", dataType: "entity" },
      { id: "completed", label: "完成", direction: "out", dataType: "exec" },
    ],
  },
  {
    type: "flow.while",
    category: "flow",
    label: "While 循环",
    desc: "条件为真时循环触发 loop（最多 10000 次防死循环）",
    color: "#c586c0",
    inputs: [P_EXEC_IN, { id: "condition", label: "条件", direction: "in", dataType: "boolean" }],
    outputs: [
      { id: "loop", label: "循环", direction: "out", dataType: "exec" },
      { id: "completed", label: "完成", direction: "out", dataType: "exec" },
    ],
  },
];

/** 比较运算符候选 */
export const G_COMPARE_OPERATORS = [">", "<", "==", ">=", "<=", "!="] as const;

/** 数学/工具类节点（纯数据，拉模型求值） */
const P_N_IN = (id: string, label: string): GPortDef => ({ id, label, direction: "in", dataType: "number" });
const P_N_OUT = (id: string, label: string): GPortDef => ({ id, label, direction: "out", dataType: "number" });
const P_S_OUT = (id: string, label: string): GPortDef => ({ id, label, direction: "out", dataType: "string" });

const MATH_TYPES: GNodeTypeDef[] = [
  // 算术
  { type: "math.add", category: "math", label: "加法", desc: "a + b", color: "#4ec9b0",
    inputs: [P_N_IN("a", "A"), P_N_IN("b", "B")], outputs: [P_N_OUT("result", "结果")] },
  { type: "math.sub", category: "math", label: "减法", desc: "a - b", color: "#4ec9b0",
    inputs: [P_N_IN("a", "A"), P_N_IN("b", "B")], outputs: [P_N_OUT("result", "结果")] },
  { type: "math.mul", category: "math", label: "乘法", desc: "a × b", color: "#4ec9b0",
    inputs: [P_N_IN("a", "A"), P_N_IN("b", "B")], outputs: [P_N_OUT("result", "结果")] },
  { type: "math.div", category: "math", label: "除法", desc: "a ÷ b（除零回退 0）", color: "#4ec9b0",
    inputs: [P_N_IN("a", "A"), P_N_IN("b", "B")], outputs: [P_N_OUT("result", "结果")] },
  { type: "math.mod", category: "math", label: "取余", desc: "a mod b", color: "#4ec9b0",
    inputs: [P_N_IN("a", "A"), P_N_IN("b", "B")], outputs: [P_N_OUT("result", "结果")] },
  // 三角（角度制输入）
  { type: "math.sin", category: "math", label: "正弦", desc: "sin(a°)", color: "#dcdcaa",
    inputs: [P_N_IN("a", "角度")], outputs: [P_N_OUT("result", "结果")] },
  { type: "math.cos", category: "math", label: "余弦", desc: "cos(a°)", color: "#dcdcaa",
    inputs: [P_N_IN("a", "角度")], outputs: [P_N_OUT("result", "结果")] },
  { type: "math.tan", category: "math", label: "正切", desc: "tan(a°)", color: "#dcdcaa",
    inputs: [P_N_IN("a", "角度")], outputs: [P_N_OUT("result", "结果")] },
  // 向量
  { type: "math.vec3Make", category: "math", label: "合成向量", desc: "x, y, z → vec3", color: "#569cd6",
    inputs: [P_N_IN("x", "X"), P_N_IN("y", "Y"), P_N_IN("z", "Z")],
    outputs: [{ id: "v", label: "向量", direction: "out", dataType: "vec3" }] },
  { type: "math.vec3Break", category: "math", label: "分解向量", desc: "vec3 → x, y, z", color: "#569cd6",
    inputs: [{ id: "v", label: "向量", direction: "in", dataType: "vec3" }],
    outputs: [P_N_OUT("x", "X"), P_N_OUT("y", "Y"), P_N_OUT("z", "Z")] },
  // 字符串
  { type: "math.stringConcat", category: "math", label: "字符串拼接", desc: "a + b → string", color: "#ce9178",
    inputs: [
      { id: "a", label: "A", direction: "in", dataType: "string" },
      { id: "b", label: "B", direction: "in", dataType: "string" },
    ], outputs: [P_S_OUT("result", "结果")] },
  { type: "math.toString", category: "math", label: "转字符串", desc: "任意值 → string", color: "#ce9178",
    inputs: [{ id: "value", label: "值", direction: "in", dataType: "any" }],
    outputs: [P_S_OUT("result", "结果")] },
  // 插值/工具
  { type: "math.lerp", category: "math", label: "线性插值", desc: "lerp(a, b, t) = a + (b-a) × t", color: "#88c0d0",
    inputs: [P_N_IN("a", "A"), P_N_IN("b", "B"), P_N_IN("t", "T")],
    outputs: [P_N_OUT("result", "结果")] },
  { type: "math.clamp", category: "math", label: "钳制", desc: "clamp(value, min, max)", color: "#88c0d0",
    inputs: [P_N_IN("value", "值"), P_N_IN("min", "最小"), P_N_IN("max", "最大")],
    outputs: [P_N_OUT("result", "结果")] },
  { type: "math.abs", category: "math", label: "绝对值", desc: "|a|", color: "#88c0d0",
    inputs: [P_N_IN("a", "A")], outputs: [P_N_OUT("result", "结果")] },
  // 感知（实体世界状态 → 数值）
  { type: "sense.distance", category: "math", label: "实体距离", desc: "from 实体到 to 实体的世界距离（每帧拉取求值）", color: "#88c0d0",
    inputs: [
      { id: "from", label: "从", direction: "in", dataType: "entity" },
      { id: "to", label: "到", direction: "in", dataType: "entity" },
    ],
    outputs: [P_N_OUT("result", "距离")] },
];

/** 逻辑容器类节点（状态机容器 / 行为树容器；大框渲染，子节点以 containerId 归属，可嵌套） */
const LOGIC_TYPES: GNodeTypeDef[] = [
  {
    type: "fsm.container",
    category: "logic",
    label: "状态机容器",
    desc: "状态机容器：把携带 .fsm 的原型卡连到「作用域」即自动读取其状态；事件入端口触发状态切换，进入状态时执行归属该状态的子节点链；支持嵌套",
    color: "#569cd6",
    inputs: [
      P_EXEC_IN, // 进入容器（激活 initial 状态）
      { id: "event", label: "事件", direction: "in", dataType: "exec", multi: true }, // 状态切换
      { id: "in", label: "作用域", direction: "in", dataType: "entities", multi: true },
    ],
    outputs: [
      P_EXEC_OUT, // 状态切换完成
      { id: "out", label: "输出", direction: "out", dataType: "entities" },
    ],
    fields: [
      { key: "states", label: "状态列表", kind: "string", fallback: "idle,run", placeholder: "逗号分隔，如 idle,run,attack" },
      { key: "initial", label: "初始状态", kind: "string", fallback: "idle" },
    ],
  },
  {
    type: "bt.container",
    category: "logic",
    label: "行为树容器",
    desc: "行为树容器：把携带 .bt 的原型卡连到「作用域」即读取树构成（模式取树根类型）；进入时按子节点纵向顺序依次执行归属节点链，完成后触发退出；支持嵌套",
    color: "#4ec9b0",
    inputs: [
      P_EXEC_IN,
      { id: "in", label: "作用域", direction: "in", dataType: "entities", multi: true },
    ],
    outputs: [
      P_EXEC_OUT,
      { id: "out", label: "输出", direction: "out", dataType: "entities" },
    ],
    fields: [
      { key: "mode", label: "模式", kind: "string", fallback: "sequence" },
    ],
  },
];

/** 全部内置节点类型 */
const BUILTIN_TYPES: GNodeTypeDef[] = [...ENTITY_TYPES, ...EVENT_TYPES, ...OP_TYPES, ...DRIVER_TYPES, ...VARIABLE_TYPES, ...FLOW_TYPES, ...MATH_TYPES, ...LOGIC_TYPES];

/** 容器类型键集合（大框渲染 + 子节点归属 + 运行时状态化执行） */
export const CONTAINER_TYPES: ReadonlySet<string> = new Set(["fsm.container", "bt.container"]);

/** 是否容器节点 */
export function isContainerType(type: string): boolean {
  return CONTAINER_TYPES.has(type);
}

/** 容器默认尺寸 */
export const CONTAINER_DEFAULT_SIZE = { w: 560, h: 340 };
/** 容器尺寸钳制范围 */
export const CONTAINER_SIZE_LIMITS = { w: { min: 320, max: 2400 }, h: { min: 200, max: 2000 } };

const TYPE_MAP = new Map(BUILTIN_TYPES.map((d) => [d.type, d]));

// ---------------------------------------------------------------------------
// 自定义节点动态注册（用户可扩展节点类型）
// ---------------------------------------------------------------------------

const VALID_DATA_TYPES = new Set<GDataType>(["exec", "entity", "entities", "number", "boolean", "string", "vec3", "any"]);

/** 自定义节点定义 → 注册表条目（校验 + 转换） */
function customDefToTypeDef(d: GCustomNodeDef): GNodeTypeDef | null {
  if (!d.type.startsWith("custom.")) return null;
  const inputs: GPortDef[] = [];
  for (const p of d.inputs ?? []) {
    if (!p.id || !VALID_DATA_TYPES.has(p.dataType as GDataType)) continue;
    inputs.push({ id: p.id, label: p.label || p.id, direction: "in", dataType: p.dataType as GDataType });
  }
  const outputs: GPortDef[] = [];
  for (const p of d.outputs ?? []) {
    if (!p.id || !VALID_DATA_TYPES.has(p.dataType as GDataType)) continue;
    outputs.push({ id: p.id, label: p.label || p.id, direction: "out", dataType: p.dataType as GDataType });
  }
  const fields: GFieldDef[] = [];
  for (const f of d.fields ?? []) {
    if (!f.key) continue;
    fields.push({ key: f.key, label: f.label || f.key, kind: f.kind, fallback: f.fallback });
  }
  return {
    type: d.type,
    category: "custom",
    label: d.label || d.type,
    desc: d.desc || "",
    color: /^#[0-9a-fA-F]{6}$/.test(d.color) ? d.color : "#4ec9b0",
    inputs,
    outputs,
    fields: fields.length ? fields : undefined,
  };
}

/** 动态注册的自定义节点类型（每次图文档变更时刷新） */
const CUSTOM_TYPE_MAP = new Map<string, GNodeTypeDef>();

/** 注册自定义节点定义（替换全部；normalize 后调用） */
export function registerCustomNodeDefs(defs: GCustomNodeDef[]): void {
  CUSTOM_TYPE_MAP.clear();
  for (const d of defs) {
    const def = customDefToTypeDef(d);
    if (def) CUSTOM_TYPE_MAP.set(def.type, def);
  }
}

/** 统一类型查找（内置 + 自定义） */
function lookupTypeDef(type: string): GNodeTypeDef | null {
  return TYPE_MAP.get(type) ?? CUSTOM_TYPE_MAP.get(type) ?? null;
}

// ---------------------------------------------------------------------------
// 查询 API
// ---------------------------------------------------------------------------

/** 按类型键查节点类型定义（未知 null） */
export function nodeTypeDef(type: string): GNodeTypeDef | null {
  return lookupTypeDef(type);
}

/** 节点的输入端口列表 */
export function nodeInputs(type: string): GPortDef[] {
  return lookupTypeDef(type)?.inputs ?? [];
}

/** 节点的输出端口列表 */
export function nodeOutputs(type: string): GPortDef[] {
  return lookupTypeDef(type)?.outputs ?? [];
}

/** 节点的全部端口（输入 + 输出） */
export function nodePorts(type: string): GPortDef[] {
  const def = lookupTypeDef(type);
  if (!def) return [];
  return [...def.inputs, ...def.outputs];
}

/** 查节点某端口（不存在 null） */
export function nodePort(type: string, portId: string, direction: "in" | "out"): GPortDef | null {
  return nodePorts(type).find((p) => p.id === portId && p.direction === direction) ?? null;
}

/** 节点类别 */
export function nodeCategory(type: string): GNodeCategory | null {
  return lookupTypeDef(type)?.category ?? null;
}

/** 节点类型显示名 */
export function nodeTypeLabel(type: string): string {
  return lookupTypeDef(type)?.label ?? type;
}

/** 节点默认参数表（从 fields 的 fallback 填充） */
export function nodeDefaults(type: string): Record<string, number | boolean | string> {
  const def = lookupTypeDef(type);
  if (!def?.fields) return {};
  const params: Record<string, number | boolean | string> = {};
  for (const f of def.fields) params[f.key] = f.fallback;
  return params;
}

/** 两端口能否相连（数据类型兼容 + 方向由调用方保证 src=out / dst=in） */
export function canConnectPortsByType(
  srcType: string, srcPortId: string,
  dstType: string, dstPortId: string,
): boolean {
  const sp = nodePort(srcType, srcPortId, "out");
  const dp = nodePort(dstType, dstPortId, "in");
  if (!sp || !dp) return false;
  return canConnectDataTypes(sp.dataType, dp.dataType);
}


// ---------------------------------------------------------------------------
// 旧 kind → 新 type 迁移
// ---------------------------------------------------------------------------

/** 旧 kind/opType → 新 type 键（迁移用） */
export function migrateKindToType(kind: string, opType?: string): string {
  if (kind === "proto") return "entity.proto";
  if (kind === "match") return "entity.match";
  if (kind === "op" && opType) return opType;
  return "";
}

// ---------------------------------------------------------------------------
// 右键菜单分组（按类别组织）
// ---------------------------------------------------------------------------

export interface GNodeMenuGroup {
  category: GNodeCategory;
  label: string;
  items: GNodeTypeDef[];
}

/** 右键菜单可添加节点分组（排除 entity.proto —— 从层级拖入） */
export function nodeMenuGroups(): GNodeMenuGroup[] {
  const groups: GNodeMenuGroup[] = [];
  const byCat = new Map<GNodeCategory, GNodeTypeDef[]>();
  const allTypes = [...BUILTIN_TYPES, ...CUSTOM_TYPE_MAP.values()];
  for (const def of allTypes) {
    if (def.type === "entity.proto") continue;
    const list = byCat.get(def.category) ?? [];
    list.push(def);
    byCat.set(def.category, list);
  }
  const order: GNodeCategory[] = ["event", "entity", "logic", "driver", "op", "flow", "math", "variable", "custom"];
  const labels: Record<GNodeCategory, string> = {
    event: "事件",
    entity: "实体",
    logic: "逻辑容器",
    driver: "驱动器",
    op: "操作",
    flow: "控制流",
    math: "数学",
    variable: "变量",
    custom: "自定义",
  };
  for (const cat of order) {
    const items = byCat.get(cat);
    if (items?.length) groups.push({ category: cat, label: labels[cat], items });
  }
  return groups;
}

// re-export trigger labels for convenience
export { G_OP_TRIGGER_LABEL };
// ---------------------------------------------------------------------------
// 端口查询（注册表驱动；兼容旧 GPortInfo 接口）
// ---------------------------------------------------------------------------

import {
  GRAPH_DEFAULT_COMMENT_COLOR,
  graphStr as str,
  graphNum as num,
  type GComment,
  type GEdge,
  type GNode,
  type GVariable,
  type GVarDataType,
  type ScriptGraphDoc,
} from "./graphTypes";

/** 端口信息（运行时/连线校验用；dataType 取代旧 channel） */
export interface GPortInfo {
  id: string;
  direction: "in" | "out";
  dataType: GDataType;
  multi?: boolean;
}

/** 节点的全部端口（注册表查找；未知类型返回空） */
export function graphNodePorts(node: GNode): GPortInfo[] {
  return nodePorts(node.type).map((p) => ({
    id: p.id,
    direction: p.direction,
    dataType: p.dataType,
    ...(p.multi ? { multi: true } : {}),
  }));
}

/** 查节点端口（不存在 null） */
export function graphPort(node: GNode, portId: string, direction: "in" | "out"): GPortInfo | null {
  return graphNodePorts(node).find((p) => p.id === portId && p.direction === direction) ?? null;
}

/** 两端口能否相连（数据类型兼容；方向由调用方保证 src=out / dst=in） */
export function canConnectPorts(src: GPortInfo, dst: GPortInfo): boolean {
  return canConnectDataTypes(src.dataType, dst.dataType);
}

// ---------------------------------------------------------------------------
// 会话图收敛（从 opRegistry.ts 移入；含 kind→type 迁移）
// ---------------------------------------------------------------------------

const CLAMP_COORD = 20000;

/** 宽松形状校验（侧车装载预检） */
export function isGraphDoc(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.nodes) && Array.isArray(o.edges);
}

/**
 * 任意来源 → 收敛的场景图：
 * - 旧格式 kind/opType 自动迁移为 type；
 * - 未知 type 剔除；id 去重补齐；坐标钳制；
 * - proto.entityId / match 模式串收敛；
 * - op 参数按注册表字段钳制；
 * - 连线端口存在/数据类型兼容/自环剔除/入端口唯一（multi 口多入汇聚，同源保首条）；
 * - 注释框尺寸与文本钳制。
 */
export function normalizeGraphDoc(v: unknown): ScriptGraphDoc {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const clamp = (x: unknown) => Math.max(-CLAMP_COORD, Math.min(CLAMP_COORD, num(x, 0)));

  // ----- 自定义节点定义收敛（先于节点验证：注册后 nodeTypeDef 可查） -----
  const customNodes: GCustomNodeDef[] = [];
  const usedDefIds = new Set<string>();
  const usedDefTypes = new Set<string>();
  for (const rd of Array.isArray(o.customNodes) ? o.customNodes : []) {
    if (!rd || typeof rd !== "object") continue;
    const r = rd as Record<string, unknown>;
    let id = str(r.id);
    if (!id || usedDefIds.has(id)) {
      let i = customNodes.length + 1;
      id = `cd${i}`;
      while (usedDefIds.has(id)) id = `cd${++i}`;
    }
    let type = str(r.type);
    if (!type.startsWith("custom.")) type = `custom.${type || `node${customNodes.length + 1}`}`;
    if (usedDefTypes.has(type)) continue;
    usedDefIds.add(id);
    usedDefTypes.add(type);
    const inputs: GCustomPort[] = [];
    for (const rp of Array.isArray(r.inputs) ? r.inputs : []) {
      if (!rp || typeof rp !== "object") continue;
      const p = rp as Record<string, unknown>;
      const pid = str(p.id);
      if (!pid) continue;
      inputs.push({ id: pid, label: str(p.label).slice(0, 32), dataType: str(p.dataType, "number") });
    }
    const outputs: GCustomPort[] = [];
    for (const rp of Array.isArray(r.outputs) ? r.outputs : []) {
      if (!rp || typeof rp !== "object") continue;
      const p = rp as Record<string, unknown>;
      const pid = str(p.id);
      if (!pid) continue;
      outputs.push({ id: pid, label: str(p.label).slice(0, 32), dataType: str(p.dataType, "number") });
    }
    const fields: GCustomField[] = [];
    for (const rf of Array.isArray(r.fields) ? r.fields : []) {
      if (!rf || typeof rf !== "object") continue;
      const f = rf as Record<string, unknown>;
      const key = str(f.key);
      if (!key) continue;
      const kind = f.kind === "number" ? "number" : f.kind === "boolean" ? "boolean" : "string";
      fields.push({ key, label: str(f.label).slice(0, 32), kind, fallback: kind === "number" ? num(f.fallback, 0) : kind === "boolean" ? f.fallback === true : str(f.fallback).slice(0, 512) });
    }
    const expressions: Record<string, string> = {};
    const rawExpr = (r.expressions && typeof r.expressions === "object" ? r.expressions : {}) as Record<string, unknown>;
    for (const [k, val] of Object.entries(rawExpr)) {
      expressions[k] = str(val).slice(0, 512);
    }
    customNodes.push({
      id,
      type,
      label: str(r.label).slice(0, 64) || type,
      desc: str(r.desc).slice(0, 256),
      color: /^#[0-9a-fA-F]{6}$/.test(str(r.color)) ? str(r.color) : "#4ec9b0",
      inputs,
      outputs,
      fields,
      expressions,
    });
  }
  registerCustomNodeDefs(customNodes);

  const nodes: GNode[] = [];
  const usedIds = new Set<string>();
  const takeId = (raw: unknown, prefix: string): string => {
    let id = typeof raw === "string" && raw && !usedIds.has(raw) ? raw : "";
    if (!id) {
      let i = usedIds.size + 1;
      id = `${prefix}${i}`;
      while (usedIds.has(id)) id = `${prefix}${++i}`;
    }
    usedIds.add(id);
    return id;
  };
  for (const rn of Array.isArray(o.nodes) ? o.nodes : []) {
    if (!rn || typeof rn !== "object") continue;
    const r = rn as Record<string, unknown>;
    // type 迁移：优先用 type 字段；缺省从旧 kind/opType 推导
    let type = str(r.type);
    if (!type) type = migrateKindToType(str(r.kind), str(r.opType));
    if (!type || !nodeTypeDef(type)) continue;
    const node: GNode = { id: takeId(r.id, "n"), type, x: clamp(r.x), y: clamp(r.y) };
    if (type === "entity.proto") node.entityId = str(r.entityId);
    if (type === "entity.match") {
      node.matchMode = r.matchMode === "type" ? "type" : "tag";
      node.matchPattern = str(r.matchPattern).slice(0, 64);
    }
    if (type === "var.get" || type === "var.set") node.varId = str(r.varId);
    // 逻辑容器：尺寸钳制（缺省 560×340）
    if (isContainerType(type)) {
      node.w = Math.max(
        CONTAINER_SIZE_LIMITS.w.min,
        Math.min(CONTAINER_SIZE_LIMITS.w.max, num(r.w, CONTAINER_DEFAULT_SIZE.w)),
      );
      node.h = Math.max(
        CONTAINER_SIZE_LIMITS.h.min,
        Math.min(CONTAINER_SIZE_LIMITS.h.max, num(r.h, CONTAINER_DEFAULT_SIZE.h)),
      );
    }
    // 容器归属与状态归属标签（存在性/防环校验在节点收集后统一做）
    const rawContainerId = str(r.containerId);
    if (rawContainerId) node.containerId = rawContainerId;
    const stateName = str(r.stateName).trim().slice(0, 48);
    if (stateName) node.stateName = stateName;
    const def = nodeTypeDef(type);
    if (def?.fields?.length) {
      const params: Record<string, number | boolean | string> = {};
      const rawParams = (r.params && typeof r.params === "object" ? r.params : {}) as Record<string, unknown>;
      for (const f of def.fields) {
        const v = rawParams[f.key];
        if (f.kind === "number") params[f.key] = num(v, f.fallback as number);
        else if (f.kind === "boolean") params[f.key] = v === true;
        else params[f.key] = str(v, f.fallback as string).slice(0, 512);
      }
      node.params = params;
    }
    // 保留旧 opType 字段（向后兼容运行时）
    if (type.startsWith("op.")) node.opType = type;
    const title = str(r.title).trim().slice(0, 64);
    if (title) node.title = title;
    nodes.push(node);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // ----- 容器归属收敛：目标须为存在的容器节点；沿归属链防环（自环/循环剔除） -----
  const containerOk = new Set(nodes.filter((n) => isContainerType(n.type)).map((n) => n.id));
  for (const n of nodes) {
    const cid = n.containerId;
    if (!cid) continue;
    if (cid === n.id || !containerOk.has(cid)) {
      delete n.containerId;
      continue;
    }
    let cur: string | undefined = cid;
    const seen = new Set<string>([n.id]);
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      cur = byId.get(cur)?.containerId;
    }
    if (cur === n.id) delete n.containerId;
  }

  const edges: GEdge[] = [];
  const usedEdgeIds = new Set<string>();
  const wired = new Set<string>();
  for (const re of Array.isArray(o.edges) ? o.edges : []) {
    if (!re || typeof re !== "object") continue;
    const r = re as Record<string, unknown>;
    const srcNode = str(r.srcNode);
    const srcPort = str(r.srcPort);
    const dstNode = str(r.dstNode);
    const dstPort = str(r.dstPort);
    const src = byId.get(srcNode);
    const dst = byId.get(dstNode);
    if (!src || !dst || srcNode === dstNode) continue;
    const sp = graphPort(src, srcPort, "out");
    const dp = graphPort(dst, dstPort, "in");
    if (!sp || !dp || !canConnectDataTypes(sp.dataType, dp.dataType)) continue;
    const key = `${dstNode}\u0000${dstPort}`;
    if (dp.multi) {
      // multi 口多入汇聚（目标/路径点等）：不同源的多条连线保留，同源同引脚重复保首条
      const dup = `${key}\u0000${srcNode}\u0000${srcPort}`;
      if (wired.has(dup)) continue;
      wired.add(dup);
    } else {
      if (wired.has(key)) continue;
      wired.add(key);
    }
    let id = str(r.id);
    if (!id || usedEdgeIds.has(id)) {
      let i = usedEdgeIds.size + 1;
      id = `e${i}`;
      while (usedEdgeIds.has(id)) id = `e${++i}`;
    }
    usedEdgeIds.add(id);
    edges.push({ id, srcNode, srcPort, dstNode, dstPort });
  }

  const comments: GComment[] = [];
  for (const rc of Array.isArray(o.comments) ? o.comments : []) {
    if (!rc || typeof rc !== "object") continue;
    const r = rc as Record<string, unknown>;
    let id = str(r.id);
    if (!id || usedIds.has(id)) {
      let i = comments.length + 1;
      id = `c${i}`;
      while (comments.some((c) => c.id === id)) id = `c${++i}`;
    }
    comments.push({
      id,
      x: clamp(r.x),
      y: clamp(r.y),
      w: Math.max(80, Math.min(2000, num(r.w, 240))),
      h: Math.max(60, Math.min(2000, num(r.h, 140))),
      text: str(r.text).slice(0, 2000),
      color: /^#[0-9a-fA-F]{6}$/.test(str(r.color)) ? str(r.color) : GRAPH_DEFAULT_COMMENT_COLOR,
    });
  }

  // ----- 变量收敛 -----
  const variables: GVariable[] = [];
  const usedVarIds = new Set<string>();
  const validVarDataTypes = new Set<GVarDataType>(["number", "boolean", "string"]);
  for (const rv of Array.isArray(o.variables) ? o.variables : []) {
    if (!rv || typeof rv !== "object") continue;
    const r = rv as Record<string, unknown>;
    let id = str(r.id);
    if (!id || usedVarIds.has(id)) {
      let i = variables.length + 1;
      id = `v${i}`;
      while (usedVarIds.has(id)) id = `v${++i}`;
    }
    usedVarIds.add(id);
    const dataType = validVarDataTypes.has(r.dataType as GVarDataType) ? (r.dataType as GVarDataType) : "number";
    let value: number | boolean | string;
    if (dataType === "number") value = num(r.value, 0);
    else if (dataType === "boolean") value = r.value === true;
    else value = str(r.value).slice(0, 512);
    variables.push({ id, name: str(r.name).slice(0, 64) || `var${variables.length + 1}`, dataType, value });
  }

  return { nodes, edges, comments, variables, customNodes };
}

/** 空白场景图（新场景/装载失败回退） */
export function emptyGraphDoc(): ScriptGraphDoc {
  return { nodes: [], edges: [], comments: [], variables: [], customNodes: [] };
}