// ---------------------------------------------------------------------------
// 动画系统数据类型（framework 层，不依赖 app/api 与 three）。
//
// 两级能力：
// 1. 单剪辑模式（MeshNode.anim）：直接指定一个剪辑 + 速度/循环/自动播放；
// 2. 动画图模式（MeshNode.animGraph）：状态机——状态绑定剪辑，
//    过渡按“退出时间 + 参数条件”触发，期间交叉淡化；
//    参数（数值/布尔）由运行时（编辑器面板/脚本）注入。
//
// 所有结构都是可 JSON 序列化的纯数据（直接存进节点），读取时经
// parseAnimGraph 统一收敛（缺失/越界字段回退默认），保证旧场景兼容。
// ---------------------------------------------------------------------------

/** 循环模式：循环 / 播放一次 / 往复 */
export type AnimLoopMode = "loop" | "once" | "pingpong";

/** 动画图状态：一个状态绑定一个剪辑（clip 为空时保持当前姿势） */
export interface AnimGraphState {
  /** 状态名（图内唯一；也是过渡的 from/to 引用键） */
  name: string;
  /** 绑定的剪辑名（须存在于模型剪辑列表） */
  clip: string;
  /** 播放速度倍率 */
  speed: number;
  /** 循环模式 */
  loop: AnimLoopMode;
}

/** 参数条件比较运算（布尔参数按 0/1 参与数值比较） */
export type AnimConditionOp = ">" | "<" | ">=" | "<=" | "==" | "!=";

/** 单条过渡条件：param op value 全部满足才允许过渡 */
export interface AnimGraphCondition {
  param: string;
  op: AnimConditionOp;
  value: number;
}

/** 状态过渡：from → to，交叉淡化 duration 秒 */
export interface AnimGraphTransition {
  /** 过渡 id（图内唯一；编辑器增删用） */
  id: string;
  from: string;
  to: string;
  /** 过渡时长（秒；交叉淡化） */
  duration: number;
  /** 归一化退出时间 0..1（>0 表示源状态播放到该进度才允许过渡；0 = 条件满足即过渡） */
  exitTime: number;
  conditions: AnimGraphCondition[];
}

/** 图参数：数值（速度类）或布尔（开关/触发类）；运行时可写，默认值随图持久化 */
export type AnimGraphParamValue = number | boolean;

/** 动画图（状态机）完整定义 */
export interface AnimGraph {
  /** 入口状态名 */
  entry: string;
  states: AnimGraphState[];
  transitions: AnimGraphTransition[];
  /** 参数表（key → 默认值） */
  params: Record<string, AnimGraphParamValue>;
}

/** 单剪辑播放设置（MeshNode.anim 的形状） */
export interface AnimClipSettings {
  autoplay: boolean;
  /** 剪辑名（空 = 模型第一个剪辑） */
  clip: string;
  speed: number;
  loop: AnimLoopMode;
}

export const DEFAULT_CLIP_SETTINGS: AnimClipSettings = {
  autoplay: true,
  clip: "",
  speed: 1,
  loop: "loop",
};

const LOOP_MODES: AnimLoopMode[] = ["loop", "once", "pingpong"];
const OPS: AnimConditionOp[] = [">", "<", ">=", "<=", "==", "!="];

function str(v: unknown, fb = ""): string {
  return typeof v === "string" ? v : fb;
}
function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}
function bool(v: unknown, fb: boolean): boolean {
  return typeof v === "boolean" ? v : fb;
}

/** 深拷贝动画图（编辑器改图前的工作副本 / 节点克隆） */
export function cloneAnimGraph(g: AnimGraph): AnimGraph {
  return JSON.parse(JSON.stringify(g)) as AnimGraph;
}

/** 生成不冲突的过渡 id（t1、t2…） */
export function nextTransitionId(g: Pick<AnimGraph, "transitions">): string {
  let i = g.transitions.length + 1;
  let id = `t${i}`;
  const used = new Set(g.transitions.map((t) => t.id));
  while (used.has(id)) id = `t${++i}`;
  return id;
}

/** 生成不冲突的状态名（State2、State3…） */
export function nextStateName(g: Pick<AnimGraph, "states">): string {
  let i = g.states.length + 1;
  let name = `State${i}`;
  const used = new Set(g.states.map((s) => s.name));
  while (used.has(name)) name = `State${++i}`;
  return name;
}

/** 布尔/数值参数按数值比较（布尔 → 0/1） */
export function evalCondition(
  param: AnimGraphParamValue | undefined,
  cond: AnimGraphCondition,
): boolean {
  if (param === undefined) return false;
  const v = typeof param === "boolean" ? (param ? 1 : 0) : param;
  switch (cond.op) {
    case ">":
      return v > cond.value;
    case "<":
      return v < cond.value;
    case ">=":
      return v >= cond.value;
    case "<=":
      return v <= cond.value;
    case "==":
      return v === cond.value;
    case "!=":
      return v !== cond.value;
  }
}

