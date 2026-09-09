// ---------------------------------------------------------------------------
// 材质类型工厂（注册表模式，风格对齐 prototype/PrototypeRegistry + NodeFactory）：
// - 每种材质类型对应一个 MaterialTypeDef：three 材质构造、参数→属性映射、
//   UI 参数分组、默认参数都收敛在类型定义内；
// - 需要新材质类型时：写一个 MaterialTypeDef 并在 createDefaultMaterialTypeRegistry
//   里 register 一行即可（同步更新网页预览 engine/runtime/material.mjs / engine/runtime/mesh.mjs 的同名分支）；
// - 材质与着色器分离：.mat 经 shader 字段引用 .shader 资产，后端解析出种类 key
//   （physical/unlit/toon，缺省 physical）→ 注册表查找类型定义；旧 .mat 的
//   materialType 字段作为回退仍可读。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import {
  DEFAULT_MATERIAL_PARAMS,
  type MaterialParamKey,
  type MaterialParams,
  type TextureParamKey,
} from "./types";
import {
  MATERIAL_PARAM_GROUPS,
  materialParamDef,
  type MaterialParamGroup,
} from "./defs";

/** 默认材质类型 key（.mat 缺失/未知 materialType 时的回退） */
export const DEFAULT_MATERIAL_TYPE = "physical";

/** 贴图异步装载器（应用层注入，同引擎 loadTexture） */
export interface MaterialTextureLoader {
  loadTexture?(rel: string, srgb: boolean): Promise<THREE.Texture | null>;
}

/** 单个材质类型的完整定义（工厂产物 = three 材质实例 + 参数应用规则） */
export interface MaterialTypeDef {
  /** 类型 key（= 着色器种类；.shader 的 kind 字段取值） */
  key: string;
  /** UI 显示名（属性面板类型标签） */
  label: string;
  /** 工厂：创建该类型的 three 材质实例 */
  create(): THREE.Material;
  /** 缓存复用判断：现有 three 材质是否已是该类型（instanceof） */
  matches(mat: THREE.Material): boolean;
  /** 该类型在属性面板暴露的参数分组（数据驱动 UI） */
  paramGroups: MaterialParamGroup[];
  /** 该类型的默认参数（新建材质/回退用；返回超集 MaterialParams 的一份拷贝） */
  defaultParams(): MaterialParams;
  /** 把参数应用到 three 材质实例（含贴图通道异步回填） */
  apply(mat: THREE.Material, params: MaterialParams, loader?: MaterialTextureLoader): void;
  /**
   * 可选“轮廓体”能力（法线外扩描边，由同步器为网格挂子渲染体）：
   * 返回 null 表示该类型无轮廓或未启用；否则给出轮廓颜色与外扩宽度
   * （宽度为相对对象包围半径的比例，渲染端放大几何时换算）。
   */
  outlineFor?(params: MaterialParams): OutlineConfig | null;
}

/** 轮廓体配置（法线外扩描边：颜色 + 相对对象包围半径的宽度） */
export interface OutlineConfig {
  color: number;
  width: number;
}

/** 材质类型注册表：key → 类型定义 */
export class MaterialTypeRegistry {
  private defs = new Map<string, MaterialTypeDef>();

  register(def: MaterialTypeDef): void {
    this.defs.set(def.key, def);
  }

  /** 按类型 key 取定义；未注册返回 null */
  get(key: string): MaterialTypeDef | null {
    return this.defs.get(key) ?? null;
  }

  /** 按类型 key 取定义；未注册/未知回退默认类型（保证渲染不中断） */
  getOrDefault(key: string): MaterialTypeDef {
    return this.defs.get(key) ?? this.defs.get(DEFAULT_MATERIAL_TYPE)!;
  }

  /** 已注册类型列表（注册顺序 = UI 展示顺序） */
  list(): MaterialTypeDef[] {
    return [...this.defs.values()];
  }
}

/** 按贴图通道字段异步装载并回填材质（无加载器/空引用则清空该通道） */
export function attachTextureChannel(
  loader: MaterialTextureLoader | undefined,
  params: MaterialParams,
  key: TextureParamKey,
  srgb: boolean,
  assign: (tex: THREE.Texture | null) => void,
): void {
  const rel = params[key];
  if (!rel || !loader?.loadTexture) {
    assign(null);
    return;
  }
  void loader.loadTexture(rel, srgb).then((tex) => {
    assign(tex);
  });
}

