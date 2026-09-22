// ---------------------------------------------------------------------------
// 场景图节点类型注册表（通用节点类型系统 + 模块注入）：
// 每种节点类型定义其端口（输入/输出 + 数据类型）、可编辑字段与能力位
// （capability），端口与能力驱动连线校验/运行时调度/画布渲染。
//
// 注册表为「模块注入」架构：一切类型经 registerModule(manifest) 进入注册表，
// 内置类型同样经此路径注册（core-* 模块自食狗粮），自定义节点定义归并为
// "custom" 模块。注入模块（L1 脚本图模块等）与内置模块共用同一注册/查询/
// 菜单/校验管线；运行时侧的语义 handler 按类型键在 graph-kernel 注册表中
// 绑定（runtime/graph-runtime.ts），双端共享同一份 manifest。
//
// 内置类型分五大类：
// - entity：原型（拖入实体）/ 匹配（标签|类型筛选）—— 实体集源
// - event：OnBegin / OnTick / OnClick —— 执行链入口（触发时机）
// - op：原子操作（设置/旋转/浮动/FSM…）—— 有 exec 入端口 + next 出端口
// - flow：控制流（Branch/Switch/比较/循环…）
// - math：数学/工具（加减乘除/sin/cos/lerp…）
// ---------------------------------------------------------------------------

import { GRAPH_OP_DEFS, G_OP_TRIGGER_LABEL, type GOpDef, type GOpFieldDef } from "./opRegistry";
import {
  GRAPH_DEFAULT_COMMENT_COLOR,
  GRAPH_FORMAT_VERSION,
  graphStr as str,
  graphNum as num,
  type GComment,
  type GCustomField,
  type GCustomNodeDef,
  type GCustomPort,
  type GEdge,
  type GModuleRef,
  type GNode,
  type GVariable,
  type GVarDataType,
  type ScriptGraphDoc,
} from "./graphTypes";

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

/** 两数据类型能否相连（同类型 / any 通配 / entity→entities 提升；exec 通道独占） */
export function canConnectDataTypes(src: GDataType, dst: GDataType): boolean {
  if (src === dst) return true;
  // 执行链通道与数据通道互不相连（exec 出入只接 exec，杜绝静默无效连线）
  if (src === "exec" || dst === "exec") return false;
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

/** 节点类别（右键菜单分组 + 颜色基调；registerCategory 可扩展） */
export type GNodeCategory = "entity" | "event" | "op" | "flow" | "math" | "variable" | "custom" | "logic" | "driver";

/**
 * 节点能力位：取代一切按类型键字符串的特判
 * （容器判定/实体集源/执行链入口/帧驱动实例态等）。
 * 运行时 kernel 与画布均按能力位分发，注入模块声明能力即获得对应待遇。
 */
export interface GNodeCapabilities {
  /** 实体集源（proto/match）：out 引脚求值 = 自身解析出的实体集 */
  entitySource?: boolean;
  /**
   * 脚本接入口（proto）：in 引脚接入的实体集/数据在变化时交付给所引实体上的
   * 脚本实例（脚本 onGraphInput 接收 / this.graphInput 轮询）
   */
  scriptInlet?: boolean;
  /** 执行链入口（事件节点）：按 trigger 在运行时绑定（start/frame/click） */
  eventEntry?: boolean;
  /** 原子操作（一次性语义，有 executor） */
  op?: boolean;
  /** 驱动器（帧驱动 + 实例态；kernel 维护跨帧状态并每帧步进） */
  driver?: boolean;
  /** 逻辑容器（大框渲染 + containerId 归属 + 运行时状态化执行，可嵌套） */
  container?: boolean;
  /** 表达式数据节点（自定义节点：输出引脚由 JS 表达式求值） */
  expression?: boolean;
  /**
   * 中断开关（控制流通断）：锁存通断状态；断开时下游执行链不级联、
   * 下游帧驱动器暂停步进（「开/关」执行口翻转，恢复后继续）
   */
  gate?: boolean;
}

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
  /** 事件/操作节点触发时机（category event/op/driver 用；旧图无 exec 入边时按此独立执行） */
  trigger?: "start" | "frame" | "click";
  /** 能力位（kernel/UI 按能力分发，不按类型键特判） */
  capabilities?: GNodeCapabilities;
}

