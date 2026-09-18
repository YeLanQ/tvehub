// ---------------------------------------------------------------------------
// 场景图原子操作目录（单一事实源，编辑器面板/检查器/运行时解释器共用）：
// 每种操作 = 一种预览运行时行为，触发时机由类型固定 ——
// - start：运行时启动时执行一次（属性设置 / FSM 参数）；
// - frame：每帧执行（持续旋转 / 上下浮动 / 路径巡逻 / 追击 / 导航移动，delta 累计语义）；
// - click：实体被点击时执行（FSM 事件）。
// 去重原则：可被通用卡组合替代的一次性卡不注册（如「点击显隐」= 属性读取 visible
// → 分支 → 设置属性 visible 0/1，已移除），避免同名功能两张卡并存。
// 参数表 fields 即卡片/检查器的可编辑项，缺省值同为新建与收敛回退。
// 运行语义与 tve SDK 对齐：属性路径为点分通用路径（变换各分量/visible 基础
// 之上，运行时另支持 light/material 分量、userData 与 script: 脚本属性，
// 解析规则见 runtime/graph-prop-path.ts；路径只寻址实体自身属性，子级需先经
// 「获取子级」/ForEach 换作用对象），FSM 操作经 engine.logic（fire/setParam）。
// ---------------------------------------------------------------------------

/** 操作触发时机（由操作类型固定） */
export type GOpTrigger = "start" | "frame" | "click";

export interface GOpFieldDef {
  key: string;
  label: string;
  kind: "number" | "string" | "boolean";
  fallback: number | string | boolean;
  step?: number;
  placeholder?: string;
}

export interface GOpDef {
  /** 注册表键（如 "op.spin"） */
  type: string;
  label: string;
  /** 一句话语义（运行时解释约定） */
  desc: string;
  trigger: GOpTrigger;
  color: string;
  fields: GOpFieldDef[];
}

/** 触发时机显示名 */
export const G_OP_TRIGGER_LABEL: Record<GOpTrigger, string> = {
  start: "启动时",
  frame: "每帧",
  click: "点击时",
};

/** 变换/可见性基础属性路径候选（运行时另支持 light·material·script: 等通用路径；子级属性先经「获取子级」/ForEach 换目标，见 runtime/graph-prop-path.ts） */
export const G_PROPERTY_PATHS = [
  "position.x",
  "position.y",
  "position.z",
  "rotation.x",
  "rotation.y",
  "rotation.z",
  "scale.x",
  "scale.y",
  "scale.z",
  "visible",
] as const;

const F_N = (key: string, label: string, fallback = 0, step = 0.1): GOpFieldDef => ({
  key,
  label,
  kind: "number",
  fallback,
  step,
});
const F_S = (key: string, label: string, fallback = "", placeholder?: string): GOpFieldDef => ({
  key,
  label,
  kind: "string",
  fallback,
  ...(placeholder ? { placeholder } : {}),
});

/** 原子操作注册表（顺序即展示顺序） */
export const GRAPH_OP_DEFS: GOpDef[] = [
  {
    type: "op.set",
    label: "设置属性",
    desc: "启动时把目标的指定属性设为 value（绝对值语义）",
    trigger: "start",
    color: "#4ec9b0",
    fields: [
      { key: "property", label: "属性", kind: "string", fallback: "position.y", placeholder: "点选候选或直接输入路径（如 light.intensity）" },
      { key: "value", label: "值", kind: "number", fallback: 0, step: 0.1 },
    ],
  },
  {
    type: "op.spin",
    label: "持续旋转",
    desc: "每帧按角速度（度/秒）累计旋转",
    trigger: "frame",
    color: "#dcdcaa",
    fields: [F_N("speedX", "X 速度", 0, 1), F_N("speedY", "Y 速度", 45, 1), F_N("speedZ", "Z 速度", 0, 1)],
  },
  {
    type: "op.bob",
    label: "上下浮动",
    desc: "每帧按正弦往复平移 Y（幅度 · 周期秒；以启动位置为基准）",
    trigger: "frame",
    color: "#dcdcaa",
    fields: [F_N("amplitude", "幅度", 0.5, 0.1), F_N("period", "周期（秒）", 2, 0.1)],
  },
  {
    type: "op.patrol",
    label: "路径巡逻",
    desc: "帧驱动移动：路径口接入路径点实体（空节点等）→ 依次巡回；未接路径 → 沿轴在起点与起点+距离间往返。起点为首次执行位置；移动时朝向移动方向（+Z 前向，同导航代理；可关）",
    trigger: "frame",
    color: "#dcdcaa",
    fields: [
      F_N("distance", "巡逻距离", 6, 0.5),
      F_N("speed", "速度", 2, 0.1),
      { key: "axis", label: "轴", kind: "string", fallback: "x", placeholder: "x / z / y" },
      { key: "faceMove", label: "朝向移动方向", kind: "boolean", fallback: true },
    ],
  },
  {
    type: "op.fireFsm",
    label: "FSM 事件",
    desc: "向目标的状态机发送事件（语义同 engine.logic.fire）",
    trigger: "click",
    color: "#569cd6",
    fields: [F_S("event", "事件名", "", "如 hit")],
  },
  {
    type: "op.setFsmParam",
    label: "FSM 参数",
    desc: "写目标状态机黑板参数（语义同 engine.logic.setParam）",
    trigger: "start",
    color: "#569cd6",
    fields: [F_S("param", "参数名"), F_N("value", "值", 1, 0.1)],
  },
];

const OP_MAP = new Map(GRAPH_OP_DEFS.map((d) => [d.type, d]));

/** 按类型查操作定义（未知 null） */
export function graphOpDef(type: string): GOpDef | null {
  return OP_MAP.get(type) ?? null;
}

/** 操作默认参数表（新建填充） */
export function graphOpDefaults(type: string): Record<string, number | boolean | string> {
  const def = OP_MAP.get(type);
  const params: Record<string, number | boolean | string> = {};
  if (!def) return params;
  for (const f of def.fields) params[f.key] = f.fallback;
  return params;
}

/** 操作参数摘要（卡片第二行） */
export function graphOpSummary(type: string, params: Record<string, unknown> | undefined): string {
  const def = OP_MAP.get(type);
  if (!def) return "";
  const parts: string[] = [];
  for (const f of def.fields) {
    const v = params?.[f.key];
    if (v === undefined || v === "" || v === f.fallback) continue;
    parts.push(f.kind === "boolean" ? (v ? `${f.label}` : `${f.label}：关`) : `${f.label} ${String(v)}`);
  }
  return parts.join(" · ");
}

