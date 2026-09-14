// ---------------------------------------------------------------------------
// 有限状态机（FSM）数据类型（framework 层，不依赖 app/api 与 three）。
//
// 状态机资产（.fsm）持有可 JSON 序列化的状态图：状态（带编辑器画布坐标）+
// 过渡（事件 / 定时 / 参数条件三类触发，全部满足才触发）+ 参数表（黑板默认值）。
// 读取经 parseFsmGraph 统一收敛（缺失/非法/越界回退或剔除），编辑器与运行时共用。
//
// 过渡触发语义：一条过渡声明的全部触发器都满足时触发——
// - event 非空：进入源状态后收到过该事件（fire）；
// - duration > 0：在源状态停留时长达到该秒数；
// - conditions：全部参数条件成立（持续求值）。
// 三者都未声明 = 进入源状态后立即触发（用于链式入口）。
// ---------------------------------------------------------------------------

/** 条件比较运算（布尔参数按 0/1 参与数值比较） */
export type FsmConditionOp = ">" | "<" | ">=" | "<=" | "==" | "!=";

/** 单条参数条件：param op value 全部满足才允许过渡 */
export interface FsmCondition {
  /** 参数名（黑板键；运行时未定义的条件按不成立处理） */
  param: string;
  op: FsmConditionOp;
  value: number;
}

/** 状态机状态（编辑器画布上的一个节点） */
export interface FsmState {
  /** 状态 id（图内唯一；过渡的 from/to 引用键；s1、s2…） */
  id: string;
  /** 显示名（图内唯一） */
  name: string;
  /** 编辑器画布坐标（画布逻辑坐标，随缩放/平移换算） */
  x: number;
  y: number;
  /** 状态卡片主题色（CSS hex；空 = 默认色） */
  color: string;
}

/** 状态过渡：from → to，携带三类可选触发器 */
export interface FsmTransition {
  /** 过渡 id（图内唯一；编辑器增删用；t1、t2…） */
  id: string;
  /** 源状态 id */
  from: string;
  /** 目标状态 id（≠ from） */
  to: string;
  /** 触发事件名（空 = 不依赖事件） */
  event: string;
  /** 自动过渡秒数（0 = 不按时间触发） */
  duration: number;
  /** 参数条件（全部满足） */
  conditions: FsmCondition[];
}

/** 图参数：数值或布尔；运行时可写，默认值随图持久化 */
export type FsmParamValue = number | boolean;

/** 状态机完整定义（.fsm 资产 graph 字段的形状） */
export interface FsmGraph {
  /** 入口状态 id */
  entry: string;
  states: FsmState[];
  transitions: FsmTransition[];
  /** 参数表（key → 默认值；条件与运行时写值共用） */
  params: Record<string, FsmParamValue>;
}

const OPS: FsmConditionOp[] = [">", "<", ">=", "<=", "==", "!="];

/** 状态卡片可选主题色（编辑器色板；顺序即展示顺序） */
export const FSM_STATE_COLORS = [
  "#4ec9b0",
  "#569cd6",
  "#c586c0",
  "#dcdcaa",
  "#ce9178",
  "#9cdcfe",
] as const;

/** 默认状态卡片色（color 为空时） */
export const FSM_DEFAULT_STATE_COLOR = "#569cd6";

function str(v: unknown, fb = ""): string {
  return typeof v === "string" ? v : fb;
}
function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

/** 深拷贝状态机图（编辑器改图前的工作副本） */
export function cloneFsmGraph(g: FsmGraph): FsmGraph {
  return JSON.parse(JSON.stringify(g)) as FsmGraph;
}

/** 生成不冲突的状态 id（s1、s2…） */
export function nextFsmStateId(g: Pick<FsmGraph, "states">): string {
  let i = g.states.length + 1;
  let id = `s${i}`;
  const used = new Set(g.states.map((s) => s.id));
  while (used.has(id)) id = `s${++i}`;
  return id;
}

/** 生成不冲突的过渡 id（t1、t2…） */
export function nextFsmTransitionId(g: Pick<FsmGraph, "transitions">): string {
  let i = g.transitions.length + 1;
  let id = `t${i}`;
  const used = new Set(g.transitions.map((t) => t.id));
  while (used.has(id)) id = `t${++i}`;
  return id;
}

