export {
  DEFAULT_FOG_SETTINGS,
  FOG_KINDS,
  FOG_LIMITS,
  cloneFogSettings,
  fogKindLabel,
  fogSettingsSig,
  parseFogSettings,
  type FogKind,
  type FogSettings,
} from "./types";
export {
  applyHeightFogWebGPU,
  clearHeightFogWebGPU,
  ensureHeightFogChunk,
  setHeightFogParams,
  setHeightFogStrength,
} from "./heightFog";