// ---------------------------------------------------------------------------
// 类别元信息（右键菜单分组标签与顺序；可扩展）
// ---------------------------------------------------------------------------

export interface GCategoryDef {
  id: GNodeCategory;
  label: string;
  /** 菜单展示顺序（越小越前；缺省类别表外的新类别追加于后） */
  order: number;
}

const CATEGORY_MAP = new Map<GNodeCategory, GCategoryDef>();

/** 注册/更新类别元信息（注入模块可新增分组） */
export function registerCategory(def: GCategoryDef): void {
  if (!def || !def.id) return;
  CATEGORY_MAP.set(def.id, def);
}

/** 全部类别（按 order 升序） */
export function categoryDefs(): GCategoryDef[] {
  return [...CATEGORY_MAP.values()].sort((a, b) => a.order - b.order);
}

// ---------------------------------------------------------------------------
// 模块注册表（注入的单一入口）
// ---------------------------------------------------------------------------

/** 图模块清单（编辑器与运行时共用的单一事实源；manifest 描述目录，语义 handler 在 runtime 侧按类型键绑定） */
export interface GraphModuleManifest {
  /** 模块 id（唯一；重复注册视为整体替换） */
  id: string;
  version: number;
  nodeTypes: GNodeTypeDef[];
}

const MODULE_MAP = new Map<string, GraphModuleManifest>();
/** 类型键 → 类型定义 */
const TYPE_MAP = new Map<string, GNodeTypeDef>();
/** 类型键 → 归属模块 id（冲突检测） */
const TYPE_OWNER = new Map<string, string>();

/** 模块注册前的浅校验（畸形条目剔除，返回可注册的类型表） */
function sanitizeModuleTypes(manifest: GraphModuleManifest): GNodeTypeDef[] {
  const out: GNodeTypeDef[] = [];
  for (const def of Array.isArray(manifest.nodeTypes) ? manifest.nodeTypes : []) {
    if (!def || typeof def.type !== "string" || !def.type) continue;
    if (!Array.isArray(def.inputs) || !Array.isArray(def.outputs)) continue;
    out.push(def);
  }
  return out;
}

/**
 * 注册图模块（同 id 重注册 = 整体替换旧类型）。
 * 类型键与已注册模块冲突时整模块拒绝并告警（返回 false），
 * 防止注入模块悄悄覆盖内置语义。
 */
export function registerModule(manifest: GraphModuleManifest): boolean {
  if (!manifest || typeof manifest.id !== "string" || !manifest.id) return false;
  const types = sanitizeModuleTypes(manifest);
  for (const def of types) {
    const owner = TYPE_OWNER.get(def.type);
    if (owner && owner !== manifest.id) {
      console.warn(`[graph] 模块 "${manifest.id}" 的类型 "${def.type}" 与模块 "${owner}" 冲突，整模块未注册`);
      return false;
    }
  }
  // 替换语义：先摘除本模块旧类型
  const prev = MODULE_MAP.get(manifest.id);
  if (prev) {
    for (const d of prev.nodeTypes) {
      if (TYPE_OWNER.get(d.type) === manifest.id) {
        TYPE_MAP.delete(d.type);
        TYPE_OWNER.delete(d.type);
      }
    }
  }
  for (const def of types) {
    TYPE_MAP.set(def.type, def);
    TYPE_OWNER.set(def.type, manifest.id);
  }
  MODULE_MAP.set(manifest.id, { ...manifest, nodeTypes: types });
  return true;
}

