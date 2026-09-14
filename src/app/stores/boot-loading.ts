// 项目装载进度 store（编辑器窗口顶层蒙版的数据源）：
// 从 Manager（首页窗口）打开项目卡片 → 编辑器窗口交接装载期间，蒙版按阶段
// 展示「初始化引擎 / 项目配置 / 场景读取 / 材质 / 模型 / 场景构建」的进度，
// 全部就绪后才揭开幕版露出真正的编辑器界面。
//
// 生命周期：
// - standby：布防态（蒙版可见，等待项目交接）。Tauri 下编辑器窗口启动即布防、
//   关闭项目回首页后重新布防——窗口被 Rust show 时蒙版已在，杜绝旧编辑器闪现；
// - loading：begin() 进入装载，各阶段由 editorService 装载管线逐段汇报；
//   非装载期间（如编辑器内双击切换场景）的汇报被忽略，不弹蒙版；
// - ready：finish() 在最短展示时长后收尾，蒙版淡出。
import { readonly, reactive } from "vue";

export type BootPhase = "idle" | "standby" | "loading" | "ready";
export type BootStageStatus = "pending" | "active" | "done" | "failed";

/** 装载阶段（固定顺序，蒙版按此渲染） */
export const BOOT_STAGES = [
  { id: "engine", label: "初始化渲染引擎" },
  { id: "project", label: "读取项目配置" },
  { id: "scene", label: "解析场景文档" },
  { id: "materials", label: "加载材质资产" },
  { id: "models", label: "加载模型资产" },
  { id: "graph", label: "构建场景图" },
] as const;

export type BootStageId = (typeof BOOT_STAGES)[number]["id"];

export interface BootStageState {
  id: BootStageId;
  label: string;
  status: BootStageStatus;
  /** 逐项进度：已完成条目数（材质/模型按资产逐项汇报） */
  done: number;
  /** 逐项进度：总条目数（0 = 该阶段无逐项计量） */
  total: number;
}

/** 蒙版最短停留：装载过快时不闪烁 */
const MIN_DISPLAY_MS = 500;
/** 全部完成后到揭幕的收尾停留：让进度条走满可感知 */
const SETTLE_TAIL_MS = 300;
/** 装载失败信息的额外停留 */
const ERROR_TAIL_MS = 2200;

export interface BootLoadingStore {
  state: Readonly<{
    phase: BootPhase;
    projectName: string;
    error: string;
    stages: BootStageState[];
  }>;
  /** 布防蒙版（idle/ready → standby；loading 期间不降级） */
  standby: () => void;
  /** 进入装载：重置阶段并记录起始时间 */
  begin: (projectName: string) => void;
  /** 激活阶段（pending → active；不覆盖 failed/done） */
  activate: (id: BootStageId) => void;
  /** 汇报逐项进度（total>0 时蒙版显示 n/N） */
  progress: (id: BootStageId, done: number, total: number) => void;
  /** 阶段完成 */
  complete: (id: BootStageId) => void;
  /** 装载失败：标记当前阶段 + 展示错误，停留后收尾 */
  fail: (message: string) => void;
  /** 全部就绪：未汇报的阶段兜底标记完成，停留最短时长后揭幕 */
  finish: () => void;
}

let singleton: BootLoadingStore | null = null;

export function getBootLoadingStore(): BootLoadingStore {
  if (singleton) return singleton;

  const state = reactive({
    phase: "idle" as BootPhase,
    projectName: "",
    error: "",
    stages: BOOT_STAGES.map(
      (s): BootStageState => ({ id: s.id, label: s.label, status: "pending", done: 0, total: 0 }),
    ),
  });

  let startedAt = 0;
  /** 令牌：失效 begin/fail/finish 竞态下残留的收尾定时器 */
  let token = 0;

  function stageOf(id: BootStageId): BootStageState {
    return state.stages.find((s) => s.id === id) ?? state.stages[0];
  }

  function resetStages(): void {
    for (const s of state.stages) {
      s.status = "pending";
      s.done = 0;
      s.total = 0;
    }
  }

  /** 停留 wait 毫秒后揭幕（token 失配或已离开 loading 则放弃） */
  function settleAfter(wait: number): void {
    const t = token;
    setTimeout(() => {
      if (t === token && state.phase === "loading") state.phase = "ready";
    }, wait);
  }

  const store: BootLoadingStore = {
    state: readonly(state) as unknown as BootLoadingStore["state"],
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
      startedAt = Date.now();
    },
    activate(id) {
      if (state.phase !== "loading") return;
      const s = stageOf(id);
      if (s.status === "pending") s.status = "active";
    },
    progress(id, done, total) {
      if (state.phase !== "loading") return;
      const s = stageOf(id);
      s.status = "active";
      s.done = done;
      s.total = total;
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
      // 未逐段汇报到的阶段兜底标记完成（如引擎先于项目就绪的路径）
      for (const s of state.stages) {
        if (s.status === "pending" || s.status === "active") s.status = "done";
      }
      settleAfter(Math.max(SETTLE_TAIL_MS, MIN_DISPLAY_MS - (Date.now() - startedAt)));
    },
  };

  singleton = store;
  return store;
}
