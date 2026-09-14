// ---------------------------------------------------------------------------
// Mesh 系统基础类型（framework 层，不依赖 app/api）。
//
// MeshNode 的网格来源分两类（MeshSourceKind）：
// - primitive：内置基元几何（box/sphere/…，几何工厂 geometryRegistry 按类型构建）；
// - model：模型资产引用（.glb/.gltf/.fbx/.obj，加载器工厂 modelLoaderRegistry
//   按扩展名解析，ModelManager 负责读取/缓存/实例化）。
// ---------------------------------------------------------------------------

/** 网格来源：内置基元 / 模型资产 */
export type MeshSourceKind = "primitive" | "model";

/** 支持的模型资产扩展名（小写、不带点；与加载器工厂注册表对应） */
export const MODEL_EXTS = ["glb", "gltf", "fbx", "obj"] as const;

/** 模型资产扩展名 */
export type ModelExt = (typeof MODEL_EXTS)[number];

/** 相对路径 → 模型扩展名（非模型资产返回 null） */
export function modelExtOf(rel: string): ModelExt | null {
  const dot = rel.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = rel.slice(dot + 1).toLowerCase();
  return (MODEL_EXTS as readonly string[]).includes(ext) ? (ext as ModelExt) : null;
}

/** 资产引用是否为模型资产（按扩展名判断；目录 kind 同名） */
export function isModelAssetRel(rel: string): boolean {
  return modelExtOf(rel) != null;
}

/** 资产引用是否为 glTF/GLB（Draco 压缩等仅对 glTF 系开放的入口用） */
export function isGltfAssetRel(rel: string): boolean {
  const ext = modelExtOf(rel);
  return ext === "glb" || ext === "gltf";
}

/** 模型资产相对路径 → 文件名（含扩展名） */
export function modelFileName(rel: string): string {
  const segs = rel.split("/");
  return segs[segs.length - 1] ?? rel;
}

/** 模型资产相对路径 → 文件名（去掉扩展名） */
export function modelFileStem(rel: string): string {
  const name = modelFileName(rel);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/** 模型资产相对路径 → 所在目录（"assets/models/a.glb" → "assets/models"；根返回 ""） */
export function modelDirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i > 0 ? rel.slice(0, i) : "";
}

/** 模型内嵌材质摘要（只读展示：名称 + three 材质类型标签） */
export interface ModelMaterialInfo {
  name: string;
  type: string;
}

/** 已解析模型的可描述信息（UI 展示：剪辑列表 / 是否含骨骼动画 / 内嵌材质清单） */
export interface ModelMeta {
  clips: string[];
  hasSkeleton: boolean;
  materials: ModelMaterialInfo[];
}

/**
 * 模型内嵌材质覆盖表（MeshNode.modelMaterialOverrides 的形状；随场景序列化）：
 * 键 = 内嵌材质名（three 材质 name，即 glTF 材质名），值 = 编辑器材质资产 rel；
 * 未覆盖的材质名（或缺表）用模型内嵌材质。
 */
export function parseModelMaterialOverrides(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k && typeof val === "string" && val) out[k] = val;
  }
  return out;
}

/** 深拷贝覆盖表（节点克隆/整节点快照用） */
export function cloneModelMaterialOverrides(v: Record<string, string>): Record<string, string> {
  return { ...v };
}

/**
 * 从场景 JSON（任意嵌套）收集模型材质覆盖引用的 .mat rel 列表：
 * 项目装载预取用（覆盖材质随节点入图即按正确外观渲染，与 materialRefs 同批预取）。
 */
export function collectModelMaterialOverrideRels(root: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.type === "meshNode" && o.modelMaterialOverrides && typeof o.modelMaterialOverrides === "object") {
      for (const rel of Object.values(o.modelMaterialOverrides as Record<string, unknown>)) {
        if (typeof rel === "string" && rel) out.add(rel);
      }
    }
    for (const val of Object.values(o)) walk(val);
  };
  walk(root);
  return [...out];
}
