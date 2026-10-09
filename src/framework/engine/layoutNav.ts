// ---------------------------------------------------------------------------
// 布局视口 2D 设计视图导航（滚轮缩放 / 右中键平移 / 右键菜单抑制）。
// mount 时经 installLayoutNavigation 装配到引擎，dispose 时 removeLayoutNavigation
// 拆除；平移状态（layoutPanning/layoutPanLast）为本控制器私有，不进引擎。
// ---------------------------------------------------------------------------
import type { EditorEngine } from "./EditorEngine";
import { activeCameraAspect, ndcFromEvent } from "./viewportQuery";

/** 平移状态（安装后非空；挂在引擎字段 layoutNav 上随引擎存续） */
export interface LayoutNavState {
  panning: boolean;
  last: { x: number; y: number };
  onWheel: (e: WheelEvent) => void;
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: () => void;
  onContextMenu: (e: MouseEvent) => void;
}

/** 安装布局视口 2D 导航（幂等：重复安装先拆旧） */
export function installLayoutNavigation(engine: EditorEngine): void {
  removeLayoutNavigation(engine);
  const st: LayoutNavState = {
    panning: false,
    last: { x: 0, y: 0 },
    onWheel: (e: WheelEvent): void => {
      if (!engine.uiSystem.isVisible() || engine.gizmo?.isDragging()) return;
      // 布局视图接管滚轮（页面/轨道均不滚动）；场景视图放行给轨道相机推拉
      e.preventDefault();
      e.stopPropagation();
      const ndc = ndcFromEvent(engine, e);
      if (!ndc) return;
      const factor = Math.exp(-e.deltaY * 0.0015);
      engine.uiSystem.zoomAt(factor, ndc.x, ndc.y, activeCameraAspect(engine));
    },
    onPointerDown: (e: PointerEvent): void => {
      if (!engine.uiSystem.isVisible() || engine.gizmo?.isDragging()) return;
      // 右键/中键拖拽平移；左键留给选择与 Gizmo
      if (e.button !== 1 && e.button !== 2) return;
      e.preventDefault();
      st.panning = true;
      st.last = { x: e.clientX, y: e.clientY };
    },
    onPointerMove: (e: PointerEvent): void => {
      if (!st.panning) return;
      const rect = engine.renderer.domElement.getBoundingClientRect();
      engine.uiSystem.panByPixels(
        e.clientX - st.last.x,
        e.clientY - st.last.y,
        rect.width,
        rect.height,
        activeCameraAspect(engine),
      );
      st.last = { x: e.clientX, y: e.clientY };
    },
    onPointerUp: (): void => {
      st.panning = false;
    },
    onContextMenu: (e: MouseEvent): void => {
      if (engine.uiSystem.isVisible()) e.preventDefault();
    },
  };
  const dom = engine.renderer.domElement;
  dom.addEventListener("wheel", st.onWheel, { passive: false });
  dom.addEventListener("pointerdown", st.onPointerDown);
  window.addEventListener("pointermove", st.onPointerMove);
  window.addEventListener("pointerup", st.onPointerUp);
  dom.addEventListener("contextmenu", st.onContextMenu);
  engine.layoutNav = st;
}

/** 拆除布局视口 2D 导航（未安装时空操作） */
export function removeLayoutNavigation(engine: EditorEngine): void {
  const st = engine.layoutNav;
  if (!st) return;
  const dom = engine.renderer.domElement;
  dom.removeEventListener("wheel", st.onWheel);
  dom.removeEventListener("pointerdown", st.onPointerDown);
  window.removeEventListener("pointermove", st.onPointerMove);
  window.removeEventListener("pointerup", st.onPointerUp);
  dom.removeEventListener("contextmenu", st.onContextMenu);
  engine.layoutNav = null;
}