/** 注销模块及其全部类型 */
export function unregisterModule(id: string): void {
  const prev = MODULE_MAP.get(id);
  if (!prev) return;
  for (const d of prev.nodeTypes) {
    if (TYPE_OWNER.get(d.type) === id) {
      TYPE_MAP.delete(d.type);
      TYPE_OWNER.delete(d.type);
    }
  }
  MODULE_MAP.delete(id);
}

/** 已注册模块清单（图文档 modules 指纹快照用） */
export function listGraphModules(): GraphModuleManifest[] {
  return [...MODULE_MAP.values()];
}

/** 类型键 → 归属模块 id（未知 null） */
export function moduleOfNodeType(type: string): string | null {
  return TYPE_OWNER.get(type) ?? null;
}

/** 全部类型定义（注册表视图；右键菜单/检查遍历用） */
export function allNodeTypeDefs(): GNodeTypeDef[] {
  return [...TYPE_MAP.values()];
}

// ---------------------------------------------------------------------------
// 端口工厂（简化注册）
// ---------------------------------------------------------------------------

const P_EXEC_IN: GPortDef = { id: "exec", label: "", direction: "in", dataType: "exec" };
const P_EXEC_OUT: GPortDef = { id: "next", label: "", direction: "out", dataType: "exec" };
const P_ENTITIES_IN: GPortDef = { id: "in", label: "目标", direction: "in", dataType: "entities", multi: true };
const P_ENTITIES_OUT: GPortDef = { id: "out", label: "输出", direction: "out", dataType: "entities" };

// ---------------------------------------------------------------------------
// 内置类型注册（与注入模块同路径：打包为 core-* manifest → registerModule）
// ---------------------------------------------------------------------------

/** 实体类节点 */
const ENTITY_TYPES: GNodeTypeDef[] = [
  {
    type: "entity.proto",
    category: "entity",
    label: "原型",
    desc: "拖入场景实体生成原型卡片，属性以场景当前值为参照；「接入」口把实体集/数据传给实体上的脚本",
    color: "#4ec9b0",
    inputs: [{ id: "in", label: "接入", direction: "in", dataType: "any", multi: true }],
    outputs: [{ id: "out", label: "输出", direction: "out", dataType: "entities" }],
    capabilities: { entitySource: true, scriptInlet: true },
  },
  {
    type: "entity.match",
    category: "entity",
    label: "匹配",
    desc: "按标签或类型批量匹配场景实体",
    color: "#4ec9b0",
    inputs: [],
    outputs: [{ id: "out", label: "输出", direction: "out", dataType: "entities" }],
    capabilities: { entitySource: true },
  },
  {
    type: "entity.prop",
    category: "entity",
    label: "属性读取",
    desc: "拉模型读取目标实体的任意属性（点分路径，不限于位置/旋转/状态）",
    color: "#569cd6",
    inputs: [{ id: "target", label: "实体", direction: "in", dataType: "entity" }],
    outputs: [{ id: "value", label: "值", direction: "out", dataType: "any" }],
    fields: [
      {
        key: "property",
        label: "属性路径",
        kind: "string",
        fallback: "position.x",
        placeholder: "点选候选或直接输入路径（悬停查看语法）",
      },
    ],
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
    capabilities: { eventEntry: true },
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
    capabilities: { eventEntry: true },
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
    capabilities: { eventEntry: true },
  },
];

/** 操作类节点（从 opRegistry 的 GRAPH_OP_DEFS 转换；frame 触发 = 驱动器语义） */
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
  capabilities: { op: true, ...(op.trigger === "frame" ? { driver: true } : {}) },
}));

// op.patrol：追加「路径点」引脚（路径口接入路径点实体 → 依次巡回）
const patrolDef = OP_TYPES.find((d) => d.type === "op.patrol");
if (patrolDef) {
  patrolDef.inputs.splice(1, 0, {
    id: "path", label: "路径点", direction: "in", dataType: "entities", multi: true,
  });
}

