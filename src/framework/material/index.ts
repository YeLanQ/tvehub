export {
  DEFAULT_MATERIAL_PARAMS,
  DEFAULT_MATERIAL_REL,
  INTERNAL_MATERIAL_ROOT,
  MATERIAL_EXT,
  clampMaterialParam,
  cloneMaterialParams,
  colorToHexString,
  isInternalMaterialRel,
  isMaterialEnableKey,
  materialFileName,
  materialFileStem,
  materialParamMax,
  materialParamsFrom,
  isTextureParamKey,
  parseColorHex,
} from "./types";
export type { MaterialParams, MaterialParamKey, TextureParamKey, MaterialEnableKey } from "./types";
export { MATERIAL_PARAM_GROUPS, materialParamDef } from "./defs";
export type { MaterialParamDef, MaterialParamGroup, MaterialParamKind } from "./defs";
export { defaultMaterialDoc, parseMaterialFile, serializeMaterialFile } from "./materialFile";
export type { MaterialDoc } from "./materialFile";
export { MaterialManager } from "./MaterialManager";
export type { MaterialChangeListener, MaterialTextFetcher } from "./MaterialManager";
export {
  DEFAULT_MATERIAL_TYPE,
  MaterialTypeRegistry,
  attachTextureChannel,
  createDefaultMaterialTypeRegistry,
  materialTypeRegistry,
} from "./factory";
export type { MaterialTypeDef, MaterialTextureLoader } from "./factory";
export { collectMeshMaterialRefs } from "./collect";
