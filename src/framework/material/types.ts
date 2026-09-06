// ---------------------------------------------------------------------------
// 材质系统基础类型与约定（framework 层，不依赖 app/api）
//
// 参数面 = three 的 PBR 材质（MeshPhysicalMaterial）支持的、且与 Blender
// “原理化 BSDF(Principled BSDF)” 属性对应的参数（无贴图通道）：
//   Base Color→color, Metallic→metalness, Roughness→roughness,
//   Specular IOR Level→specularIntensity, Specular Tint→specularColor, IOR→ior,
//   Emission Color→emissive, Emission Strength→emissiveIntensity,
//   Coat Weight→clearcoat, Coat Roughness→clearcoatRoughness,
//   Sheen Weight→sheen, Sheen Color→sheenColor, Sheen Roughness→sheenRoughness,
//   Transmission Weight→transmission, Thickness→thickness,
//   Attenuation→attenuationColor/attenuationDistance,
//   Anisotropic→anisotropy, Anisotropic Rotation→anisotropyRotation,
//   Iridescence→iridescence(+iridescenceIOR),
//   Alpha→opacity（自动开透明），外加工具项 wireframe。
// ---------------------------------------------------------------------------

/** RGB hex number */
export type ColorHex = number;

/** 支持贴图通道的字段（值为项目资产相对路径；空串 = 无贴图） */
export type TextureParamKey =
  | "map"
  | "metalnessMap"
  | "roughnessMap"
  | "normalMap"
  | "emissiveMap";

/** 需显式勾选启用才生效的效果分组开关（自发光/清漆/光泽/透射） */
export type MaterialEnableKey =
  | "emissionEnabled"
  | "clearcoatEnabled"
  | "sheenEnabled"
  | "transmissionEnabled";

/** 判断字段是否为效果分组启用开关 */
export function isMaterialEnableKey(
  key: MaterialParamKey | MaterialEnableKey,
): key is MaterialEnableKey {
  return (
    key === "emissionEnabled" ||
    key === "clearcoatEnabled" ||
    key === "sheenEnabled" ||
    key === "transmissionEnabled"
  );
}

/** 可被编辑的材质参数字段名（标准 PBR 参数 + 贴图通道 + 工具项） */
export type MaterialParamKey =
  | "color"
  | "metalness"
  | "roughness"
  | "specularIntensity"
  | "specularColor"
  | "ior"
  | "emissive"
  | "emissiveIntensity"
  | "clearcoat"
  | "clearcoatRoughness"
  | "sheen"
  | "sheenColor"
  | "sheenRoughness"
  | "transmission"
  | "thickness"
  | "attenuationColor"
  | "attenuationDistance"
  | "anisotropy"
  | "anisotropyRotation"
  | "iridescence"
  | "iridescenceIOR"
  | "opacity"
  | "alphaClipThreshold"
  | "wireframe"
  | TextureParamKey;

