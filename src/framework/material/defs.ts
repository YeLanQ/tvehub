// 材质参数面板定义（原理化 BSDF 分组/命名风格）：
// 供 MaterialSection 渲染全部可调参数；名称与原理化 BSDF 属性一致，
// 并映射到 three MeshPhysicalMaterial 的属性（见 types.ts）。
import type { MaterialEnableKey, MaterialParamKey } from "./types";

export type MaterialParamKind = "number" | "color" | "bool" | "texture" | "vector";

export interface MaterialParamDef {
  /** 参数字段名：内置分支为 MaterialParamKey，自定义着色器为属性名（任意 _ 前缀标识符） */
  key: string;
  /** 中文显示名（对应属性中文/习惯名；自定义着色器取 Properties 文案） */
  label: string;
  /** 英文属性名/属性键（提示） */
  en: string;
  kind: MaterialParamKind;
  step?: number;
  /** 面板下界（缺省用材质参数默认收敛规则；自定义着色器取属性声明） */
  min?: number;
  /** 面板上界（同上） */
  max?: number;
}

export interface MaterialParamGroup {
  /** 分组标题 */
  title: string;
  /** 启用开关（对应 MaterialParams 中的 boolean 字段；未勾选时该分组参数不生效） */
  enableKey?: MaterialEnableKey;
  /** 启用开关的显示文案 */
  enableLabel?: string;
  defs: MaterialParamDef[];
}

export const MATERIAL_PARAM_GROUPS: MaterialParamGroup[] = [
  {
    title: "贴图（Textures）",
    defs: [
      { key: "map", label: "基础色贴图", en: "Base Color", kind: "texture" },
      { key: "normalMap", label: "法线贴图", en: "Normal", kind: "texture" },
      { key: "metalnessMap", label: "金属度贴图", en: "Metallic", kind: "texture" },
      { key: "roughnessMap", label: "粗糙度贴图", en: "Roughness", kind: "texture" },
      { key: "emissiveMap", label: "发射贴图", en: "Emission", kind: "texture" },
    ],
  },
  {
    title: "基础（Base）",
    defs: [
      { key: "color", label: "基础色", en: "Base Color", kind: "color" },
      { key: "metalness", label: "金属度", en: "Metallic", kind: "number", step: 0.01 },
      { key: "roughness", label: "粗糙度", en: "Roughness", kind: "number", step: 0.01 },
    ],
  },
  {
    title: "高光（Specular）",
    defs: [
      {
        key: "specularIntensity",
        label: "高光 IOR 等级",
        en: "Specular IOR Level",
        kind: "number",
        step: 0.01,
      },
      { key: "specularColor", label: "高光着色", en: "Specular Tint", kind: "color" },
      { key: "ior", label: "折射率", en: "IOR", kind: "number", step: 0.01 },
    ],
  },
  {
    title: "自发光（Emission）",
    enableKey: "emissionEnabled",
    enableLabel: "启用自发光",
    defs: [
      { key: "emissive", label: "发射颜色", en: "Emission Color", kind: "color" },
      {
        key: "emissiveIntensity",
        label: "发射强度",
        en: "Emission Strength",
        kind: "number",
        step: 0.05,
      },
    ],
  },
  {
    title: "清漆（Clearcoat）",
    enableKey: "clearcoatEnabled",
    enableLabel: "启用清漆",
    defs: [
      { key: "clearcoat", label: "清漆权重", en: "Coat Weight", kind: "number", step: 0.01 },
      {
        key: "clearcoatRoughness",
        label: "清漆粗糙度",
        en: "Coat Roughness",
        kind: "number",
        step: 0.01,
      },
    ],
  },
  {
    title: "光泽（Sheen）",
    enableKey: "sheenEnabled",
    enableLabel: "启用光泽",
    defs: [
      { key: "sheen", label: "光泽权重", en: "Sheen Weight", kind: "number", step: 0.01 },
      { key: "sheenColor", label: "光泽着色", en: "Sheen Color", kind: "color" },
      {
        key: "sheenRoughness",
        label: "光泽粗糙度",
        en: "Sheen Roughness",
        kind: "number",
        step: 0.01,
      },
    ],
  },
  {
    title: "透射（Transmission）",
    enableKey: "transmissionEnabled",
    enableLabel: "启用透射",
    defs: [
      { key: "transmission", label: "透射权重", en: "Transmission", kind: "number", step: 0.01 },
      { key: "thickness", label: "透射厚度", en: "Thickness", kind: "number", step: 0.1 },
      { key: "attenuationColor", label: "透射衰减颜色", en: "Attenuation Color", kind: "color" },
      {
        key: "attenuationDistance",
        label: "透射衰减距离",
        en: "Attenuation Distance",
        kind: "number",
        step: 0.1,
      },
    ],
  },
  {
    title: "高级（Advanced）",
    defs: [
      { key: "anisotropy", label: "各向异性", en: "Anisotropic", kind: "number", step: 0.01 },
      {
        key: "anisotropyRotation",
        label: "各向异性旋转",
        en: "Anisotropic Rotation",
        kind: "number",
        step: 0.01,
      },
      { key: "iridescence", label: "虹彩", en: "Iridescence", kind: "number", step: 0.01 },
      { key: "iridescenceIOR", label: "虹彩折射率", en: "Iridescence IOR", kind: "number", step: 0.01 },
      { key: "opacity", label: "不透明度", en: "Alpha", kind: "number", step: 0.01 },
      {
        key: "alphaClipThreshold",
        label: "Alpha Clip 阈值",
        en: "Alpha Threshold（0=不裁剪，贴图 alpha 混合；>0 启用裁剪）",
        kind: "number",
        step: 0.01,
      },
      { key: "wireframe", label: "线框", en: "Wireframe", kind: "bool" },
    ],
  },
];

const FLAT = MATERIAL_PARAM_GROUPS.flatMap((g) => g.defs).reduce(
  (acc, d) => {
    acc[d.key] = d;
    return acc;
  },
  {} as Record<string, MaterialParamDef>,
);

/** 内置参数定义（自定义着色器属性无静态定义，由后端 shader_read 的属性表动态构造） */
export function materialParamDef(key: MaterialParamKey): MaterialParamDef {
  return FLAT[key];
}