/** 生成不冲突的状态显示名（State2、State3…） */
export function nextFsmStateName(g: Pick<FsmGraph, "states">): string {
  let i = g.states.length + 1;
  let name = `State${i}`;
  const used = new Set(g.states.map((s) => s.name));
  while (used.has(name)) name = `State${++i}`;
  return name;
}

/** 按 id 查状态（不存在返回 null） */
export function fsmStateById(g: Pick<FsmGraph, "states">, id: string): FsmState | null {
  return g.states.find((s) => s.id === id) ?? null;
}

/** 布尔/数值参数按数值比较（布尔 → 0/1；参数未定义按不成立） */
export function evalFsmCondition(param: FsmParamValue | undefined, cond: FsmCondition): boolean {
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
 * 任意来源 → 收敛的状态机图（始终返回可用图）：
 * 状态 id/名去重保序、坐标钳进画布范围、颜色收敛；过渡引用无效状态或自环时剔除、
 * id 去重补齐；entry 校验回退首状态；参数默认值收敛（仅数值/布尔）。
 */
export function parseFsmGraph(v: unknown): FsmGraph {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const rawStates = Array.isArray(o.states) ? o.states : [];
  const states: FsmState[] = [];
  const byId = new Set<string>();
  const byName = new Set<string>();
  for (const s of rawStates) {
    if (!s || typeof s !== "object") continue;
    const so = s as Record<string, unknown>;
    const id = str(so.id) || nextFsmStateId({ states });
    let name = str(so.name) || `State${states.length + 1}`;
    if (byId.has(id)) continue;
    if (byName.has(name)) name = nextFsmStateName({ states });
    byId.add(id);
    byName.add(name);
    const color = str(so.color);
    states.push({
      id,
      name,
      x: Math.max(-20000, Math.min(20000, num(so.x, 0))),
      y: Math.max(-20000, Math.min(20000, num(so.y, 0))),
      color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : FSM_DEFAULT_STATE_COLOR,
    });
  }
  if (!states.length) return parseFsmGraph(DEFAULT_FSM_GRAPH);

  const transitions: FsmTransition[] = [];
  const seenIds = new Set<string>();
  const rawTransitions = Array.isArray(o.transitions) ? o.transitions : [];
  for (const t of rawTransitions) {
    if (!t || typeof t !== "object") continue;
    const to = t as Record<string, unknown>;
    const id = str(to.id) || nextFsmTransitionId({ transitions });
    const from = str(to.from);
    const target = str(to.to);
    if (!from || !target || !byId.has(from) || !byId.has(target) || from === target) continue;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const rawConds = Array.isArray(to.conditions) ? to.conditions : [];
    transitions.push({
      id,
      from,
      to: target,
      event: str(to.event),
      duration: Math.max(0, num(to.duration, 0)),
      conditions: rawConds
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c) => ({
          param: str(c.param),
          op: OPS.includes(c.op as FsmConditionOp) ? (c.op as FsmConditionOp) : "==",
          value: num(c.value, 0),
        }))
        .filter((c) => c.param !== ""),
    });
  }

  const params: Record<string, FsmParamValue> = {};
  if (o.params && typeof o.params === "object") {
    for (const [k, val] of Object.entries(o.params as Record<string, unknown>)) {
      if (typeof val === "number" && Number.isFinite(val)) params[k] = val;
      else if (typeof val === "boolean") params[k] = val;
    }
  }

  const entry = str(o.entry);
  return {
    entry: byId.has(entry) ? entry : states[0].id,
    states,
    transitions,
    params,
  };
}

/** 新建状态机资产的默认图（单个入口状态，坐标在画布可视区左上） */
export const DEFAULT_FSM_GRAPH: FsmGraph = {
  entry: "s1",
  states: [{ id: "s1", name: "Idle", x: 120, y: 140, color: FSM_DEFAULT_STATE_COLOR }],
  transitions: [],
  params: {},
};

/** 状态机资产扩展名 */
export const FSM_EXT = ".fsm";

/** 是否状态机资产相对路径（按扩展名判断） */
export function isFsmAssetRel(rel: string): boolean {
  return rel.toLowerCase().endsWith(FSM_EXT);
}
