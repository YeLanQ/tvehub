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
export { MaterialManager } from "./MaterialManager";
export type { MaterialChangeListener, MaterialDoc, MaterialDocFetcher } from "./MaterialManager";
export {
  DEFAULT_MATERIAL_TYPE,
  MaterialTypeRegistry,
  attachTextureChannel,
  createDefaultMaterialTypeRegistry,
  materialTypeRegistry,
} from "./factory";
export type { MaterialTypeDef, MaterialTextureLoader, OutlineConfig } from "./factory";
export {
  DEFAULT_SHADER_REL,
  DEFAULT_SHADER_RELS,
  INTERNAL_SHADER_ROOT,
  SHADER_EXT,
  SHADER_KINDS,
  SHADER_KIND_STEMS,
  normalizeShaderKind,
  shaderFileStem,
  shaderKindLabel,
} from "./shader";
export type { ShaderDoc, ShaderKind } from "./shader";