// 帧驱动类操作（持续旋转/上下浮动/路径巡逻）统一归入「驱动器」分组：
// 「操作」组只留一次性/交互语义（设置属性/FSM 事件/FSM 参数/获取子级），
// 避免同一帧驱动语义在两组各出现一张卡。
for (const d of OP_TYPES) {
  if (d.trigger === "frame") d.category = "driver";
}

// op.children「获取子级」：实体集变换卡（目标集 → 直属子级实体集）。
// 纯实体集通道语义（无 exec 引脚、无 trigger）：out 经 core-entity 解析器
// 输出各目标在场景树中的直属子级（按对象树标记，多个目标按连线顺序合并去重），
// 可接任意「目标/集合」入引脚做批量操作，或 ForEach 遍历按序取每个子级（其
// 「当前」引脚现在也能接操作「目标」通道）。深层孙级经链式多张本卡获取。
OP_TYPES.push({
  type: "op.children",
  category: "op",
  label: "获取子级",
  desc: "获取目标实体的直属子级实体数组（场景层级中的下一层；多目标合并去重），输出实体集可接操作/遍历/属性读取的集合引脚；属性路径不再支持子级寻址，读写子级属性先经本卡换作用对象，配合 ForEach 遍历按序取每个子级",
  color: "#6a9955",
  inputs: [P_ENTITIES_IN],
  outputs: [P_ENTITIES_OUT],
  fields: [],
  capabilities: { entitySource: true },
});

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
    capabilities: { op: true, driver: true },
  },
  {
    type: "op.chase",
    category: "driver",
    label: "追击目标",
    desc: "每帧朝 prey 引脚接入的实体移动（速度 units/s）；场景有导航区域时按烘焙网格自动寻路绕行障碍（定期重寻路，不可达回退直线）；移动时朝向移动方向（+Z 前向，同导航代理；可关）；常与 sense.distance + 分支组合成追击/放弃",
    color: "#dcdcaa",
    trigger: "frame",
    inputs: [
      P_ENTITIES_IN,
      P_EXEC_IN,
      { id: "prey", label: "追击目标", direction: "in", dataType: "entity" },
    ],
    outputs: [P_ENTITIES_OUT, P_EXEC_OUT],
    fields: [
      { key: "speed", label: "速度", kind: "number", fallback: 3, step: 0.1 },
      { key: "faceMove", label: "朝向移动方向", kind: "boolean", fallback: true },
    ],
    capabilities: { op: true, driver: true },
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
  {
    type: "flow.gate",
    category: "flow",
    label: "中断开关",
    desc: "电路开关式通断控制：串入执行链，「关」口触发后中断下游——执行链不再级联、下游帧驱动器（导航移动/路径巡逻/追击等）暂停步进，「开」口触发恢复；都不触发时按「初始断开」放行。常与状态机组合：进入追击状态关断巡逻/导航链，回到巡逻状态闭合",
    color: "#c586c0",
    inputs: [
      P_EXEC_IN,
      { id: "on", label: "开", direction: "in", dataType: "exec", multi: true },
      { id: "off", label: "关", direction: "in", dataType: "exec", multi: true },
    ],
    outputs: [P_EXEC_OUT],
    fields: [{ key: "initialOpen", label: "初始断开", kind: "boolean", fallback: false }],
    capabilities: { gate: true },
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
    desc: "状态机容器：把携带 .fsm 的原型卡连到「作用域」即自动读取其状态；「事件」入端口按事件名切换状态，「条件」入端口接入比较结果（结果为真时按比较卡「触发事件名」切换：事件名是状态名则直接切换，否则经「切换事件」映射到目标状态）；进入状态时执行归属该状态的子节点链；迁移守卫（from>to 列表）限制指定迁移只允许从某状态出发，未列出的迁移不受限；重复切到当前状态默认忽略（勾选「重复进入」可重入）；支持嵌套",
    color: "#569cd6",
    inputs: [
      P_EXEC_IN, // 进入容器（激活 initial 状态）
      { id: "event", label: "事件", direction: "in", dataType: "exec", multi: true }, // 按事件名切换
      { id: "condition", label: "条件", direction: "in", dataType: "boolean", multi: true }, // 比较结果驱动切换
      { id: "in", label: "作用域", direction: "in", dataType: "entities", multi: true },
    ],
    outputs: [
      P_EXEC_OUT, // 状态切换完成
      { id: "out", label: "输出", direction: "out", dataType: "entities" },
    ],
    fields: [
      { key: "states", label: "状态列表", kind: "string", fallback: "idle,run", placeholder: "逗号分隔，如 idle,run,attack" },
      { key: "initial", label: "初始状态", kind: "string", fallback: "idle" },
      { key: "guards", label: "迁移守卫", kind: "string", fallback: "", placeholder: "from>to 逗号分隔，如 patrol>attack（只列要限制方向的迁移；留空不限制）" },
      { key: "transitions", label: "切换事件", kind: "string", fallback: "", placeholder: "事件>状态 逗号分隔，如 start_chase>Chase（比较卡「触发事件名」填事件名即可切到对应状态；留空则事件名即状态名）" },
      { key: "reentry", label: "重复进入", kind: "boolean", fallback: false },
    ],
    capabilities: { container: true },
  },
  {
    type: "bt.container",
    category: "logic",
    label: "行为树容器",
    desc: "行为树容器：把携带 .bt 的原型卡连到「作用域」读取树构成（模式取树根类型）；成员卡不参与全局事件驱动，由容器调度——顺序（sequence）：进入时按纵向顺序全部执行；选择（selector）：条件口布尔源与成员按纵向顺序配对，只执行第一个为真条件所配对的成员；并行（parallel）：进入时全部执行，激活期间每帧重跑成员链。「重跑间隔」> 0 时按秒周期性重跑（0 = 仅进入时一次）；进入过一次即激活，激活期间框内帧驱动器（巡逻/追击/旋转等）每帧步进；「退出」口触发后停摆（驱动器冻结在当前位姿，再「进入」恢复）；嵌套在状态机里时打「所属状态」随父级自动启停；支持嵌套",
    color: "#4ec9b0",
    inputs: [
      P_EXEC_IN,
      { id: "exit", label: "退出", direction: "in", dataType: "exec", multi: true }, // 停摆：帧驱动停止、成员驱动器冻结（再「进入」恢复）
      { id: "condition", label: "条件", direction: "in", dataType: "boolean", multi: true }, // selector 模式：与成员纵向配对
      { id: "in", label: "作用域", direction: "in", dataType: "entities", multi: true },
    ],
    outputs: [
      P_EXEC_OUT,
      { id: "out", label: "输出", direction: "out", dataType: "entities" },
    ],
    fields: [
      { key: "mode", label: "模式", kind: "string", fallback: "sequence", placeholder: "sequence / selector / parallel" },
      { key: "interval", label: "重跑间隔（秒）", kind: "number", fallback: 0, step: 0.1 },
    ],
    capabilities: { container: true },
  },
];

