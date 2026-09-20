// ---------------------------------------------------------------------------
// 白板窗口布局持久化（ui-state KV，全局键，不随项目）：
// 浮动面板位置/收起态/激活页签跨打开恢复。窗口内共享一份 reactive 布局对象：
// 启动时拉取一次，组件直接改它，变更后经 saveWhiteboardLayout 防抖写回。
// ---------------------------------------------------------------------------
import { reactive } from "vue";
import { uiStateGet, uiStateSet } from "../lib/ui-state";
import { DEFAULT_SLIDE_EASING, isEasingOption } from "./easings";

export type WhiteboardSideTab = "layers" | "props";

/** 幻灯片切换方式（左/右平移、上/下平移、渐入渐出、层叠覆盖） */
export type SlideTransition = "pushX" | "pushY" | "fade" | "stack";

/** 幻灯片驱动方式：自动播放 / 手动控制（事件控制为占位，未列入） */
export type SlideMode = "auto" | "manual";

export interface WhiteboardLayout {
  /** 浮动面板位置（画布内 px；null = 默认右上锚定） */
  panelX: number | null;
  panelY: number | null;
  panelCollapsed: boolean;
  sideTab: WhiteboardSideTab;
  /** 线条工具（直线/铅笔/钢笔）的线条粗细 */
  toolWidth: number;
  /** 幻灯片：切换方式 / 驱动方式 / 自动播放间隔（秒）/ 切换曲线 / 工具条收起态 */
  slideTransition: SlideTransition;
  slideMode: SlideMode;
  slideInterval: number;
  slideEasing: string;
  slideCollapsed: boolean;
}

const KEY = "tve:whiteboard:layout";

export const whiteboardLayout = reactive<WhiteboardLayout>({
  panelX: null,
  panelY: null,
  panelCollapsed: false,
  sideTab: "layers",
  toolWidth: 2,
  slideTransition: "pushX",
  slideMode: "manual",
  slideInterval: 3,
  slideEasing: DEFAULT_SLIDE_EASING,
  slideCollapsed: false,
});

const SLIDE_TRANSITIONS: SlideTransition[] = ["pushX", "pushY", "fade", "stack"];

let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 应用持久化布局并按合法取值收敛（历史值/脏值兜底）。抽成纯函数：落盘 IO 之外
 * 的这段逻辑与后端无关，便于单独核对（浏览器预览下 ui-state 是空实现）。
 */
export function applySavedLayout(saved: Partial<WhiteboardLayout>): void {
  Object.assign(whiteboardLayout, saved);
  // 兼容历史值：动画页签已移除
  if (whiteboardLayout.sideTab !== "layers" && whiteboardLayout.sideTab !== "props") {
    whiteboardLayout.sideTab = "layers";
  }
  // 幻灯片的枚举/数值同样收敛，避免脏值直接进定时器与动画参数
  if (!SLIDE_TRANSITIONS.includes(whiteboardLayout.slideTransition)) {
    whiteboardLayout.slideTransition = "pushX";
  }
  if (whiteboardLayout.slideMode !== "auto" && whiteboardLayout.slideMode !== "manual") {
    whiteboardLayout.slideMode = "manual";
  }
  const iv = Number(whiteboardLayout.slideInterval);
  whiteboardLayout.slideInterval = Number.isFinite(iv) ? Math.min(60, Math.max(1, Math.round(iv))) : 3;
  if (!isEasingOption(whiteboardLayout.slideEasing)) whiteboardLayout.slideEasing = DEFAULT_SLIDE_EASING;
  whiteboardLayout.slideCollapsed = whiteboardLayout.slideCollapsed === true;
  whiteboardLayout.toolWidth = Number.isFinite(Number(whiteboardLayout.toolWidth))
    ? Math.min(24, Math.max(1, Number(whiteboardLayout.toolWidth)))
    : 2;
}

/** 拉取持久化布局（窗口启动调用一次；浏览器开发环境保持默认值） */
export async function loadWhiteboardLayout(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const saved = await uiStateGet<Partial<WhiteboardLayout>>(KEY);
    if (saved) applySavedLayout(saved);
  } catch {
    /* ignore */
  }
}

/** 变更落盘（防抖合并连续变更，如拖动面板） */
export function saveWhiteboardLayout(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void uiStateSet(KEY, { ...whiteboardLayout }).catch(() => {});
  }, 400);
}
