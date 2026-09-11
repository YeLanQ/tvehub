// UI 系统（Canvas-Widget）共享类型与小工具：
// - UI 空间：画布原点在屏幕中心，+x 右 +y 上，纵向可见范围恒为 [-UI_HALF_HEIGHT, +UI_HALF_HEIGHT]
//   （透视相机按 fov 推距离、正交相机按缩放对齐，编辑器与运行时同一套数学，见 engine/modules/ui.ts）；
// - 排序：Widget 的 sortOrder 与画布级 sortOrder 合成渲染序（renderOrder），
//   画布整体先比、画布内 Widget 再比；都关深度测试按序叠加。

/** UI 空间半高（UI 单位；屏幕纵向可见 10 个 UI 单位） */
export const UI_HALF_HEIGHT = 5;

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

/** 字号收敛（1080p 参考分辨率下的像素字号；非法回退 fallback） */
export function parseUIFontNumber(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

export type UIFontFamily = "system" | "serif" | "mono";

export function parseUIFontFamily(v: unknown): UIFontFamily {
  return v === "serif" || v === "mono" ? v : "system";
}

/** 字号（UI 单位高度）→ 像素（1080p 参考分辨率映射到 UI 空间） */
export function uiFontSizeToUnits(fontSize: number): number {
  return (fontSize / 1080) * UI_HALF_HEIGHT * 2;
}

export type UIAlign = "left" | "center" | "right";

export function parseUIAlign(v: unknown): UIAlign {
  return v === "left" || v === "right" ? v : "center";
}
