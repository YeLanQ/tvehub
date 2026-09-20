// ---------------------------------------------------------------------------
// 幻灯片播放（运行时状态，不写文档、不进撤销历史）：
// - 一页 = 一个可见图层（图层可见性即放映范围，与图层「眼睛」开关一致）；
// - 播放时画布只渲染当前页 + 过渡中的上一页，切换动画由画布给图层 <g> 挂 class 完成
//   （keyframes 在 whiteboard.scss，位移量经 --sv-dx/--sv-dy 由画板尺寸下发）；
// - 自动播放 = 定时器按间隔前进并循环；手动 = 上一页/下一页（按钮或 ←/→）；
//   事件控制（占位）见 slide-mode：模式选项已列出，等接入逻辑图/外部事件再启用；
// - 偏好（模式/切换方式/间隔）存 whiteboardLayout，跨打开恢复；页码与在途动画只存内存。
// ---------------------------------------------------------------------------
import { computed, reactive, watch } from "vue";
import { whiteboardLayout, type SlideMode, type SlideTransition } from "./layout";
import { getWhiteboardStore } from "./whiteboardStore";
import type { SvgLayer } from "./svg-doc";

/** 类型定义归 layout（偏好所在）；此处转出，调用方从任一模块取都一致 */
export type { SlideMode, SlideTransition };

/** 切换动画时长（ms）：画布经 --sv-slide-dur 取同一值，保证收尾清态与动画结束对齐 */
export const SLIDE_DURATION_MS = 520;

/** 在途过渡：fromId 为上一页图层（过渡期间叠在下面渲染） */
export interface SlideAnim {
  fromId: string;
  kind: SlideTransition;
  /** 1 = 前进（新页自右/下进入），-1 = 后退 */
  dir: 1 | -1;
}

interface SlideShowState {
  /** 放映中：画布仅渲染当前页 */
  active: boolean;
  /** 当前页序号（对可见图层数组） */
  index: number;
  anim: SlideAnim | null;
}

const store = getWhiteboardStore();

const state = reactive<SlideShowState>({ active: false, index: 0, anim: null });

/** 放映页序列（可见图层，数组顺序 = 绘制序） */
export function slideDeck(): SvgLayer[] {
  return store.state.doc.layers.filter((l) => l.visible);
}

export function slideShow(): SlideShowState {
  return state;
}

export function slideCount(): number {
  return slideDeck().length;
}

/** 当前页图层（非放映态为 null） */
export function slideCurrent(): SvgLayer | null {
  return slideDeck()[state.index] ?? null;
}

let finalizeTimer: ReturnType<typeof setTimeout> | null = null;
let autoTimer: ReturnType<typeof setInterval> | null = null;

function clearFinalize(): void {
  if (finalizeTimer) {
    clearTimeout(finalizeTimer);
    finalizeTimer = null;
  }
}

/** 自动播放定时器跟随「放映中 + 自动模式 + 间隔」同步 */
function syncAuto(): void {
  const want = state.active && whiteboardLayout.slideMode === "auto" && slideCount() > 1;
  if (want && !autoTimer) {
    const ms = Math.max(1, Math.round(whiteboardLayout.slideInterval)) * 1000;
    autoTimer = setInterval(() => slideGo(1), ms);
  } else if (!want && autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
}

/** 翻页：循环；在途过渡被打断时以当前页作为新的上一页（不丢点击） */
export function slideGo(dir: 1 | -1): void {
  const pages = slideDeck();
  if (pages.length < 2) return;
  const next = (state.index + dir + pages.length) % pages.length;
  transitionTo(next, dir);
}

/** 跳到指定页（页码列表/图层面板选层用；方向按前后关系推） */
export function slideGoToPage(index: number): void {
  const pages = slideDeck();
  if (index < 0 || index >= pages.length || index === state.index) return;
  transitionTo(index, index > state.index ? 1 : -1);
}

function transitionTo(next: number, dir: 1 | -1): void {
  const pages = slideDeck();
  const fromId = pages[state.index]?.id ?? "";
  state.index = next;
  state.anim = { fromId, kind: whiteboardLayout.slideTransition, dir };
  // 当前页同步为活动图层：图层面板跟着高亮放映到的那一页（也便于选层跳页）
  const cur = pages[next];
  if (cur) store.selectLayer(cur.id);
  clearFinalize();
  finalizeTimer = setTimeout(() => {
    finalizeTimer = null;
    state.anim = null;
  }, SLIDE_DURATION_MS);
}

/** 开始放映：从「当前活动图层」那一页起播（不在放映序列里则沿用上次页码） */
export function slideStart(): void {
  const pages = slideDeck();
  if (!pages.length) {
    store.showNotice("没有可见图层，无法放映", "warn");
    return;
  }
  const activeIdx = pages.findIndex((p) => p.id === store.state.activeLayerId);
  state.active = true;
  state.index = activeIdx >= 0 ? activeIdx : Math.min(state.index, pages.length - 1);
  state.anim = null;
  clearFinalize();
  store.selectEl(null); // 收起选中框，避免控件叠在放映画面上
  syncAuto();
}

export function slideStop(): void {
  if (!state.active) return;
  state.active = false;
  state.anim = null;
  clearFinalize();
  syncAuto();
}

export function slideToggle(): void {
  if (state.active) slideStop();
  else slideStart();
}

/** 图层增删/可见性变化：页码收敛；无可放映内容时自动退出 */
watch(computed(() => slideDeck().length), (n) => {
  if (!state.active) return;
  if (n === 0) {
    slideStop();
    return;
  }
  if (state.index > n - 1) state.index = n - 1;
});

/** 放映中在图层列表里选层 = 跳到那一页（选好起始页再点放映也走同一条：起播取活动图层） */
watch(
  () => store.state.activeLayerId,
  (id) => {
    if (!state.active || !id) return;
    const idx = slideDeck().findIndex((p) => p.id === id);
    if (idx >= 0) slideGoToPage(idx);
  },
);

// 模式/间隔/放映态变化 → 同步自动播放定时器
watch(() => [state.active, whiteboardLayout.slideMode, whiteboardLayout.slideInterval], syncAuto);
