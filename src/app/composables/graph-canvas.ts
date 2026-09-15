// ---------------------------------------------------------------------------
// 图编辑画布共享逻辑（SVG 平移/缩放）：状态机编辑器与行为树编辑器共用。
// - view：画布视图变换（平移 px + 缩放系数），经顶层 <g :transform> 应用；
// - toGraph：屏幕坐标 → 画布逻辑坐标（几何/命中计算共用）；
// - wheel 缩放以指针为锚点（放大后指针下的图点保持不动），手动注册非被动监听。
// 平移由组件自行驱动：拖拽中按按下起点直接绝对定位 view（不可用增量累加，会漂移）。
// ---------------------------------------------------------------------------
import { computed, reactive, type Ref } from "vue";

/** 缩放范围 */
const K_MIN = 0.25;
const K_MAX = 2.5;

export interface GraphView {
  x: number;
  y: number;
  k: number;
}

/** 画布逻辑坐标下的内容包围盒 */
export interface GraphBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function useGraphCanvas(svgEl: Ref<SVGSVGElement | null>) {
  const view = reactive<GraphView>({ x: 0, y: 0, k: 1 });

  const transform = computed(() => `translate(${view.x},${view.y}) scale(${view.k})`);

  /** 屏幕坐标 → 画布逻辑坐标 */
  function toGraph(clientX: number, clientY: number): { x: number; y: number } {
    const rect = svgEl.value?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - view.x) / view.k,
      y: (clientY - rect.top - view.y) / view.k,
    };
  }

  /** 以 (cx, cy)（相对视口元素左上）为锚点缩放 factor 倍 */
  function zoomAt(factor: number, cx: number, cy: number): void {
    const k = Math.min(K_MAX, Math.max(K_MIN, view.k * factor));
    const real = k / view.k;
    view.x = cx - (cx - view.x) * real;
    view.y = cy - (cy - view.y) * real;
    view.k = k;
  }

  /** 重置视图（回到 1:1、原点） */
  function resetView(): void {
    view.x = 0;
    view.y = 0;
    view.k = 1;
  }

  /** 调整视图使内容包围盒完整居中可见（空/无效边界回 1:1 原点） */
  function fitTo(b: GraphBounds | null, viewportW: number, viewportH: number, pad = 48): void {
    if (!b || b.maxX < b.minX || b.maxY < b.minY || viewportW <= 0 || viewportH <= 0) {
      resetView();
      return;
    }
    const w = Math.max(1, b.maxX - b.minX);
    const h = Math.max(1, b.maxY - b.minY);
    const k = Math.min(K_MAX, Math.max(K_MIN, Math.min((viewportW - pad * 2) / w, (viewportH - pad * 2) / h)));
    view.k = k;
    view.x = (viewportW - w * k) / 2 - b.minX * k;
    view.y = (viewportH - h * k) / 2 - b.minY * k;
  }

  /** 挂到 svg 元素的滚轮缩放（非被动，需 preventDefault） */
  function bindWheel(): () => void {
    const el = svgEl.value;
    if (!el) return () => {};
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0014), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }

  return { view, transform, toGraph, zoomAt, resetView, fitTo, bindWheel };
}
