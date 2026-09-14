// ---------------------------------------------------------------------------
// 地形材质数据类型（framework 层，不依赖 app/api）。
//
// 地形材质资产（.terrainmat）持有可 JSON 序列化的地形材质设置：4 个纹理图层
// （albedo/normal/tiling/color/metalness/roughness）+ splatmap 引用 + 全局 PBR。
// 读取经 parseTerrainMaterialSettings 统一收敛（缺失/越界回退默认）。
// splatmap 的 RGBA 通道分别对应 layer0~3 的混合权重；若 splatmap 为空则回退
// 到地形内置的顶点色 splatmap（grass/rock/snow）。
// ---------------------------------------------------------------------------

/** 单个地形材质图层（splatmap 通道对应的纹理层） */
export interface TerrainMaterialLayer {
  /** Albedo（漫反射）纹理资产相对路径（空 = 使用纯色 color） */
  albedoMap: string;
  /** 法线纹理资产相对路径（空 = 无法线） */
  normalMap: string;
  /** 纹理平铺系数（UV 倍率） */
  tiling: number;
  /** 纯色着色（无 albedoMap 或与之相乘；RGB hex） */
  color: number;
  /** 金属度（0-1） */
  metalness: number;
  /** 粗糙度（0-1） */
  roughness: number;
}

/** 地形材质设置（.terrainmat 资产的形状；全部字段随资产序列化） */
export interface TerrainMaterialSettings {
  /** 激活图层数（1-4；对应 splatmap RGBA 通道） */
  layerCount: number;
  /** 图层数组（固定长度 4；layerCount 决定实际使用数） */
  layers: [TerrainMaterialLayer, TerrainMaterialLayer, TerrainMaterialLayer, TerrainMaterialLayer];
  /** Splatmap 纹理资产相对路径（空 = 使用地形内置顶点色 splatmap） */
  splatmap: string;
  /** 全局金属度乘子（0-1） */
  metalness: number;
  /** 全局粗糙度乘子（0-1） */
  roughness: number;
}

function defaultLayer(color: number, roughness: number): TerrainMaterialLayer {
  return {
    albedoMap: "",
    normalMap: "",
    tiling: 1,
    color,
    metalness: 0,
    roughness,
  };
}

export const DEFAULT_TERRAIN_MATERIAL_SETTINGS: TerrainMaterialSettings = {
  layerCount: 3,
  layers: [
    defaultLayer(0x6e7253, 0.95),
    defaultLayer(0x736a5f, 0.9),
    defaultLayer(0xe9ecf0, 0.8),
    defaultLayer(0x8a7d6e, 0.92),
  ],
  splatmap: "",
  metalness: 0,
  roughness: 0.95,
};

/** 各数值字段的取值域 */
export const TERRAIN_MATERIAL_LIMITS = {
  layerCount: { min: 1, max: 4 },
  tiling: { min: 0.1, max: 100 },
  metalness: { min: 0, max: 1 },
  roughness: { min: 0, max: 1 },
} as const;

function clampNum(v: unknown, lo: number, hi: number, fb: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fb;
  return Math.min(hi, Math.max(lo, n));
}

function clampInt(v: unknown, lo: number, hi: number, fb: number): number {
  return Math.round(clampNum(v, lo, hi, fb));
}

function clampHex(v: unknown, fb: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fb;
  return Math.min(0xffffff, Math.max(0, Math.round(n))) & 0xffffff;
}

function clampStr(v: unknown, fb: string): string {
  return typeof v === "string" ? v : fb;
}

function parseLayer(v: unknown, fb: TerrainMaterialLayer): TerrainMaterialLayer {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const L = TERRAIN_MATERIAL_LIMITS;
  return {
    albedoMap: clampStr(o.albedoMap, fb.albedoMap),
    normalMap: clampStr(o.normalMap, fb.normalMap),
    tiling: clampNum(o.tiling, L.tiling.min, L.tiling.max, fb.tiling),
    color: clampHex(o.color, fb.color),
    metalness: clampNum(o.metalness, L.metalness.min, L.metalness.max, fb.metalness),
    roughness: clampNum(o.roughness, L.roughness.min, L.roughness.max, fb.roughness),
  };
}

/**
 * 收敛地形材质设置（缺字段/越界/非法类型回退默认或钳进取值域）。
 * 资产 JSON 反序列化与检查器写入共用这一边界，保证取值域单一事实源。
 */
export function parseTerrainMaterialSettings(v: unknown): TerrainMaterialSettings {
  const d = DEFAULT_TERRAIN_MATERIAL_SETTINGS;
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const L = TERRAIN_MATERIAL_LIMITS;
  const rawLayers = Array.isArray(o.layers) ? o.layers : [];
  return {
    layerCount: clampInt(o.layerCount, L.layerCount.min, L.layerCount.max, d.layerCount),
    layers: [
      parseLayer(rawLayers[0], d.layers[0]),
      parseLayer(rawLayers[1], d.layers[1]),
      parseLayer(rawLayers[2], d.layers[2]),
      parseLayer(rawLayers[3], d.layers[3]),
    ],
    splatmap: clampStr(o.splatmap, d.splatmap),
    metalness: clampNum(o.metalness, L.metalness.min, L.metalness.max, d.metalness),
    roughness: clampNum(o.roughness, L.roughness.min, L.roughness.max, d.roughness),
  };
}

/** 深拷贝 */
export function cloneTerrainMaterialSettings(v: TerrainMaterialSettings): TerrainMaterialSettings {
  return {
    ...v,
    layers: v.layers.map((l) => ({ ...l })) as TerrainMaterialSettings["layers"],
  };
}

/** 地形材质资产扩展名 */
export const TERRAIN_MAT_EXT = ".terrainmat";

/** 是否地形材质资产相对路径（按扩展名判断） */
export function isTerrainMaterialAssetRel(rel: string): boolean {
  return rel.toLowerCase().endsWith(TERRAIN_MAT_EXT);
}