/** PBR 材质参数（three MeshPhysicalMaterial 可映射的全部标量/颜色/贴图项） */
export interface MaterialParams {
  /** 基础色（Base Color） */
  color: number;
  /** 金属度（Metallic）0..1 */
  metalness: number;
  /** 粗糙度（Roughness）0..1 */
  roughness: number;
  /** 高光 IOR 等级（Specular IOR Level，three specularIntensity）0..1 */
  specularIntensity: number;
  /** 高光着色（Specular Tint，three specularColor） */
  specularColor: number;
  /** 折射率（IOR）1.0..2.333 */
  ior: number;
  /** 发射颜色（Emission Color） */
  emissive: number;
  /** 发射强度（Emission Strength）0..10 */
  emissiveIntensity: number;
  /** 自发光启用开关：false 时忽略 emissive/emissiveIntensity/emissiveMap */
  emissionEnabled: boolean;
  /** 清漆权重（Coat Weight）0..1 */
  clearcoat: number;
  /** 清漆粗糙度（Coat Roughness）0..1 */
  clearcoatRoughness: number;
  /** 清漆启用开关：false 时忽略 clearcoat/clearcoatRoughness */
  clearcoatEnabled: boolean;
  /** 光泽权重（Sheen Weight）0..1 */
  sheen: number;
  /** 光泽着色（Sheen Color） */
  sheenColor: number;
  /** 光泽粗糙度（Sheen Roughness）0..1 */
  sheenRoughness: number;
  /** 光泽启用开关：false 时忽略 sheen/sheenColor/sheenRoughness */
  sheenEnabled: boolean;
  /** 透射权重（Transmission Weight）0..1 */
  transmission: number;
  /** 透射厚度（Thickness）0..100 */
  thickness: number;
  /** 衰减颜色（Attenuation Color） */
  attenuationColor: number;
  /** 衰减距离（Attenuation Distance）0..10 */
  attenuationDistance: number;
  /** 透射启用开关：false 时忽略 transmission/thickness/attenuationColor/attenuationDistance */
  transmissionEnabled: boolean;
  /** 各向异性（Anisotropic）0..1 */
  anisotropy: number;
  /** 各向异性旋转（Anisotropic Rotation）0..1 */
  anisotropyRotation: number;
  /** 虹彩（Iridescence）0..1 */
  iridescence: number;
  /** 虹彩折射率（Iridescence IOR）1.0..2.333 */
  iridescenceIOR: number;
  /** 不透明度（Alpha/Opacity）0..1 */
  opacity: number;
  /**
   * 透明裁剪阈值（Alpha Clip Threshold）0..1：>0 且存在基础色贴图时启用
   * alphaTest 裁剪（贴图 alpha 低于阈值的片元被丢弃，圆/镂空贴图即透明）；
   * 0 = 不裁剪（贴图 alpha 走混合透明）。
   */
  alphaClipThreshold: number;
  /** 线框（渲染工具项） */
  wireframe: boolean;
  // —— 贴图通道（相对路径；空串 = 无）——
  /** 基础色贴图（Base Color） */
  map: string;
  /** 金属度贴图（Metallic） */
  metalnessMap: string;
  /** 粗糙度贴图（Roughness） */
  roughnessMap: string;
  /** 法线贴图（Normal） */
  normalMap: string;
  /** 自发光贴图（Emission） */
  emissiveMap: string;
}

/** 材质资产文件扩展名 */
export const MATERIAL_EXT = ".mat";

/** 编辑器内置材质目录（相对路径，根为 "internal/"） */
export const INTERNAL_MATERIAL_ROOT = "internal/materials";

/** 内置默认材质（网格未指定材质时引用它） */
export const DEFAULT_MATERIAL_REL = `${INTERNAL_MATERIAL_ROOT}/Default.mat`;

/**
 * 兜底/默认参数：与内置 internal/materials/Default.mat 语义一致
 * （新增 PBR 项取 three MeshPhysicalMaterial 默认值）。
 */
