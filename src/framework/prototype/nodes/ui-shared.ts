// UI 系统（Canvas-Widget）共享类型与小工具：
// - UI 空间：画布原点在屏幕中心，+x 右 +y 上，纵向可见范围恒为 [-UI_HALF_HEIGHT, +UI_HALF_HEIGHT]
//   （透视相机按 fov 推距离、正交相机按缩放对齐，编辑器与运行时同一套数学，见 engine/modules/ui.ts）；
// - 排序：Widget 的 sortOrder 与画布级 sortOrder 合成渲染序（renderOrder），
//   画布整体先比、画布内 Widget 再比；都关深度测试按序叠加。

/** UI 空间半高（UI 单位；屏幕纵向可见 10 个 UI 单位） */
export const UI_HALF_HEIGHT = 5;

/**
 * 2D 设计标准：1 UI 单位 = 100 设计像素（统一美术工作流）。
 * 画布渲染尺寸 = 设计分辨率/100（如 1280×720 → 12.8×7.2 单位），
 * 2D Transform（anchoredPosition/offset/size）与检查器均按此换算（检查器显示像素）。
 */
export const UI_PPU = 100;

/** 设计像素 → UI 单位 */
export function pxToUnits(px: number): number {
  return px / UI_PPU;
}

/** UI 单位 → 设计像素 */
export function unitsToPx(units: number): number {
  return units * UI_PPU;
}

/** renderOrder 基底（远超普通场景透明物；与正交天空背景面的 -1e6 区分） */
export const UI_RENDER_ORDER_BASE = 1000000;

/** Widget 排序收敛范围（防极端值把 renderOrder 推出 float 精度区） */
export function clampUISortOrder(v: unknown, fallback = 0): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(999, Math.max(-999, n));
}

/** 画布排序收敛范围（乘 1e4 后叠加 Widget 序，仍在安全整数区） */
export function clampUICanvasSortOrder(v: unknown, fallback = 0): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(500, Math.max(-500, n));
}

/** 合成渲染序：画布序（权重 1e4）优先，画布内 Widget 序次之 */
export function uiRenderOrder(canvasSortOrder: number, widgetSortOrder: number): number {
  return UI_RENDER_ORDER_BASE + canvasSortOrder * 10000 + widgetSortOrder;
}

/** UI 二维尺寸（UI 单位；Widget 几何按此构建，变换 scale 再叠加） */
export interface Vec2 {
  x: number;
  y: number;
}

export function vec2(x: number, y: number): Vec2 {
  return { x, y };
}

/** 任意来源 → Vec2（非法回退 fallback；分量收敛为正数，最小 0.01） */
export function parseVec2(v: unknown, fallback: Vec2): Vec2 {
  const o = v && typeof v === "object" ? (v as Partial<Vec2>) : null;
  const dim = (n: unknown, fb: number) =>
    typeof n === "number" && Number.isFinite(n) ? Math.max(0.01, n) : fb;
  return { x: dim(o?.x, fallback.x), y: dim(o?.y, fallback.y) };
}

/** 颜色收敛（int24；非法回退 fallback） */
export function parseUIColor(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) & 0xffffff : fallback;
}

