export {
  DEFAULT_MATERIAL_PARAMS,
  DEFAULT_MATERIAL_REL,
  INTERNAL_MATERIAL_ROOT,
  MATERIAL_EXT,
  cloneMaterialParams,
  colorToHexString,
  isInternalMaterialRel,
  materialFileName,
  materialFileStem,
  materialParamsFrom,
  parseColorHex,
} from "./types";
export type { MaterialParams, MaterialParamKey } from "./types";
export { defaultMaterialDoc, parseMaterialFile, serializeMaterialFile } from "./materialFile";
export type { MaterialDoc } from "./materialFile";
export { MaterialManager } from "./MaterialManager";
export type { MaterialChangeListener, MaterialTextFetcher } from "./MaterialManager";
export { collectMeshMaterialRefs } from "./collect";
