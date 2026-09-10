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
  materialPropsFrom,
  isTextureParamKey,
  parseColorHex,
} from "./types";
export type {
  MaterialParams,
  MaterialParamKey,
  MaterialPropValue,
  TextureParamKey,
  MaterialEnableKey,
} from "./types";
export { MATERIAL_PARAM_GROUPS, materialParamDef } from "./defs";
export type { MaterialParamDef, MaterialParamGroup, MaterialParamKind } from "./defs";
export { MaterialManager } from "./MaterialManager";
export type { MaterialChangeListener, MaterialDoc, MaterialDocFetcher } from "./MaterialManager";
export { ShaderManager } from "./ShaderManager";
export type { ShaderChangeListener, ShaderDocFetcher } from "./ShaderManager";
export {
  DEFAULT_MATERIAL_TYPE,
  MaterialTypeRegistry,
  attachTextureChannel,
  createDefaultMaterialTypeRegistry,
  materialTypeRegistry,
} from "./factory";
export type {
  MaterialApplyContext,
  MaterialTypeDef,
  MaterialTextureLoader,
  OutlineConfig,
} from "./factory";
export {
  CUSTOM_SHADER_KIND,
  DEFAULT_SHADER_REL,
  DEFAULT_SHADER_RELS,
  INTERNAL_SHADER_ROOT,
  SHADER_EXT,
  SHADER_KINDS,
  SHADER_KIND_STEMS,
  normalizeShaderKind,
  shaderFileStem,
  shaderKindLabel,
  skyKindOfShaderRef,
} from "./shader";
export type {
  CustomShaderProgram,
  CustomShaderState,
  ShaderDoc,
  ShaderKind,
  ShaderPropertyDef,
  ShaderPropertyKind,
  SkyMaterialKind,
} from "./shader";
export {
  CUSTOM_PARAM_GROUP_TITLE,
  TIME_UNIFORM,
  applyCustomProgram,
  applyCustomTextures,
  buildCustomUniforms,
  customMaterialCount,
  customParamGroups,
  customPropColorString,
  customPropDefaults,
  customPropValue,
  registerCustomMaterial,
  tickShaderTime,
} from "./customShader";
