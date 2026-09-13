// ---------------------------------------------------------------------------
// 地形数据类型（framework 层，不依赖 app/api）。
//
// 地形节点（TerrainNode.terrain）持有可 JSON 序列化的程序化地形设置：高度场
// 参数（seed/分形/侵蚀/形变）+ 表面配色。读取经 parseTerrainSettings 统一收敛
// （缺失/越界回退默认，旧场景兼容）；编辑器（framework/terrain/generate.ts）与
// 播放器（public/engine/runtime/terrain.mjs）按同一取值域生成同一片地形。
// 算法语义参考 three.js 示例 TerrainGenerator（derivative-damped 分形 +
// domain warp + 热侵蚀 + 菱形网格）。
// ---------------------------------------------------------------------------

/** 地形设置（TerrainNode.terrain 的形状；全部字段随场景序列化） */
export interface TerrainSettings {
  /** 随机种子：同种子必生成同一片地形（mulberry32 位移采样） */
  seed: number;
  /** 地表边长（世界单位，正方形补丁） */
  size: number;
  /** 每边网格数（顶点数 = (segments+1)²；越大越细腻也越重） */
  segments: number;
  /** 起伏幅度：谷底到峰顶的高度（世界单位） */
  heightScale: number;
  /** 基础噪声频率（一座山的占地尺度） */
  frequency: number;
  /** 分形叠加层数 */
  octaves: number;
  /** 每层频率步进（略偏离 2 避免网格锁相） */
  lacunarity: number;
  /** 每层振幅步进（持久度） */
  gain: number;
  /** 导数阻尼：越大谷越平、脊越锐（fake erosion） */
  erosion: number;
  /** 域扭曲强度：山脊/谷地蜿蜒程度 */
  warp: number;
  /** 谷地压平幂次（>1 压低低谷成平地） */
  valleyBias: number;
  /** 海平面：高度计算前减去的比例（谷底下沉到 y<0） */
  seaLevel: number;
  /** 热侵蚀休止角（rise/run；越小塌得越平） */
  talus: number;
  /** 热侵蚀迭代次数（0 = 关闭） */
  talusPasses: number;
  /** 草地色（低平处基色，RGB hex） */
  grassColor: number;
  /** 岩石色（陡坡/高海拔，RGB hex） */
  rockColor: number;
  /** 积雪色（高平处，RGB hex） */
  snowColor: number;
}

export const DEFAULT_TERRAIN_SETTINGS: TerrainSettings = {
  seed: 1,
  size: 200,
  segments: 192,
  heightScale: 65,
  frequency: 0.01,
  octaves: 5,
  lacunarity: 1.97,
  gain: 0.5,
  erosion: 0.7,
  warp: 0.35,
  valleyBias: 1.2,
  seaLevel: 0.15,
  talus: 1,
  talusPasses: 12,
  grassColor: 0x6e7253,
  rockColor: 0x736a5f,
  snowColor: 0xe9ecf0,
};

/** 各数值字段的取值域（检查器钳制 / parse 收敛 / 运行时镜像共用同一份边界） */
export const TERRAIN_LIMITS = {
  seed: { min: 1, max: 999999 },
  size: { min: 10, max: 2000 },
  segments: { min: 16, max: 256 },
  heightScale: { min: 0, max: 500 },
  frequency: { min: 0.0005, max: 0.05 },
  octaves: { min: 1, max: 8 },
  lacunarity: { min: 1, max: 4 },
  gain: { min: 0.1, max: 0.9 },
  erosion: { min: 0, max: 2 },
  warp: { min: 0, max: 1.5 },
  valleyBias: { min: 0.5, max: 3 },
  seaLevel: { min: -0.5, max: 0.8 },
  talus: { min: 0.2, max: 2 },
  talusPasses: { min: 0, max: 40 },
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

/**
 * 收敛地形设置（缺字段/越界/非法类型回退默认或钳进取值域）。
 * 场景 JSON 反序列化与检查器写入共用这一边界，保证取值域单一事实源。
 */
export function parseTerrainSettings(v: unknown): TerrainSettings {
  const d = DEFAULT_TERRAIN_SETTINGS;
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const L = TERRAIN_LIMITS;
  return {
    seed: clampInt(o.seed, L.seed.min, L.seed.max, d.seed),
    size: clampNum(o.size, L.size.min, L.size.max, d.size),
    segments: clampInt(o.segments, L.segments.min, L.segments.max, d.segments),
    heightScale: clampNum(o.heightScale, L.heightScale.min, L.heightScale.max, d.heightScale),
    frequency: clampNum(o.frequency, L.frequency.min, L.frequency.max, d.frequency),
    octaves: clampInt(o.octaves, L.octaves.min, L.octaves.max, d.octaves),
    lacunarity: clampNum(o.lacunarity, L.lacunarity.min, L.lacunarity.max, d.lacunarity),
    gain: clampNum(o.gain, L.gain.min, L.gain.max, d.gain),
    erosion: clampNum(o.erosion, L.erosion.min, L.erosion.max, d.erosion),
    warp: clampNum(o.warp, L.warp.min, L.warp.max, d.warp),
    valleyBias: clampNum(o.valleyBias, L.valleyBias.min, L.valleyBias.max, d.valleyBias),
    seaLevel: clampNum(o.seaLevel, L.seaLevel.min, L.seaLevel.max, d.seaLevel),
    talus: clampNum(o.talus, L.talus.min, L.talus.max, d.talus),
    talusPasses: clampInt(o.talusPasses, L.talusPasses.min, L.talusPasses.max, d.talusPasses),
    grassColor: clampHex(o.grassColor, d.grassColor),
    rockColor: clampHex(o.rockColor, d.rockColor),
    snowColor: clampHex(o.snowColor, d.snowColor),
  };
}

/** 深拷贝（节点克隆/整节点快照用） */
export function cloneTerrainSettings(v: TerrainSettings): TerrainSettings {
  return { ...v };
}

/** 地形资产扩展名（kind = 扩展名，与 scan_assets 规则一致） */
export const TERRAIN_EXT = ".terrain";

/** 是否地形资产相对路径（按扩展名判断） */
export function isTerrainAssetRel(rel: string): boolean {
  return rel.toLowerCase().endsWith(TERRAIN_EXT);
}

/**
 * 重建签名（设置 → 字符串）：同步器据此判断是否需要重建几何。
 * 全字段参与：任何设置变化都换一批顶点/颜色。
 */
export function terrainSettingsSig(s: TerrainSettings): string {
  return [
    s.seed, s.size, s.segments, s.heightScale, s.frequency, s.octaves,
    s.lacunarity, s.gain, s.erosion, s.warp, s.valleyBias, s.seaLevel,
    s.talus, s.talusPasses, s.grassColor, s.rockColor, s.snowColor,
  ].join("|");
}