// ---------------------------------------------------------------------------
// PBR（physical）：three MeshPhysicalMaterial，Blender 原理化 BSDF 映射，
// 参数映射与默认值即材质资产化以来的既有行为（原 SceneSynchronizer 内联实现）。
// ---------------------------------------------------------------------------

function applyPhysical(
  mat: THREE.Material,
  params: MaterialParams,
  loader?: MaterialTextureLoader,
): void {
  const m = mat as THREE.MeshPhysicalMaterial;
  m.color.setHex(params.color);
  m.metalness = params.metalness;
  m.roughness = params.roughness;
  m.specularIntensity = params.specularIntensity;
  m.specularColor.setHex(params.specularColor);
  m.ior = params.ior;
  // 效果分组由启用开关控制：未勾选启用时相关参数强制为中性值（不产生可见效果）
  const emissionOn = params.emissionEnabled;
  m.emissive.setHex(emissionOn ? params.emissive : 0x000000);
  m.emissiveIntensity = emissionOn ? params.emissiveIntensity : 1;
  m.clearcoat = params.clearcoatEnabled ? params.clearcoat : 0;
  m.clearcoatRoughness = params.clearcoatEnabled ? params.clearcoatRoughness : 0;
  m.sheen = params.sheenEnabled ? params.sheen : 0;
  m.sheenColor.setHex(params.sheenEnabled ? params.sheenColor : 0x000000);
  m.sheenRoughness = params.sheenEnabled ? params.sheenRoughness : 0;
  m.transmission = params.transmissionEnabled ? params.transmission : 0;
  m.thickness = params.transmissionEnabled ? params.thickness : 0;
  m.attenuationColor.setHex(params.transmissionEnabled ? params.attenuationColor : 0xffffff);
  m.attenuationDistance = params.transmissionEnabled ? params.attenuationDistance : 0;
  m.anisotropy = params.anisotropy;
  m.anisotropyRotation = params.anisotropyRotation;
  m.iridescence = params.iridescence;
  m.iridescenceIOR = params.iridescenceIOR;
  m.opacity = params.opacity;
  // 混合模式：opacity<1 → 半透明；贴图裁剪阈值>0 → alphaTest 裁剪；
  // 有贴图但阈值为 0 → 贴图 alpha 走混合透明
  m.transparent =
    params.opacity < 0.999 || (params.map !== "" && params.alphaClipThreshold <= 0.0001);
  m.alphaTest =
    params.map !== "" && params.alphaClipThreshold > 0.0001 ? params.alphaClipThreshold : 0;
  m.wireframe = params.wireframe;
  m.needsUpdate = true;
  // 贴图通道（异步加载后赋值）
  attachTextureChannel(loader, params, "map", true, (t) => {
    m.map = t;
    m.needsUpdate = true;
  });
  attachTextureChannel(loader, params, "emissiveMap", true, (t) => {
    m.emissiveMap = params.emissionEnabled ? t : null;
    m.needsUpdate = true;
  });
  attachTextureChannel(loader, params, "metalnessMap", false, (t) => {
    m.metalnessMap = t;
    m.needsUpdate = true;
  });
  attachTextureChannel(loader, params, "roughnessMap", false, (t) => {
    m.roughnessMap = t;
    m.needsUpdate = true;
  });
  attachTextureChannel(loader, params, "normalMap", false, (t) => {
    m.normalMap = t;
    if (t) m.normalScale.set(1, 1);
    m.needsUpdate = true;
  });
}

const PHYSICAL_DEF: MaterialTypeDef = {
  key: "physical",
  label: "PBR",
  create: () => new THREE.MeshPhysicalMaterial(),
  matches: (mat) => mat instanceof THREE.MeshPhysicalMaterial,
  paramGroups: MATERIAL_PARAM_GROUPS,
  defaultParams: () => ({ ...DEFAULT_MATERIAL_PARAMS }),
  apply: applyPhysical,
};

