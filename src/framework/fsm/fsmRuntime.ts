// ---------------------------------------------------------------------------
// 状态机求值引擎（framework 层，纯 TS 无渲染依赖）：编辑器与播放端共用。
//
// FsmRunner 持有图引用与运行态（当前状态/停留时长/待处理事件/参数黑板），
// update(dt) 内按图定义逐条检查当前状态的出边（三类触发器全部满足才触发），
// 一帧内允许链式即时过渡（上限 16 跳防环）。进入/退出/切换经回调上抛，
// 由嵌入方（编辑器预览 / 脚本 / 播放端）决定表现行为。
// ---------------------------------------------------------------------------

import {
  evalFsmCondition,
  fsmStateById,
  type FsmGraph,
  type FsmParamValue,
  type FsmState,
  type FsmTransition,
} from "./fsmTypes";

/** 生命周期回调（全部可选） */
export interface FsmRunnerHandlers {
  /** 进入状态（含 start 与每次切换的目标状态） */
  onEnter?: (state: FsmState, runner: FsmRunner) => void;
  /** 退出状态（切换发生时先于 onEnter） */
  onExit?: (state: FsmState, runner: FsmRunner) => void;
  /** 过渡发生（from → to，经由哪条过渡） */
  onTransition?: (from: FsmState, to: FsmState, via: FsmTransition, runner: FsmRunner) => void;
}

/** 一帧内链式即时过渡的最大跳数（防无间隔互切死循环） */
const MAX_CHAIN_HOPS = 16;

export class FsmRunner {
  readonly graph: FsmGraph;
  private handlers: FsmRunnerHandlers;

  /** 运行参数黑板（初始为图默认值的浅拷贝；可写） */
  params: Record<string, FsmParamValue>;

  /** 当前状态 id（未 start 为空串） */
  private currentId = "";
  /** 当前状态停留秒数 */
  stateTime = 0;
  /** 是否已 start */
  started = false;
  /** 进入当前状态以来收到的事件集合（每次进入状态清空） */
  private firedEvents = new Set<string>();

  constructor(graph: FsmGraph, handlers: FsmRunnerHandlers = {}) {
    this.graph = graph;
    this.handlers = handlers;
    this.params = { ...graph.params };
  }

  /** 当前状态（未启动/图被清空时为 null） */
  get state(): FsmState | null {
    return this.currentId ? fsmStateById(this.graph, this.currentId) : null;
  }

  /** 当前状态名（无状态时空串） */
  get stateName(): string {
    return this.state?.name ?? "";
  }

  /** 进入入口状态并上抛 onEnter（已启动时先重置） */
  start(): void {
    this.started = true;
    const entry = fsmStateById(this.graph, this.graph.entry);
    if (!entry) return;
    this.enter(entry);
  }

  /** 重置到未启动状态（清运行态与事件，不动黑板） */
  reset(): void {
    this.currentId = "";
    this.stateTime = 0;
    this.started = false;
    this.firedEvents.clear();
  }

  /** 发射事件（进入状态以来的首次发射有效；同帧多次发射去重） */
  fire(event: string): void {
    if (event) this.firedEvents.add(event);
  }

  setParam(name: string, value: FsmParamValue): void {
    this.params[name] = value;
  }

  getParam(name: string): FsmParamValue | undefined {
    return this.params[name];
  }

  /**
   * 推进状态机：累计停留时长，检查当前状态出边（出边按定义顺序，首个满足者触发）；
   * 触发后从新状态继续检查（允许同帧链式即时过渡，上限 MAX_CHAIN_HOPS）。
   * 返回本帧是否发生过过渡。
   */
  update(dt: number): boolean {
    if (!this.started) return false;
    let jumped = false;
    let hops = 0;
    while (hops++ < MAX_CHAIN_HOPS) {
      const cur = this.state;
      if (!cur) break;
      this.stateTime += dt;
      const t = this.pickTransition(cur);
      if (!t) break;
      const to = fsmStateById(this.graph, t.to);
      if (!to) break;
      this.handlers.onExit?.(cur, this);
      this.enter(to);
      this.handlers.onTransition?.(cur, to, t, this);
      jumped = true;
      dt = 0;
    }
    return jumped;
  }

  /** 强制切换到指定状态（不经触发器；未知 id 忽略；同状态重进） */
  forceState(id: string): void {
    const target = fsmStateById(this.graph, id);
    if (!target) return;
    const cur = this.state;
    if (cur) this.handlers.onExit?.(cur, this);
    this.enter(target);
  }

  /** 私有：进入状态（清时长、清事件、上抛 onEnter） */
  private enter(state: FsmState): void {
    this.currentId = state.id;
    this.stateTime = 0;
    this.firedEvents.clear();
    this.handlers.onEnter?.(state, this);
  }

  /** 私有：按图定义顺序挑选当前状态第一条满足的出边（无则 null） */
  private pickTransition(cur: FsmState): FsmTransition | null {
    for (const t of this.graph.transitions) {
      if (t.from !== cur.id) continue;
      if (t.event && !this.firedEvents.has(t.event)) continue;
      if (t.duration > 0 && this.stateTime < t.duration) continue;
      if (!t.conditions.every((c) => evalFsmCondition(this.params[c.param], c))) continue;
      return t;
    }
    return null;
  }
}
