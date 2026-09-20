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
import { bootStagePercent } from "../lib/boot-progress";

export type BootPhase = "idle" | "standby" | "loading" | "ready";
export type BootStageStatus = "pending" | "active" | "done" | "failed";

/** 装载阶段（固定顺序，蒙版按此渲染）：
 *  引擎/配置/场景文档 → 场景引用的全部产物（材质含着色器 / 模型 / 贴图 /
 *  音频 / 项目脚本编译）全部就绪 → 最后构建场景图揭幕 */
export const BOOT_STAGES = [
  { id: "engine", label: "初始化渲染引擎" },
  { id: "project", label: "读取项目配置" },
  { id: "scene", label: "解析场景文档" },
  { id: "materials", label: "加载材质资产" },
  { id: "models", label: "加载模型资产" },
  { id: "textures", label: "加载贴图资产" },
  { id: "audio", label: "加载音频资产" },
  { id: "scripts", label: "编译项目脚本" },
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
  /** 总进度百分比（0..100）：只增不减，begin() 归零 */
  readonly percent: number;
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
  /** 蒙版开始可见（布防）时刻：最短停留从可见起点起算，而非 begin()，
   *  避免装载极快时蒙版一闪而过、揭幕与窗口早期帧挤在一起产生闪屏 */
  let armedAt = 0;
  /** 令牌：失效 begin/fail/finish 竞态下残留的收尾定时器 */
  let token = 0;

  /** 已展示过的最大进度：进度条只增不减（同一次装载内），任何重复/乱序汇报
   *  都不会让它往回走；begin() 开新一轮时归零。最大值在读取时取——只在渲染
   *  时刻采样稳定状态，方法内部多步赋值产生的中间态不会把进度抬高（用普通
   *  变量而非 ref：不引入额外响应式依赖，阶段本身的变化已足以驱动重渲染）。 */
  let shownPercent = 0;

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
    get percent() {
      const p = bootStagePercent(state.stages);
      if (p > shownPercent) shownPercent = p;
      return shownPercent;
    },
    standby() {
      if (state.phase === "loading") return;
      token += 1;
      state.error = "";
      // 已处于 standby 的重入不重置可见起点（保持最早时刻）；
      // 从 idle/ready 重新布防（新窗口 / 关闭项目回首页）才重新起算
      if (state.phase !== "standby") armedAt = Date.now();
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
    progress(id, done, total) {
      if (state.phase !== "loading") return;
      const s = stageOf(id);
      // 已收尾的阶段不再被后续汇报拉回进行中：同一场景可能被两条装载路径
      // 先后装载（挂载期自身装载 + 交接补装载），重复汇报若把 done 改回
      // active，该阶段折算值会从 1 掉到 n/N×0.95，进度条随即回滚。
      if (s.status === "done" || s.status === "failed") return;
      // 先记计量再置 active：避免出现「active 但 total 仍为 0」的中间态
      // （该中间态在折算口径里等于无计量进度，取值偏高）
      s.done = done;
      s.total = total;
      s.status = "active";
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
      // 最短停留从蒙版可见起点（布防）起算：装载过快时也保证蒙版
      // 至少完整显示 MIN_DISPLAY_MS，揭幕不与窗口首帧挤在一起
      const visibleFrom = armedAt ? Math.min(armedAt, startedAt) : startedAt;
      settleAfter(Math.max(SETTLE_TAIL_MS, MIN_DISPLAY_MS - (Date.now() - visibleFrom)));
    },
  };

  singleton = store;
  return store;
}
