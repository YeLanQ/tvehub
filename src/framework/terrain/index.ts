// 地形域出口：设置类型/收敛 + 程序化生成（编辑器侧）
export {
  DEFAULT_TERRAIN_SETTINGS,
  TERRAIN_LIMITS,
  TERRAIN_EXT,
  cloneTerrainSettings,
  isTerrainAssetRel,
  parseTerrainSettings,
  terrainSettingsSig,
  type TerrainSettings,
} from "./types";
export { buildTerrain, sampleTerrainHeight, type TerrainBuild } from "./generate";
