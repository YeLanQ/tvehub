// ---------------------------------------------------------------------------
// 场景图窗口装载进度 store（图窗口版 boot-loading）：
// Hub「打开场景图」→ 项目交接装载期间，蒙版按阶段展示「扫描资产清单 /
// 打开场景会话 / 解析脚本原型」进度，全部就绪后揭幕进入工作区。
// 生命周期与编辑器 boot-loading 一致：standby（布防，窗口被 Rust show 时蒙版
// 已在）→ loading（begin 后逐阶段汇报）→ ready（finish 揭幕）。
// 视觉复用编辑器 boot-mask.scss，与编辑器窗口打开体验一致。
// ---------------------------------------------------------------------------
import { readonly, reactive } from "vue";
import { bootStagePercent } from "../app/lib/boot-progress";

/** 装载阶段（固定顺序，蒙版按此渲染） */
export const GRAPH_BOOT_STAGES = [
  { id: "assets", label: "扫描资产清单" },
  { id: "scene", label: "打开场景会话" },
  { id: "graph", label: "装载场景图" },
] as const;

export type GraphBootStageId = (typeof GRAPH_BOOT_STAGES)[number]["id"];
export type GraphBootPhase = "idle" | "standby" | "loading" | "ready";
export type GraphBootStageStatus = "pending" | "active" | "done" | "failed";

export interface GraphBootStageState {
  id: GraphBootStageId;
  label: string;
  status: GraphBootStageStatus;
}

/** 蒙版最短停留：装载过快时不闪烁 */
const MIN_DISPLAY_MS = 500;
/** 全部完成后到揭幕的收尾停留：让进度条走满可感知 */
const SETTLE_TAIL_MS = 300;
/** 装载失败信息的额外停留 */
const ERROR_TAIL_MS = 2200;

export interface GraphBootStore {
  state: Readonly<{
    phase: GraphBootPhase;
    projectName: string;
    error: string;
    stages: GraphBootStageState[];
  }>;
  /** 总进度百分比（0..100）：只增不减，begin() 归零 */
  readonly percent: number;
  /** 布防蒙版（idle/ready → standby） */
  standby: () => void;
  /** 进入装载：重置阶段并记录起始时间 */
  begin: (projectName: string) => void;
  /** 激活阶段（pending → active；不覆盖 failed/done） */
  activate: (id: GraphBootStageId) => void;
  /** 阶段完成 */
  complete: (id: GraphBootStageId) => void;
  /** 装载失败：标记当前阶段 + 展示错误，停留后收尾 */
  fail: (message: string) => void;
  /** 全部就绪：未汇报的阶段兜底标记完成，停留最短时长后揭幕 */
  finish: () => void;
  /** 直接揭幕（standby → ready）：项目已就绪无需重新装载时使用 */
  reveal: () => void;
}

let singleton: GraphBootStore | null = null;

export function getGraphBootStore(): GraphBootStore {
  if (singleton) return singleton;

  const state = reactive({
    phase: "idle" as GraphBootPhase,
    projectName: "",
    error: "",
    stages: GRAPH_BOOT_STAGES.map(
      (s): GraphBootStageState => ({ id: s.id, label: s.label, status: "pending" }),
    ),
  });

  let startedAt = 0;
  /** 令牌：失效收尾定时器（begin/fail/finish 竞态） */
  let token = 0;

  /** 已展示过的最大进度：进度条只增不减（同一次装载内）；begin() 开新一轮时
   *  归零。最大值在读取时取——只在渲染时刻采样稳定状态（普通变量而非 ref：
   *  不引入额外响应式依赖，阶段本身的变化已足以驱动重渲染）。 */
  let shownPercent = 0;

  function stageOf(id: GraphBootStageId): GraphBootStageState {
    return state.stages.find((s) => s.id === id) ?? state.stages[0];
  }

  function resetStages(): void {
    for (const s of state.stages) s.status = "pending";
  }

  /** 停留 wait 毫秒后揭幕（token 失配或已离开 loading 则放弃） */
  function settleAfter(wait: number): void {
    const t = token;
    setTimeout(() => {
      if (t === token && state.phase === "loading") state.phase = "ready";
    }, wait);
  }

  const store: GraphBootStore = {
    state: readonly(state) as unknown as GraphBootStore["state"],
    get percent() {
      const p = bootStagePercent(state.stages);
      if (p > shownPercent) shownPercent = p;
      return shownPercent;
    },
    standby() {
      if (state.phase === "loading") return;
      token += 1;
      state.error = "";
      state.phase = "standby";
    },
    begin(projectName) {
      token += 1;
      state.phase = "loading";
      state.projectName = projectName;
      state.error = "";
      resetStages();
      shownPercent = 0;
      startedAt = Date.now();
    },
    activate(id) {
      if (state.phase !== "loading") return;
      const s = stageOf(id);
      if (s.status === "pending") s.status = "active";
    },
    complete(id) {
      if (state.phase !== "loading") return;
      stageOf(id).status = "done";
    },
    fail(message) {
      if (state.phase !== "loading") return;
      const active = state.stages.find((s) => s.status === "active");
      if (active) active.status = "failed";
      state.error = message;
      settleAfter(ERROR_TAIL_MS);
    },
    finish() {
      if (state.phase !== "loading") return;
      for (const s of state.stages) {
        if (s.status === "pending" || s.status === "active") s.status = "done";
      }
      settleAfter(Math.max(SETTLE_TAIL_MS, MIN_DISPLAY_MS - (Date.now() - startedAt)));
    },
    reveal() {
      token += 1;
      state.phase = "ready";
    },
  };

  singleton = store;
  return store;
}