// ---------------------------------------------------------------------------
// 内置 manifest 注册（与注入模块同一路径；类别元信息同步注册）
// ---------------------------------------------------------------------------

const BUILTIN_CATEGORY_DEFS: GCategoryDef[] = [
  { id: "event", label: "事件", order: 0 },
  { id: "entity", label: "实体", order: 1 },
  { id: "logic", label: "逻辑容器", order: 2 },
  { id: "driver", label: "驱动器", order: 3 },
  { id: "op", label: "操作", order: 4 },
  { id: "flow", label: "控制流", order: 5 },
  { id: "math", label: "数学", order: 6 },
  { id: "variable", label: "变量", order: 7 },
  { id: "custom", label: "自定义", order: 8 },
];
for (const c of BUILTIN_CATEGORY_DEFS) CATEGORY_MAP.set(c.id, c);

/** 内置 core 模块（一个类别一个模块；与 L1 注入模块共用 registerModule 通道） */
const CORE_MODULE_DEFS: GraphModuleManifest[] = [
  { id: "core-entity", version: 1, nodeTypes: ENTITY_TYPES },
  { id: "core-event", version: 1, nodeTypes: EVENT_TYPES },
  { id: "core-op", version: 1, nodeTypes: OP_TYPES },
  { id: "core-driver", version: 1, nodeTypes: DRIVER_TYPES },
  { id: "core-variable", version: 1, nodeTypes: VARIABLE_TYPES },
  { id: "core-flow", version: 1, nodeTypes: FLOW_TYPES },
  { id: "core-math", version: 1, nodeTypes: MATH_TYPES },
  { id: "core-container", version: 1, nodeTypes: LOGIC_TYPES },
];
for (const m of CORE_MODULE_DEFS) registerModule(m);

