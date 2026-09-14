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
export { buildTerrain, bakeTerrainHeights, sampleTerrainHeight, splitTerrainGeometry, bakeColorTexture, type TerrainBuild, type SplatmapData } from "./generate";
export {
  stampSplat,
  stampSplatLine,
  worldToSplatPixel,
  splatPixelToWorld,
  type SplatBuffer,
  type SplatBrush,
} from "./paint";
export {
  parseTerrainSculpt,
  encodeSculptData,
  decodeSculptData,
  stampSculpt,
  stampSculptLine,
  type TerrainSculptData,
  type SculptMode,
  type SculptBrush,
} from "./sculpt";
export {
  DEFAULT_TERRAIN_MATERIAL_SETTINGS,
  TERRAIN_MATERIAL_LIMITS,
  TERRAIN_MAT_EXT,
  cloneTerrainMaterialSettings,
  isTerrainMaterialAssetRel,
  parseTerrainMaterialSettings,
  type TerrainMaterialLayer,
  type TerrainMaterialSettings,
} from "./terrainMaterialTypes";
