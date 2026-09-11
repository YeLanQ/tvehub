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
  DEFAULT_SHADER_REL,
  DEFAULT_SHADER_RELS,
  INTERNAL_SHADER_ROOT,
  SHADER_EXT,
  SHADER_HOOKS_BY_KIND,
  SHADER_KINDS,
  SHADER_KIND_STEMS,
  insertBaseDeclaration,
  normalizeShaderKind,
  shaderFileStem,
  shaderKindLabel,
  skyKindOfShaderRef,
} from "./shader";
export type {
  ShaderDoc,
  ShaderHook,
  ShaderKind,
  ShaderPropertyDef,
  ShaderPropertyKind,
  SkyMaterialKind,
} from "./shader";
export {
  SHADER_PARAM_GROUP_TITLE,
  applyShaderHooks,
  hasShaderHooks,
  hookDataOf,
  hookMaterialCount,
  shaderParamGroups,
  shaderPropDefaults,
  tickAllHookTime,
  tickHookTime,
} from "./shaderHooks";
export type {
  ShaderHookData,
  ShaderProps,
  ShaderTextureLoader,
} from "./shaderHooks";
export {
  getNodeMaterialBackend,
  loadNodeMaterialBackend,
  nodeHookMaterialCount,
  setNodeMaterialBackend,
  tickAllNodeHookTime,
} from "./nodeMaterialBackend";
export type { NodeMaterialBackend } from "./nodeMaterialBackend";