/** 旧静态容器键（外部契约保留；能力位是新判定路径） */
export const CONTAINER_TYPES: ReadonlySet<string> = new Set(["fsm.container", "bt.container"]);

/** 是否容器节点（能力位判定；注入模块声明 container 能力即可扩展） */
export function isContainerType(type: string): boolean {
  return TYPE_MAP.get(type)?.capabilities?.container === true;
}

/** 按能力位查类型是否具备某能力 */
export function hasNodeTypeCapability(type: string, cap: keyof GNodeCapabilities): boolean {
  return TYPE_MAP.get(type)?.capabilities?.[cap] === true;
}

/** 全部容器类型键（动态视图） */
export function containerTypes(): string[] {
  return allNodeTypeDefs().filter((d) => d.capabilities?.container).map((d) => d.type);
}

/** 容器默认尺寸 */
export const CONTAINER_DEFAULT_SIZE = { w: 560, h: 340 };
/** 容器尺寸钳制范围 */
export const CONTAINER_SIZE_LIMITS = { w: { min: 320, max: 2400 }, h: { min: 200, max: 2000 } };

// ---------------------------------------------------------------------------
// 自定义节点动态注册（用户可扩展节点类型；归并为 "custom" 模块注入）
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
    capabilities: { expression: true },
  };
}

/** 注册自定义节点定义（替换全部；经 registerModule("custom") 注入通道） */
export function registerCustomNodeDefs(defs: GCustomNodeDef[]): void {
  const types: GNodeTypeDef[] = [];
  for (const d of defs) {
    const def = customDefToTypeDef(d);
    if (def) types.push(def);
  }
  registerModule({ id: "custom", version: 1, nodeTypes: types });
}

// ---------------------------------------------------------------------------
// 查询 API
// ---------------------------------------------------------------------------

/** 统一类型查找（内置 + 注入 + 自定义，同一张注册表） */
function lookupTypeDef(type: string): GNodeTypeDef | null {
  return TYPE_MAP.get(type) ?? null;
}

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
// 右键菜单分组（注册表驱动：类别元信息排序，注入模块自动成组）
// ---------------------------------------------------------------------------

export interface GNodeMenuGroup {
  category: GNodeCategory;
  label: string;
  items: GNodeTypeDef[];
}

/** 右键菜单可添加节点分组（排除 entity.proto —— 从层级拖入） */
export function nodeMenuGroups(): GNodeMenuGroup[] {
  const byCat = new Map<GNodeCategory, GNodeTypeDef[]>();
  for (const def of allNodeTypeDefs()) {
    if (def.type === "entity.proto") continue;
    const list = byCat.get(def.category) ?? [];
    list.push(def);
    byCat.set(def.category, list);
  }
  // 已知类别按 order；注册表里新出现的未知类别按出现顺序附尾
  const ordered = [...categoryDefs().map((c) => c.id)];
  for (const cat of byCat.keys()) if (!ordered.includes(cat)) ordered.push(cat);
  const groups: GNodeMenuGroup[] = [];
  for (const cat of ordered) {
    const items = byCat.get(cat);
    if (items?.length) {
      groups.push({ category: cat, label: CATEGORY_MAP.get(cat)?.label ?? cat, items });
    }
  }
  return groups;
}