/** 字号收敛（设计像素字号；非法回退 fallback） */
export function parseUIFontNumber(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

export type UIFontFamily = "system" | "serif" | "mono";

export function parseUIFontFamily(v: unknown): UIFontFamily {
  return v === "serif" || v === "mono" ? v : "system";
}

/** 字号（设计像素）→ UI 单位高度（100px = 1 单位设计标准） */
export function uiFontSizeToUnits(fontSize: number): number {
  return fontSize / UI_PPU;
}

export type UIAlign = "left" | "center" | "right";

export function parseUIAlign(v: unknown): UIAlign {
  return v === "left" || v === "right" ? v : "center";
}

// ---------------------------------------------------------------------------
// 画布缩放模式（与项目设置 scaleMode / 运行时舞台 stage.mjs 同一名集与语义）：
// 画布设计矩形映射到屏幕矩形的缩放策略。
// ---------------------------------------------------------------------------

export type UIScaleMode = "noscale" | "fixedwidth" | "fixedheight" | "fixedauto" | "full";

export function parseUIScaleMode(v: unknown): UIScaleMode {
  return v === "noscale" || v === "fixedwidth" || v === "fixedheight" || v === "full"
    ? v
    : "fixedauto";
}

/** 画布设计尺寸收敛（像素，1..16384；非法回退 fallback） */
export function parseUIDesignPx(v: unknown, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(16384, Math.max(1, n));
}

/**
 * 缩放模式 → 画布缩放系数（sx/sy；编辑器布局视图把「屏幕 = 高 10 单位、
 * 宽 10×aspect 单位」的矩形按模式映射画布设计矩形；运行时舞台固定按设计
 * 分辨率取景（aspect = 设计比例），各等比模式自然收敛为精确铺满）。
 */
export function uiCanvasModeScale(
  mode: UIScaleMode,
  screenW: number,
  screenH: number,
  canvasW: number,
  canvasH: number,
): { sx: number; sy: number } {
  const cw = Math.max(0.01, canvasW);
  const ch = Math.max(0.01, canvasH);
  switch (mode) {
    case "noscale":
      return { sx: 1, sy: 1 };
    case "fixedwidth":
      return { sx: screenW / cw, sy: screenW / cw };
    case "fixedheight":
      return { sx: screenH / ch, sy: screenH / ch };
    case "full":
      return { sx: screenW / cw, sy: screenH / ch };
    case "fixedauto":
    default: {
      const s = Math.max(screenW / cw, screenH / ch);
      return { sx: s, sy: s };
    }
  }
}

// ---------------------------------------------------------------------------
// 锚点系统（Unity uGUI 同语义，坐标全部为 UI 单位、y 向上）：
// - anchorMin/anchorMax：父矩形上的归一化锚点（0..1；min==max 为点锚点，
//   min<max 为拉伸锚点——该轴尺寸由父矩形与边距推导）；
// - pivot：Widget 自身归一化枢轴（点锚点定位与旋转基准）；
// - anchoredPosition：点锚点轴上「枢轴相对锚点的偏移」；
// - offsetMin/offsetMax：拉伸轴上相对锚线的边距（min=左/下，max=右/上）。
// ---------------------------------------------------------------------------

/** 锚点/枢轴分量收敛到 0..1 */
function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** 任意来源 → Vec2（分量允许任意有限值，不收敛为正；用于位置/偏移类字段） */
export function parseUIFreeVec2(v: unknown, fallback: Vec2): Vec2 {
  const o = v && typeof v === "object" ? (v as Partial<Vec2>) : null;
  const dim = (n: unknown, fb: number) =>
    typeof n === "number" && Number.isFinite(n) ? n : fb;
  return { x: dim(o?.x, fallback.x), y: dim(o?.y, fallback.y) };
}

/** 任意来源 → 归一化 Vec2（分量收敛 0..1；用于锚点/枢轴字段） */
export function parseUIUnitVec2(v: unknown, fallback: Vec2): Vec2 {
  const p = parseUIFreeVec2(v, fallback);
  return { x: clamp01(p.x), y: clamp01(p.y) };
}

/** 父局部空间中的轴对齐矩形（中心 + 尺寸，UI 单位） */
export interface UIRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** 锚点解析输入（Widget 数据字段集 + 设计尺寸） */
export interface UIAnchorInput {
  anchorMin: Vec2;
  anchorMax: Vec2;
  pivot: Vec2;
  anchoredPosition: Vec2;
  offsetMin: Vec2;
  offsetMax: Vec2;
  size: Vec2;
}

/**
 * 在父矩形内解析 Widget 矩形（返回父局部空间坐标）。
 * 点锚点轴：中心 = 锚点 + anchoredPosition + (0.5 - pivot) × 设计尺寸（缩放比
 * 经对象 scale 叠加，不参与位置式）；拉伸轴：矩形 = 两锚线之间收进 offset 边距。
 */
export function resolveUIRect(parent: UIRect, a: UIAnchorInput): UIRect {
  const pMinX = parent.cx - parent.w / 2;
  const pMinY = parent.cy - parent.h / 2;
  const aMinX = clamp01(a.anchorMin.x);
  const aMaxX = clamp01(a.anchorMax.x);
  const aMinY = clamp01(a.anchorMin.y);
  const aMaxY = clamp01(a.anchorMax.y);

  let cx: number;
  let w: number;
  if (aMaxX - aMinX < 1e-6) {
    w = Math.max(0.01, a.size.x);
    cx = pMinX + aMinX * parent.w + a.anchoredPosition.x + (0.5 - clamp01(a.pivot.x)) * w;
  } else {
    const left = pMinX + aMinX * parent.w + a.offsetMin.x;
    const right = pMinX + aMaxX * parent.w - a.offsetMax.x;
    w = Math.max(0.01, right - left);
    cx = (left + right) / 2;
  }

  let cy: number;
  let h: number;
  if (aMaxY - aMinY < 1e-6) {
    h = Math.max(0.01, a.size.y);
    cy = pMinY + aMinY * parent.h + a.anchoredPosition.y + (0.5 - clamp01(a.pivot.y)) * h;
  } else {
    const bottom = pMinY + aMinY * parent.h + a.offsetMin.y;
    const top = pMinY + aMaxY * parent.h - a.offsetMax.y;
    h = Math.max(0.01, top - bottom);
    cy = (bottom + top) / 2;
  }

  return { cx, cy, w, h };
}

/**
 * resolveUIRect 的位置逆解：由父局部坐标反推 anchoredPosition。
 * 点锚点轴返回换算值；拉伸轴返回 null（位置由边距决定，拖拽不可表达）。
 */
export function uiInverseAnchoredPosition(
  parent: UIRect,
  a: UIAnchorInput,
  cx: number,
  cy: number,
): { x: number | null; y: number | null } {
  const pMinX = parent.cx - parent.w / 2;
  const pMinY = parent.cy - parent.h / 2;
  const aMinX = clamp01(a.anchorMin.x);
  const aMaxX = clamp01(a.anchorMax.x);
  const aMinY = clamp01(a.anchorMin.y);
  const aMaxY = clamp01(a.anchorMax.y);
  const x =
    aMaxX - aMinX < 1e-6
      ? cx - (pMinX + aMinX * parent.w) - (0.5 - clamp01(a.pivot.x)) * Math.max(0.01, a.size.x)
      : null;
  const y =
    aMaxY - aMinY < 1e-6
      ? cy - (pMinY + aMinY * parent.h) - (0.5 - clamp01(a.pivot.y)) * Math.max(0.01, a.size.y)
      : null;
  return { x, y };
}

// ---------------------------------------------------------------------------
// 布局系统（Layout Group）：横向 / 竖向 / 网格排列直接子 Widget。
// 内容区 = 容器矩形收进 padding；子元素按给定的顺序排布并在槽位内居中。
// ---------------------------------------------------------------------------

export type UILayoutMode = "none" | "horizontal" | "vertical" | "grid";

export function parseUILayoutMode(v: unknown): UILayoutMode {
  return v === "horizontal" || v === "vertical" || v === "grid" ? v : "none";
}

/** 内边距（UI 单位；left/right/top/bottom） */
export interface UIPadding {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function parseUIPadding(v: unknown, fallback: UIPadding): UIPadding {
  const o = v && typeof v === "object" ? (v as Partial<UIPadding>) : null;
  const dim = (n: unknown, fb: number) =>
    typeof n === "number" && Number.isFinite(n) ? n : fb;
  return {
    left: dim(o?.left, fallback.left),
    right: dim(o?.right, fallback.right),
    top: dim(o?.top, fallback.top),
    bottom: dim(o?.bottom, fallback.bottom),
  };
}

/**
 * 计算布局子元素的中心点（容器局部空间，原点 = 容器中心，y 向上）。
 * - horizontal：从内容区左缘起向右排一行，垂直居中；
 * - vertical：从内容区顶缘起向下排一列，水平居中；
 * - grid：列数固定（gridColumns），格子尺寸 = 子元素最大宽高，行从上往下，
 *   子元素在格子内居中。
 * 返回数组与 sizes 一一对应；sizes 为空或 mode=none 返回空数组。
 */
export function resolveUILayoutCenters(
  rect: UIRect,
  mode: UILayoutMode,
  sizes: Vec2[],
  padding: UIPadding,
  spacing: Vec2,
  gridColumns: number,
): Vec2[] {
  const n = sizes.length;
  if (mode === "none" || n === 0) return [];
  const contentL = rect.cx - rect.w / 2 + padding.left;
  const contentR = rect.cx + rect.w / 2 - padding.right;
  const contentT = rect.cy + rect.h / 2 - padding.top;
  const contentB = rect.cy - rect.h / 2 - padding.bottom;
  const midY = (contentT + contentB) / 2;
  const midX = (contentL + contentR) / 2;
  const sx = Math.max(0, spacing.x);
  const sy = Math.max(0, spacing.y);
  const out: Vec2[] = new Array(n);

  if (mode === "horizontal") {
    let cursor = contentL;
    for (let i = 0; i < n; i++) {
      const w = Math.max(0.01, sizes[i].x);
      out[i] = { x: cursor + w / 2, y: midY };
      cursor += w + sx;
    }
    return out;
  }
  if (mode === "vertical") {
    let cursor = contentT;
    for (let i = 0; i < n; i++) {
      const h = Math.max(0.01, sizes[i].y);
      out[i] = { x: midX, y: cursor - h / 2 };
      cursor -= h + sy;
    }
    return out;
  }
  // grid
  let cellW = 0.01;
  let cellH = 0.01;
  for (const s of sizes) {
    cellW = Math.max(cellW, s.x);
    cellH = Math.max(cellH, s.y);
  }
  const cols = Math.max(1, Math.round(gridColumns));
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    out[i] = {
      x: contentL + col * (cellW + sx) + cellW / 2,
      y: contentT - row * (cellH + sy) - cellH / 2,
    };
  }
  return out;
}
