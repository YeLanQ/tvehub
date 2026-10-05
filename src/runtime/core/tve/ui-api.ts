// ---------------------------------------------------------------------------
// UI 运行期控制（按实体寻址；画布/Widget 设置 + 按钮点击订阅，经 engine.ui 调用）
// UI 布局/坐标查询（rectOf/metricsOf/screenToUi）——数据来自 ui.mjs 逐帧解析并缓存在
// 节点 userData.uiRect 的渲染矩形与画布根矩形（rootRect = 屏幕尺寸的 UI 单位数）。
// 空间约定：画布局部空间，原点 = 画布中心，y 向上，单位 = UI 单位。
// ---------------------------------------------------------------------------
import { state, numOr } from "./state";
import type { Entity } from "./entity";
import type { UiRect, UiSettings } from "./state";
import {
  UICanvasNode,
  UIImageNode,
  UITextNode,
  UIButtonNode,
  UILayoutNode,
} from "./node-types";

/** 画布屏幕度量（渲染画布 CSS 尺寸 ↔ rootRect；SDK UIScreenMetrics 消费面） */
interface UIScreenMetrics {
  width: number;
  height: number;
  rootWidth: number;
  rootHeight: number;
  pxPerUnitX: number;
  pxPerUnitY: number;
  scaleMode: string;
  designWidth: number;
  designHeight: number;
}

const UI_WIDGET_CLASSES = [UICanvasNode, UIImageNode, UITextNode, UIButtonNode, UILayoutNode];

/** 实体所在 UI 画布（沿父链向上；不在画布子树内返回 null） */
function uiCanvasEntityOf(entity: Entity | null | undefined): Entity | null {
  let cur = entity ?? null;
  while (cur) {
    if (cur instanceof UICanvasNode) return cur;
    cur = cur.parent;
  }
  return null;
}

/** 画布屏幕度量（渲染画布 CSS 尺寸 ↔ rootRect；布局未就绪返回 null） */
function uiMetricsOfCanvas(canvasEntity: Entity): UIScreenMetrics | null {
  // 断言安全：userData.uiRect 为 ui.mjs 逐帧写入的画布根矩形（{cx,cy,w,h}）
  const rootRect = canvasEntity?.__obj?.userData?.uiRect as UiRect | undefined;
  if (!rootRect || !(rootRect.w > 0) || !(rootRect.h > 0)) return null;
  const cvs = typeof document !== "undefined" ? document.querySelector?.("canvas") : null;
  const width =
    cvs && cvs.clientWidth > 0
      ? cvs.clientWidth
      : typeof window !== "undefined"
        ? window.innerWidth || 0
        : 0;
  const height =
    cvs && cvs.clientHeight > 0
      ? cvs.clientHeight
      : typeof window !== "undefined"
        ? window.innerHeight || 0
        : 0;
  const settings = state.host?.ui?.settingsOf(canvasEntity.id) ?? null;
  return {
    width,
    height,
    rootWidth: rootRect.w,
    rootHeight: rootRect.h,
    pxPerUnitX: width / rootRect.w,
    pxPerUnitY: height / rootRect.h,
    scaleMode: settings?.scaleMode ?? "fixedauto",
    designWidth: numOr(settings?.designWidth, 1280),
    designHeight: numOr(settings?.designHeight, 720),
  };
}

/** UI 节点的解析矩形（画布局部空间） */
function uiRectOfEntity(entity: Entity | null): UiRect | null {
  if (!entity || typeof entity.id !== "string") return null;
  const chain: Entity[] = [];
  let cur: Entity | null = entity;
  let canvas: UICanvasNode | null = null;
  while (cur) {
    if (cur instanceof UICanvasNode) {
      canvas = cur;
      break;
    }
    chain.unshift(cur);
    cur = cur.parent;
  }
  if (!canvas) return null;
  // 断言安全：userData.uiRect 为 ui.mjs 逐帧写入的渲染矩形（{cx,cy,w,h}）
  const rootRect = canvas.__obj?.userData?.uiRect as UiRect | undefined;
  if (!rootRect) return null;
  if (entity === canvas) {
    return { cx: rootRect.cx, cy: rootRect.cy, w: rootRect.w, h: rootRect.h };
  }
  const leafRect = entity.__obj?.userData?.uiRect as UiRect | undefined;
  if (!leafRect) return null;
  const rect = { cx: leafRect.cx, cy: leafRect.cy, w: leafRect.w, h: leafRect.h };
  for (let i = chain.length - 1; i >= 1; i--) {
    const anc = chain[i];
    if (!UI_WIDGET_CLASSES.some((c) => anc instanceof c)) continue;
    const ar = anc.__obj?.userData?.uiRect as UiRect | undefined;
    if (!ar) return null;
    rect.cx += ar.cx;
    rect.cy += ar.cy;
  }
  return rect;
}

const uiApi = {
  set(entity: Entity, patch: unknown): void {
    state.host?.ui?.updateSettings(entity?.id, patch);
  },
  get(entity: Entity): UiSettings | null {
    return state.host?.ui?.settingsOf(entity?.id) ?? null;
  },
  onClick(entity: Entity, cb: () => void): () => void {
    const un = state.host?.ui?.onClick(entity?.id, cb);
    return typeof un === "function" ? un : () => {};
  },
  offClick(entity: Entity, cb: () => void): void {
    state.host?.ui?.offClick(entity?.id, cb);
  },
  rectOf(entity: Entity): UiRect | null {
    return uiRectOfEntity(entity);
  },
  metricsOf(entity: Entity): UIScreenMetrics | null {
    const canvas = uiCanvasEntityOf(entity);
    return canvas ? uiMetricsOfCanvas(canvas) : null;
  },
  screenToUi(entity: Entity, x: number, y: number): { x: number; y: number } | null {
    const canvas = uiCanvasEntityOf(entity);
    if (!canvas) return null;
    const m = uiMetricsOfCanvas(canvas);
    if (!m) return null;
    return { x: (x - m.width / 2) / m.pxPerUnitX, y: -(y - m.height / 2) / m.pxPerUnitY };
  },
};

export { uiApi };