// re-export trigger labels for convenience
export { G_OP_TRIGGER_LABEL };

// ---------------------------------------------------------------------------
// 端口查询（注册表驱动；兼容旧 GPortInfo 接口）
// ---------------------------------------------------------------------------

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
 * - 显式 type 在注册表查无（模块未装载）→ 保留节点并标记 unresolved
 *   （编辑器灰卡呈现；迁移而来的未知 kind 仍剔除）；
 * - id 去重补齐；坐标钳制；
 * - proto.entityId / match 模式串收敛；
 * - op 参数按注册表字段钳制；
 * - 连线端口存在/数据类型兼容/自环剔除/入端口唯一（multi 口多入汇聚，同源保首条）；
 * - 注释框尺寸与文本钳制；
 * - formatVersion/modules 文档元信息透传。
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
    const rawType = str(r.type);
    let type = rawType;
    if (!type) type = migrateKindToType(str(r.kind), str(r.opType));
    if (!type) continue;
    // 显式 type 查无注册表 = 模块未装载：保留节点并标记 unresolved（不静默剔除）；
    // 已知数据字段全部留存，模块装载后重新收敛即可恢复连线语义；
    // 旧 kind 迁移而来的未知类型仍按脏数据剔除
    if (!nodeTypeDef(type)) {
      if (!rawType) continue;
      const kept: GNode = { id: takeId(r.id, "n"), type, x: clamp(r.x), y: clamp(r.y), unresolved: true };
      const keepEntityId = str(r.entityId);
      if (keepEntityId) kept.entityId = keepEntityId;
      if (r.matchMode === "type" || r.matchMode === "tag") kept.matchMode = r.matchMode;
      const keepPattern = str(r.matchPattern).slice(0, 64);
      if (keepPattern) kept.matchPattern = keepPattern;
      const keepVarId = str(r.varId);
      if (keepVarId) kept.varId = keepVarId;
      if (r.params && typeof r.params === "object") kept.params = r.params as Record<string, number | boolean | string>;
      const keepState = str(r.stateName).trim().slice(0, 48);
      if (keepState) kept.stateName = keepState;
      const keepCid = str(r.containerId);
      if (keepCid) kept.containerId = keepCid;
      const keepTitle = str(r.title).trim().slice(0, 64);
      if (keepTitle) kept.title = keepTitle;
      nodes.push(kept);
      continue;
    }
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

  // ----- 文档元信息透传 -----
  const doc: ScriptGraphDoc = { nodes, edges, comments, variables, customNodes };
  const fv = num(o.formatVersion, 0);
  if (fv > 0) doc.formatVersion = fv;
  if (Array.isArray(o.modules)) {
    const refs: GModuleRef[] = [];
    for (const rm of o.modules) {
      if (!rm || typeof rm !== "object") continue;
      const m = rm as Record<string, unknown>;
      const id = str(m.id);
      if (!id) continue;
      refs.push({ id, version: Math.max(0, Math.floor(num(m.version, 0))) });
    }
    if (refs.length) doc.modules = refs;
  }
  return doc;
}

/** 模块指纹快照（当前注册表全模块 → doc.modules） */
export function graphModuleRefs(): GModuleRef[] {
  return listGraphModules().map((m) => ({ id: m.id, version: m.version }));
}

/** 空白场景图（新场景/装载失败回退） */
export function emptyGraphDoc(): ScriptGraphDoc {
  return { formatVersion: GRAPH_FORMAT_VERSION, nodes: [], edges: [], comments: [], variables: [], customNodes: [] };
}
