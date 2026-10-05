// 预览运行时通用工具：数值/向量/颜色兜底与混合（供各 libs 模块复用，无副作用）。

/** 角度 → 弧度 */
export const D2R = Math.PI / 180;

/** 数值兜底：非有限数回退 fb */
export function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

/** 数值兜底并夹取到 0..1 */
export function u01(v: unknown, fb: number): number {
  return Math.max(0, Math.min(1, num(v, fb)));
}

/** 对象兜底：非对象回退 fb（fb 形状即调用方期望的读面） */
export function vec<T>(v: unknown, fb: T): T {
  return (v && typeof v === "object" ? v : fb) as T;
}

/** 颜色：number / "#rrggbb" → number */
export function matColor(v: unknown, fb: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v & 0xffffff;
  if (typeof v === "string") {
    const s = v.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(s)) return parseInt(s, 16) & 0xffffff;
  }
  return fb;
}

/** 混合两个 RGB hex 颜色（t=0 全 a，t=1 全 b） */
export function mixHexColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return ((r & 255) << 16) | ((g & 255) << 8) | (bl & 255);
}
