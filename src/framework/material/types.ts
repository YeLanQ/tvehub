// ---------------------------------------------------------------------------
// 材质系统基础类型与约定（framework 层，不依赖 app/api）
// ---------------------------------------------------------------------------

/** 标准材质参数（对应 three 的 MeshStandardMaterial 可调项） */
export interface MaterialParams {
  /** 漫反射颜色（RGB hex number） */
  color: number;
  /** 金属度 0..1 */
  metalness: number;
  /** 粗糙度 0..1 */
  roughness: number;
  /** 自发光颜色（RGB hex number；黑色 = 不发光） */
  emissive: number;
  /** 线框渲染 */
  wireframe: boolean;
}

/** 可被编辑的材质参数字段名 */
export type MaterialParamKey = keyof MaterialParams;

/** 材质资产文件扩展名 */
export const MATERIAL_EXT = ".mat";

/** 编辑器内置材质目录（相对路径，根为 "internal/"） */
export const INTERNAL_MATERIAL_ROOT = "internal/materials";

/** 内置默认材质（网格未指定材质时引用它） */
export const DEFAULT_MATERIAL_REL = `${INTERNAL_MATERIAL_ROOT}/Default.mat`;

/** 兜底参数：与内置 internal/materials/Default.mat 内容保持一致 */
export const DEFAULT_MATERIAL_PARAMS: MaterialParams = {
  color: 0x9aa4b2,
  metalness: 0.1,
  roughness: 0.75,
  emissive: 0x000000,
  wireframe: false,
};

/** 判断材质引用是否位于内置目录（internal/…；只读，编辑前需复制到项目） */
export function isInternalMaterialRel(rel: string): boolean {
  return rel === "internal" || rel.startsWith("internal/");
}

/** 材质资产相对路径 → 文件名（含扩展名） */
export function materialFileName(rel: string): string {
  const segs = rel.split("/");
  return segs[segs.length - 1] ?? rel;
}

/** 材质资产相对路径 → 文件名（去掉扩展名） */
export function materialFileStem(rel: string): string {
  const name = materialFileName(rel);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/** 颜色：number / "#rrggbb" 字符串 → RGB hex number（失败回退 white） */
export function parseColorHex(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v & 0xffffff;
  if (typeof v === "string") {
    const s = v.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(s)) return parseInt(s, 16) & 0xffffff;
    if (/^[0-9a-fA-F]{3}$/.test(s)) {
      const n = parseInt(s, 16);
      const r = (n >> 8) & 0xf;
      const g = (n >> 4) & 0xf;
      const b = n & 0xf;
      return ((r | (r << 4)) << 16) | ((g | (g << 4)) << 8) | (b | (b << 4));
    }
  }
  return 0xffffff;
}

/** 颜色 → "#rrggbb" 展示串 */
export function colorToHexString(c: number): string {
  return "#" + (c & 0xffffff).toString(16).padStart(6, "0");
}

/** 数值收敛助手：保留有限数字 */
function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

function bool(v: unknown, fb: boolean): boolean {
  return typeof v === "boolean" ? v : fb;
}

/** 从任意来源读取材质参数（缺失字段回退默认） */
export function materialParamsFrom(v: unknown): MaterialParams {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    color: parseColorHex(o.color) | 0,
    metalness: Math.max(0, Math.min(1, num(o.metalness, DEFAULT_MATERIAL_PARAMS.metalness))),
    roughness: Math.max(0, Math.min(1, num(o.roughness, DEFAULT_MATERIAL_PARAMS.roughness))),
    emissive: parseColorHex(o.emissive) | 0,
    wireframe: bool(o.wireframe, DEFAULT_MATERIAL_PARAMS.wireframe),
  };
}

export function cloneMaterialParams(p: MaterialParams): MaterialParams {
  return { ...p };
}
