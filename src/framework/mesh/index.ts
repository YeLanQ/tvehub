export {
  MODEL_EXTS,
  isModelAssetRel,
  isGltfAssetRel,
  modelDirOf,
  modelExtOf,
  modelFileName,
  modelFileStem,
  parseModelMaterialOverrides,
  cloneModelMaterialOverrides,
  collectModelMaterialOverrideRels,
} from "./types";
export type { MeshSourceKind, ModelExt, ModelMeta, ModelMaterialInfo } from "./types";
export {
  GeometryRegistry,
  buildGeometry,
  createDefaultGeometryRegistry,
  geometryRegistry,
} from "./geometry";
export type { GeometryKind, GeometryProvider } from "./geometry";
export {
  ModelLoaderRegistry,
  createDefaultModelLoaderRegistry,
  modelLoaderRegistry,
} from "./loaders";
export type { ModelLoadContext, ModelLoaderDef, LoadedModelData } from "./loaders";
export { ModelManager } from "./ModelManager";
export type { ModelFileAccess, ModelChangeListener } from "./ModelManager";
export {
  setupCompressedGltfSupport,
  probeDecoderAssets,
  compressedGltfSupport,
} from "./compressed-gltf";
export type { CompressedGltfSetup, CompressedGltfSupport } from "./compressed-gltf";