// ---------------------------------------------------------------------------
// Unlit（unlit）：three MeshBasicMaterial，不受光照影响（纯色/贴图直出），
// 适合 UI 面、标志、风格化场景；参数为 PBR 超集的子集，其余字段忽略不写。
// ---------------------------------------------------------------------------

const UNLIT_PARAM_GROUPS: MaterialParamGroup[] = [
  {
    title: "贴图（Textures）",
    defs: [{ key: "map", label: "基础色贴图", en: "Base Color", kind: "texture" }],
  },
  {
    title: "基础（Base）",
    defs: [{ key: "color", label: "基础色", en: "Base Color", kind: "color" }],
  },
  {
    title: "输出（Output）",
    defs: [
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

function applyUnlit(
  mat: THREE.Material,
  params: MaterialParams,
  loader?: MaterialTextureLoader,
): void {
  const m = mat as THREE.MeshBasicMaterial;
  m.color.setHex(params.color);
  m.opacity = params.opacity;
  // 混合模式与 physical 同规则：opacity<1 半透明；贴图阈值>0 走 alphaTest 裁剪
  m.transparent =
    params.opacity < 0.999 || (params.map !== "" && params.alphaClipThreshold <= 0.0001);
  m.alphaTest =
    params.map !== "" && params.alphaClipThreshold > 0.0001 ? params.alphaClipThreshold : 0;
  m.wireframe = params.wireframe;
  m.needsUpdate = true;
  attachTextureChannel(loader, params, "map", true, (t) => {
    m.map = t;
    m.needsUpdate = true;
  });
}

const UNLIT_DEF: MaterialTypeDef = {
  key: "unlit",
  label: "Unlit",
  create: () => new THREE.MeshBasicMaterial(),
  matches: (mat) => mat instanceof THREE.MeshBasicMaterial,
  paramGroups: UNLIT_PARAM_GROUPS,
  defaultParams: () => ({ ...DEFAULT_MATERIAL_PARAMS }),
  apply: applyUnlit,
};

// ---------------------------------------------------------------------------
// Toon（toon）：three MeshToonMaterial，cel shading 风格。
// 明暗档位由 gradientMap 灰阶渐变条决定（shader 只按红通道分档）：
// three 要求 NearestFilter + 关闭 mipmap + NoColorSpace。渐变条按
// toonSteps 档数与 toonShadowStrength（最暗档亮度 = 1 − strength）程序化生成，
// 以 (steps:strength) 签名为 key 缓存于材质 userData，参数变化才重建并释放旧图。
// 其余字段（physical 的金属度/粗糙度等）为超集保留、此类型忽略不写。
// ---------------------------------------------------------------------------

/** 渐变条签名缓存 key（材质 userData；防每帧重复生成） */
const TOON_GRAD_KEY = "__toonGradKey";

/** 生成卡通灰阶渐变条 DataTexture：n 列灰阶（暗→亮），满足 MeshToonMaterial 约束 */
function makeToonGradientTexture(steps: number, shadowStrength: number): THREE.DataTexture {
  const n = Math.max(2, Math.min(6, Math.round(steps)));
  const darkest = Math.max(0, Math.min(1, 1 - shadowStrength));
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    // 首档 = 最暗（1 − strength），末档 = 亮部 1，中间线性过渡
    const v = darkest + (i / (n - 1)) * (1 - darkest);
    const byte = Math.round(Math.max(0, Math.min(1, v)) * 255);
    data[i * 4] = byte;
    data[i * 4 + 1] = byte;
    data[i * 4 + 2] = byte;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, 1);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const TOON_PARAM_GROUPS: MaterialParamGroup[] = [
  {
    title: "贴图（Textures）",
    defs: (["map", "normalMap", "emissiveMap"] as MaterialParamKey[]).map((k) =>
      materialParamDef(k),
    ),
  },
  {
    title: "基础（Base）",
    defs: [materialParamDef("color")],
  },
  {
    title: "卡通明暗（Toon）",
    defs: [
      { key: "toonSteps", label: "明暗档数", en: "Toon Steps", kind: "number", step: 1 },
      {
        key: "toonShadowStrength",
        label: "阴影强度",
        en: "Shadow Strength",
        kind: "number",
        step: 0.01,
      },
    ],
  },
  {
    title: "自发光（Emission）",
    enableKey: "emissionEnabled",
    enableLabel: "启用自发光",
    defs: [materialParamDef("emissive"), materialParamDef("emissiveIntensity")],
  },
  {
    title: "轮廓（Outline）",
    enableKey: "outlineEnabled",
    enableLabel: "启用轮廓",
    defs: [
      {
        key: "outlineColor",
        label: "轮廓颜色",
        en: "Outline Color",
        kind: "color",
      },
      {
        key: "outlineWidth",
        label: "轮廓宽度",
        en: "Outline Width",
        kind: "number",
        step: 0.001,
      },
    ],
  },
  {
    title: "输出（Output）",
    defs: [
      materialParamDef("opacity"),
      materialParamDef("alphaClipThreshold"),
      materialParamDef("wireframe"),
    ],
  },
];

function applyToon(
  mat: THREE.Material,
  params: MaterialParams,
  loader?: MaterialTextureLoader,
): void {
  const m = mat as THREE.MeshToonMaterial;
  m.color.setHex(params.color);
  // 渐变条：签名一致时复用已有纹理，避免反复重建（重建前释放旧 GPU 纹理）
  const sig = `${Math.round(params.toonSteps)}:${params.toonShadowStrength.toFixed(3)}`;
  const userData = m.userData as Record<string, unknown>;
  if (userData[TOON_GRAD_KEY] !== sig) {
    if (m.gradientMap) m.gradientMap.dispose();
    m.gradientMap = makeToonGradientTexture(params.toonSteps, params.toonShadowStrength);
    userData[TOON_GRAD_KEY] = sig;
  }
  const emissionOn = params.emissionEnabled;
  m.emissive.setHex(emissionOn ? params.emissive : 0x000000);
  m.emissiveIntensity = emissionOn ? params.emissiveIntensity : 1;
  // 混合模式与 physical/unlit 同规则：opacity<1 半透明；贴图阈值>0 走 alphaTest 裁剪
  m.transparent =
    params.opacity < 0.999 || (params.map !== "" && params.alphaClipThreshold <= 0.0001);
  m.alphaTest =
    params.map !== "" && params.alphaClipThreshold > 0.0001 ? params.alphaClipThreshold : 0;
  m.wireframe = params.wireframe;
  m.needsUpdate = true;
  attachTextureChannel(loader, params, "map", true, (t) => {
    m.map = t;
    m.needsUpdate = true;
  });
  attachTextureChannel(loader, params, "emissiveMap", true, (t) => {
    m.emissiveMap = params.emissionEnabled ? t : null;
    m.needsUpdate = true;
  });
  attachTextureChannel(loader, params, "normalMap", false, (t) => {
    m.normalMap = t;
    if (t) m.normalScale.set(1, 1);
    m.needsUpdate = true;
  });
}

const TOON_DEF: MaterialTypeDef = {
  key: "toon",
  label: "Toon",
  create: () => {
    const mat = new THREE.MeshToonMaterial();
    // 类型切换 dispose 该材质时，顺带释放其渐变条纹理（Material.dispose 不释放贴图）
    mat.addEventListener("dispose", () => {
      mat.gradientMap?.dispose();
      mat.gradientMap = null;
    });
    return mat;
  },
  matches: (mat) => mat instanceof THREE.MeshToonMaterial,
  paramGroups: TOON_PARAM_GROUPS,
  defaultParams: () => ({ ...DEFAULT_MATERIAL_PARAMS }),
  apply: applyToon,
  outlineFor: (params) =>
    params.outlineEnabled
      ? { color: params.outlineColor, width: params.outlineWidth }
      : null,
};

/** 默认材质类型注册表（physical + unlit + toon；新类型在此追加一行 register） */
export function createDefaultMaterialTypeRegistry(): MaterialTypeRegistry {
  const registry = new MaterialTypeRegistry();
  registry.register(PHYSICAL_DEF);
  registry.register(UNLIT_DEF);
  registry.register(TOON_DEF);
  return registry;
}

/** 模块级单例：类型定义无状态，引擎同步与 UI（类型下拉/新建菜单/参数分组）共用 */
export const materialTypeRegistry = createDefaultMaterialTypeRegistry();
