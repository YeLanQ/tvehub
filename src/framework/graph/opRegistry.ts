// ---------------------------------------------------------------------------
// 场景图原子操作目录（单一事实源，编辑器面板/检查器/运行时解释器共用）：
// 每种操作 = 一种预览运行时行为，触发时机由类型固定 ——
// - start：运行时启动时执行一次（属性设置 / FSM 事件 / FSM 参数）；
// - frame：每帧执行（持续旋转 / 上下浮动，delta 累计语义）；
// - click：实体被点击时执行（显隐切换）。
// 参数表 fields 即卡片/检查器的可编辑项，缺省值同为新建与收敛回退。
// 运行语义与 tve SDK 对齐：属性路径即 Entity 暴露的属性（position/rotation/
// scale 各分量、visible），FSM 操作经 engine.logic（fire/setParam）。
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

/** 可设属性路径候选（Entity 暴露的分量；setProperty 用） */
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
      { key: "property", label: "属性", kind: "string", fallback: "position.y" },
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
    desc: "帧驱动移动：路径口接入路径点实体（空节点等）→ 依次巡回；未接路径 → 沿轴在起点与起点+距离间往返。起点为首次执行位置",
    trigger: "frame",
    color: "#dcdcaa",
    fields: [
      F_N("distance", "巡逻距离", 6, 0.5),
      F_N("speed", "速度", 2, 0.1),
      { key: "axis", label: "轴", kind: "string", fallback: "x", placeholder: "x / z / y" },
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
  {
    type: "op.toggleVisible",
    label: "点击显隐",
    desc: "目标被点击时切换可见性（指针射线命中实体）",
    trigger: "click",
    color: "#c586c0",
    fields: [],
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
    parts.push(f.kind === "boolean" ? `${f.label}` : `${f.label} ${String(v)}`);
  }
  return parts.join(" · ");
}

