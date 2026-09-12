// ---------------------------------------------------------------------------
// UI 运行期控制（按实体寻址；画布/Widget 设置 + 按钮点击订阅，经 engine.ui 调用）
// UI 布局/坐标查询（rectOf/metricsOf/screenToUi）——数据来自 ui.mjs 逐帧解析并缓存在
// 节点 userData.uiRect 的渲染矩形与画布根矩形（rootRect = 屏幕尺寸的 UI 单位数）。
// 空间约定：画布局部空间，原点 = 画布中心，y 向上，单位 = UI 单位。
// ---------------------------------------------------------------------------
import { state, numOr } from "./state.mjs";
import {
  UICanvasNode,
  UIImageNode,
  UITextNode,
  UIButtonNode,
  UILayoutNode,
} from "./node-types.mjs";

const UI_WIDGET_CLASSES = [UICanvasNode, UIImageNode, UITextNode, UIButtonNode, UILayoutNode];

/** 实体所在 UI 画布（沿父链向上；不在画布子树内返回 null） */
function uiCanvasEntityOf(entity) {
  let cur = entity ?? null;
  while (cur) {
    if (cur instanceof UICanvasNode) return cur;
    cur = cur.parent;
  }
  return null;
}

/** 画布屏幕度量（渲染画布 CSS 尺寸 ↔ rootRect；布局未就绪返回 null） */
function uiMetricsOfCanvas(canvasEntity) {
  const rootRect = canvasEntity?.__obj?.userData?.uiRect;
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
function uiRectOfEntity(entity) {
  if (!entity || typeof entity.id !== "string") return null;
  const chain = [];
  let cur = entity;
  let canvas = null;
  while (cur) {
    if (cur instanceof UICanvasNode) {
      canvas = cur;
      break;
    }
    chain.unshift(cur);
    cur = cur.parent;
  }
  if (!canvas) return null;
  const rootRect = canvas.__obj?.userData?.uiRect;
  if (!rootRect) return null;
  if (entity === canvas) {
    return { cx: rootRect.cx, cy: rootRect.cy, w: rootRect.w, h: rootRect.h };
  }
  const leafRect = entity.__obj?.userData?.uiRect;
  if (!leafRect) return null;
  const rect = { cx: leafRect.cx, cy: leafRect.cy, w: leafRect.w, h: leafRect.h };
  for (let i = chain.length - 1; i >= 1; i--) {
    const anc = chain[i];
    if (!UI_WIDGET_CLASSES.some((c) => anc instanceof c)) continue;
    const ar = anc.__obj?.userData?.uiRect;
    if (!ar) return null;
    rect.cx += ar.cx;
    rect.cy += ar.cy;
  }
  return rect;
}

const uiApi = {
  set(entity, patch) {
    state.host?.ui?.updateSettings(entity?.id, patch);
  },
  get(entity) {
    return state.host?.ui?.settingsOf(entity?.id) ?? null;
  },
  onClick(entity, cb) {
    const un = state.host?.ui?.onClick(entity?.id, cb);
    return typeof un === "function" ? un : () => {};
  },
  offClick(entity, cb) {
    state.host?.ui?.offClick(entity?.id, cb);
  },
  rectOf(entity) {
    return uiRectOfEntity(entity);
  },
  metricsOf(entity) {
    const canvas = uiCanvasEntityOf(entity);
    return canvas ? uiMetricsOfCanvas(canvas) : null;
  },
  screenToUi(entity, x, y) {
    const canvas = uiCanvasEntityOf(entity);
    if (!canvas) return null;
    const m = uiMetricsOfCanvas(canvas);
    if (!m) return null;
    return { x: (x - m.width / 2) / m.pxPerUnitX, y: -(y - m.height / 2) / m.pxPerUnitY };
  },
};

export { uiApi };