export const DEFAULT_MATERIAL_PARAMS: MaterialParams = {
  color: 0x9aa4b2,
  metalness: 0.1,
  roughness: 0.75,
  specularIntensity: 1,
  specularColor: 0xffffff,
  ior: 1.5,
  emissive: 0x000000,
  emissiveIntensity: 1,
  emissionEnabled: false,
  clearcoat: 0,
  clearcoatRoughness: 0,
  clearcoatEnabled: false,
  sheen: 0,
  sheenColor: 0xffffff,
  sheenRoughness: 0.5,
  sheenEnabled: false,
  transmission: 0,
  thickness: 0,
  attenuationColor: 0xffffff,
  attenuationDistance: 0,
  transmissionEnabled: false,
  anisotropy: 0,
  anisotropyRotation: 0,
  iridescence: 0,
  iridescenceIOR: 1.3,
  opacity: 1,
  alphaClipThreshold: 0.5,
  wireframe: false,
  // 贴图通道默认空（无贴图）
  map: "",
  metalnessMap: "",
  roughnessMap: "",
  normalMap: "",
  emissiveMap: "",
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

/** 颜色：number / "#rrggbb" 字符串 → RGB hex number（失败回退 fallback） */
export function parseColorHex(v: unknown, fallback = 0xffffff): number {
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
  return fallback & 0xffffff;
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

/** 0..1 范围数值 */
function unit(v: unknown, fb: number): number {
  return Math.max(0, Math.min(1, num(v, fb)));
}

/** 从任意来源读取材质参数（缺失字段回退默认） */
export function materialParamsFrom(v: unknown): MaterialParams {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const d = DEFAULT_MATERIAL_PARAMS;
  return {
    color: parseColorHex(o.color, d.color),
    metalness: unit(o.metalness, d.metalness),
    roughness: unit(o.roughness, d.roughness),
    specularIntensity: unit(o.specularIntensity, d.specularIntensity),
    specularColor: parseColorHex(o.specularColor, d.specularColor),
    ior: Math.max(1, Math.min(2.333, num(o.ior, d.ior))),
    emissive: parseColorHex(o.emissive, d.emissive),
    emissiveIntensity: Math.max(0, Math.min(10, num(o.emissiveIntensity, d.emissiveIntensity))),
    emissionEnabled: bool(o.emissionEnabled, d.emissionEnabled),
    clearcoat: unit(o.clearcoat, d.clearcoat),
    clearcoatRoughness: unit(o.clearcoatRoughness, d.clearcoatRoughness),
    clearcoatEnabled: bool(o.clearcoatEnabled, d.clearcoatEnabled),
    sheen: unit(o.sheen, d.sheen),
    sheenColor: parseColorHex(o.sheenColor, d.sheenColor),
    sheenRoughness: unit(o.sheenRoughness, d.sheenRoughness),
    sheenEnabled: bool(o.sheenEnabled, d.sheenEnabled),
    transmission: unit(o.transmission, d.transmission),
    thickness: Math.max(0, Math.min(100, num(o.thickness, d.thickness))),
    attenuationColor: parseColorHex(o.attenuationColor, d.attenuationColor),
    attenuationDistance: Math.max(0, Math.min(10, num(o.attenuationDistance, d.attenuationDistance))),
    transmissionEnabled: bool(o.transmissionEnabled, d.transmissionEnabled),
    anisotropy: unit(o.anisotropy, d.anisotropy),
    anisotropyRotation: unit(o.anisotropyRotation, d.anisotropyRotation),
    iridescence: unit(o.iridescence, d.iridescence),
    iridescenceIOR: Math.max(1, Math.min(2.333, num(o.iridescenceIOR, d.iridescenceIOR))),
    opacity: unit(o.opacity, d.opacity),
    alphaClipThreshold: unit(o.alphaClipThreshold, d.alphaClipThreshold),
    wireframe: bool(o.wireframe, d.wireframe),
    map: typeof o.map === "string" ? o.map : "",
    metalnessMap: typeof o.metalnessMap === "string" ? o.metalnessMap : "",
    roughnessMap: typeof o.roughnessMap === "string" ? o.roughnessMap : "",
    normalMap: typeof o.normalMap === "string" ? o.normalMap : "",
    emissiveMap: typeof o.emissiveMap === "string" ? o.emissiveMap : "",
  };
}

export function cloneMaterialParams(p: MaterialParams): MaterialParams {
  return { ...p };
}

/** 单参数收敛（属性面板编辑后统一入口；颜色已按 hex 截断） */
export function clampMaterialParam(key: MaterialParamKey, value: number): number {
  switch (key) {
    case "metalness":
    case "roughness":
    case "specularIntensity":
    case "clearcoat":
    case "clearcoatRoughness":
    case "sheen":
    case "sheenRoughness":
    case "transmission":
    case "anisotropy":
    case "anisotropyRotation":
    case "iridescence":
    case "opacity":
    case "alphaClipThreshold":
      return Math.max(0, Math.min(1, value));
    case "ior":
    case "iridescenceIOR":
      return Math.max(1, Math.min(2.333, value));
    case "emissiveIntensity":
      return Math.max(0, Math.min(10, value));
    case "thickness":
      return Math.max(0, Math.min(100, value));
    case "attenuationDistance":
      return Math.max(0, Math.min(10, value));
    case "color":
    case "specularColor":
    case "emissive":
    case "sheenColor":
    case "attenuationColor":
      return value & 0xffffff;
    default:
      return value;
  }
}

/** 数值上限（属性面板 NumberField max） */
export function materialParamMax(key: MaterialParamKey): number {
  switch (key) {
    case "ior":
    case "iridescenceIOR":
      return 2.333;
    case "emissiveIntensity":
      return 10;
    case "thickness":
      return 100;
    case "attenuationDistance":
      return 10;
    default:
      return 1;
  }
}

/** 是否为贴图通道字段 */
export function isTextureParamKey(key: MaterialParamKey): key is TextureParamKey {
  return (
    key === "map" ||
    key === "metalnessMap" ||
    key === "roughnessMap" ||
    key === "normalMap" ||
    key === "emissiveMap"
  );
}