/**
 * 任意来源 → 收敛的动画图（null 表示无图/数据无效）：
 * 状态名去重保序、过渡引用无效状态时剔除、entry 校验回退首状态、参数默认值收敛。
 */
export function parseAnimGraph(v: unknown): AnimGraph | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const rawStates = Array.isArray(o.states) ? o.states : [];
  const states: AnimGraphState[] = [];
  const seen = new Set<string>();
  for (const s of rawStates) {
    if (!s || typeof s !== "object") continue;
    const so = s as Record<string, unknown>;
    const name = str(so.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    states.push({
      name,
      clip: str(so.clip),
      speed: Math.max(0, num(so.speed, 1)),
      loop: LOOP_MODES.includes(so.loop as AnimLoopMode) ? (so.loop as AnimLoopMode) : "loop",
    });
  }
  if (!states.length) return null;

  const rawTransitions = Array.isArray(o.transitions) ? o.transitions : [];
  const transitions: AnimGraphTransition[] = [];
  const seenIds = new Set<string>();
  for (const t of rawTransitions) {
    if (!t || typeof t !== "object") continue;
    const to = t as Record<string, unknown>;
    const id = str(to.id) || nextTransitionId({ transitions });
    const from = str(to.from);
    const target = str(to.to);
    if (!from || !target || !seen.has(from) || !seen.has(target) || from === target) continue;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const rawConds = Array.isArray(to.conditions) ? to.conditions : [];
    transitions.push({
      id,
      from,
      to: target,
      duration: Math.max(0, num(to.duration, 0.25)),
      exitTime: Math.max(0, Math.min(1, num(to.exitTime, 0))),
      conditions: rawConds
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c) => ({
          param: str(c.param),
          op: OPS.includes(c.op as AnimConditionOp) ? (c.op as AnimConditionOp) : "==",
          value: num(c.value, 0),
        }))
        .filter((c) => c.param !== ""),
    });
  }

  const params: Record<string, AnimGraphParamValue> = {};
  if (o.params && typeof o.params === "object") {
    for (const [k, val] of Object.entries(o.params as Record<string, unknown>)) {
      if (typeof val === "number" && Number.isFinite(val)) params[k] = val;
      else if (typeof val === "boolean") params[k] = val;
    }
  }

  const entry = str(o.entry);
  return {
    entry: seen.has(entry) ? entry : states[0].name,
    states,
    transitions,
    params,
  };
}

/** 任意来源 → 单剪辑播放设置（缺失字段回退默认） */
export function parseClipSettings(v: unknown): AnimClipSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    autoplay: bool(o.autoplay, DEFAULT_CLIP_SETTINGS.autoplay),
    clip: str(o.clip, DEFAULT_CLIP_SETTINGS.clip),
    speed: Math.max(0, num(o.speed, DEFAULT_CLIP_SETTINGS.speed)),
    loop: LOOP_MODES.includes(o.loop as AnimLoopMode) ? (o.loop as AnimLoopMode) : "loop",
  };
}

/** 骨骼/IK 目标绑定（MeshNode.boneBindings 的形状；随场景持久化） */
export interface BoneBindingSpec {
  /** 目标节点 id（须在模型子树之外） */
  target: string;
  /** 骨骼名 / IK id / IK 名（IK 目标运行时解析） */
  bone: string;
  /** 保持绑定时刻的相对位姿（false = 对象原点对齐骨骼原点） */
  keepOffset: boolean;
  /** 跟随骨骼旋转（false = 仅锚点位置跟随） */
  syncRotation: boolean;
  /** 跟随骨骼缩放 */
  syncScale: boolean;
}

/** 深拷贝绑定列表（编辑器改绑前的工作副本 / 节点克隆） */
export function cloneBoneBindings(list: BoneBindingSpec[]): BoneBindingSpec[] {
  return list.map((b) => ({ ...b }));
}

/** 任意来源 → 收敛的绑定列表（同目标去重保序、字段收敛；缺失布尔回退默认） */
export function parseBoneBindings(v: unknown): BoneBindingSpec[] {
  if (!Array.isArray(v)) return [];
  const out: BoneBindingSpec[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const target = str(o.target);
    const bone = str(o.bone);
    if (!target || !bone || seen.has(target)) continue;
    seen.add(target);
    out.push({
      target,
      bone,
      keepOffset: bool(o.keepOffset, true),
      syncRotation: bool(o.syncRotation, true),
      syncScale: bool(o.syncScale, false),
    });
  }
  return out;
}
