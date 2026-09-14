// ---------------------------------------------------------------------------
// model-extract —— 模型内嵌材质 → 编辑器材质资产（.mat）提取管线。
//
// - extractMaterialDocs 是 IO 无关的管线核心（@gltf-transform Document → 材质
//   参数 + 贴图字节；冒烟测试在 Node 侧直接喂 Document 复跑）：
//   PBR 因子按 glTF 线性色 → sRGB hex 换算，金属度/粗糙度共享的
//   metallicRoughness 贴图同时填 metalnessMap 与 roughnessMap（three 与 glTF
//   通道约定一致：金属度在 B 通道、粗糙度在 G 通道），贴图只保留原始
//   png/jpeg 字节（ktx2 等编辑器纹理加载器不认的格式跳过）；
// - extractModelMaterials 是编辑器 UI 入口：读资产（glb 内存字节 / gltf 经
//   asset:// URL 连同外部资源）→ 提取 → 贴图写 assets/textures、材质写
//   assets/materials（重名自动去重）→ 返回「内嵌材质名 → .mat rel」映射，
//   供节点覆盖表（MeshNode.modelMaterialOverrides）直接回填。
// ---------------------------------------------------------------------------

import type { Document, Texture } from "@gltf-transform/core";
import { assetUrl, fetchAssetBinary } from "../../lib/asset-url";
import { api } from "../../lib/api";
import { DEFAULT_MATERIAL_PARAMS, DEFAULT_SHADER_REL, type MaterialParams } from "../../framework/material";
import { bytesToBase64, createBrowserModelIO } from "./model-draco";

/** .mat 支持的贴图通道键（MaterialParams 的贴图字段子集） */
type TextureKey = "map" | "metalnessMap" | "roughnessMap" | "normalMap" | "emissiveMap";

/** 提取出的贴图（原始图片字节 + 扩展名；ktx2 等不受支持格式在提取时已过滤） */
export interface ExtractedImage {
  bytes: Uint8Array;
  ext: "png" | "jpg";
}

/** 提取出的单个材质：参数（贴图字段留空）+ 通道 → 贴图字节 */
export interface ExtractedMaterialDoc {
  /** 内嵌材质名（空名按出现顺序补 Material N） */
  name: string;
  params: MaterialParams;
  images: Partial<Record<TextureKey, ExtractedImage>>;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
}

/** glTF 线性因子 → sRGB hex（编辑器材质色空间约定） */
function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

function factorToHex(rgb: readonly number[]): number {
  return (linearToSrgb(rgb[0] ?? 0) << 16) | (linearToSrgb(rgb[1] ?? 0) << 8) | linearToSrgb(rgb[2] ?? 0);
}

const MIME_EXT: Record<string, "png" | "jpg"> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};

/** 同一 Texture 对象（多材质/多通道共享）只提取一份字节 */
function textureImage(cache: Map<Texture, ExtractedImage | null>, tex: Texture): ExtractedImage | null {
  if (cache.has(tex)) return cache.get(tex)!;
  const mime = tex.getMimeType();
  const ext = MIME_EXT[mime] ?? null;
  const bytes = tex.getImage() ?? null;
  const out = ext && bytes ? { bytes, ext } : null;
  cache.set(tex, out);
  return out;
}

/**
 * 管线核心：Document → 提取材质清单（IO 无关，可复用已挂扩展的任何 IO 读出的文档）。
 * PBR 因子换算见文件头；清漆/光泽/透射等扩展因子暂取默认值（编辑器材质面板可再调）。
 */
export function extractMaterialDocs(doc: Document): ExtractedMaterialDoc[] {
  const out: ExtractedMaterialDoc[] = [];
  const imageCache = new Map<Texture, ExtractedImage | null>();
  const mats = doc.getRoot().listMaterials();
  mats.forEach((mat, i) => {
    const name = mat.getName() || `Material ${i + 1}`;
    const baseColor = mat.getBaseColorFactor();
    const alphaMode = mat.getAlphaMode();
    const emissive = mat.getEmissiveFactor();
    const params: MaterialParams = {
      ...DEFAULT_MATERIAL_PARAMS,
      color: factorToHex(baseColor),
      metalness: clamp01(mat.getMetallicFactor()),
      roughness: clamp01(mat.getRoughnessFactor()),
      opacity: alphaMode === "BLEND" ? clamp01(baseColor[3] ?? 1) : 1,
      alphaClipThreshold: alphaMode === "MASK" ? clamp01(mat.getAlphaCutoff()) : 0,
      emissive: factorToHex(emissive),
      emissionEnabled: Array.isArray(emissive) && emissive.some((c) => c > 0),
      props: {},
    };

    const images: Partial<Record<TextureKey, ExtractedImage>> = {};
    const push = (key: TextureKey, tex: Texture | null): void => {
      if (!tex) return;
      const img = textureImage(imageCache, tex);
      if (img) images[key] = img;
    };
    push("map", mat.getBaseColorTexture());
    // glTF 的 metallicRoughness 贴图：G=粗糙度 B=金属度（three 通道约定一致，
    // 同一张图同时挂 metalnessMap 与 roughnessMap）
    push("metalnessMap", mat.getMetallicRoughnessTexture());
    push("roughnessMap", mat.getMetallicRoughnessTexture());
    push("normalMap", mat.getNormalTexture());
    push("emissiveMap", mat.getEmissiveTexture());
    out.push({ name, params, images });
  });
  return out;
}

/** 提取结果：覆盖映射 + 写盘统计（UI 日志展示） */
export interface ModelMaterialExtractResult {
  /** 内嵌材质名 → .mat 资产 rel（MeshNode.modelMaterialOverrides 的形状） */
  overrides: Record<string, string>;
  textures: number;
  materials: number;
}

function sanitizeFileSeg(v: string): string {
  const clean = v.replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, "_").trim();
  return clean || "mat";
}

/**
 * 编辑器 UI 入口：读取模型资产 → 提取材质 → 写贴图与 .mat 资产 → 返回覆盖映射。
 * - 仅 glTF/GLB 支持（fbx/obj 无 glTF 文档可解析，抛错由调用方提示）；
 * - 贴图 → assets/textures/<模型>_<材质>_<通道>.<png|jpg>；
 *   材质 → assets/materials/<模型>_<材质>.mat（重名自动加序号）；
 * - usedRels：现有资产 rel 小写集合（去重判断用；本函数会把新 rel 并入）。
 */
export async function extractAndWriteModelMaterials(
  root: string,
  modelRel: string,
  usedRels: Set<string>,
): Promise<ModelMaterialExtractResult> {
  const dot = modelRel.lastIndexOf(".");
  const ext = dot >= 0 ? modelRel.slice(dot + 1).toLowerCase() : "";
  if (ext !== "glb" && ext !== "gltf") {
    throw new Error(`仅 glTF/GLB 模型支持材质提取: ${modelRel}`);
  }
  const io = await createBrowserModelIO(ext === "gltf" ? `${assetUrl(modelDirOf(modelRel))}/` : undefined);
  const doc =
    ext === "glb"
      ? await io.readBinary(new Uint8Array((await fetchAssetBinary(modelRel)) ?? new ArrayBuffer(0)))
      : await io.read(assetUrl(modelRel));
  const extracted = extractMaterialDocs(doc);

  const stem = sanitizeFileSeg(
    modelRel.slice((modelRel.lastIndexOf("/") + 1) || 0, modelRel.lastIndexOf(".")) || "Model",
  );
  const used = (rel: string): boolean => usedRels.has(rel.toLowerCase());
  const uniqueRel = (base: string, suffix: string): string => {
    let name = base;
    let n = 2;
    while (used(`${name}${suffix}`)) name = `${base} ${n++}`;
    return `${name}${suffix}`;
  };
  const dir = (d: string): string => (d ? `${d}/` : "");

  const overrides: Record<string, string> = {};
  const nameCount = new Map<string, number>();
  const writtenTextures = new Map<ExtractedImage, string>();
  let textureCount = 0;

  for (const mat of extracted) {
    // 同名材质去重（材质名 → Mat、Mat → Mat 2）
    const count = (nameCount.get(mat.name) ?? 0) + 1;
    nameCount.set(mat.name, count);
    const matName = count === 1 ? mat.name : `${mat.name} ${count}`;
    const seg = sanitizeFileSeg(matName);

    // 贴图落盘（同一贴图字节跨材质/通道共享一个 rel）
    const params: MaterialParams = { ...mat.params };
    for (const [key, img] of Object.entries(mat.images) as [TextureKey, ExtractedImage][]) {
      let rel = writtenTextures.get(img);
      if (!rel) {
        rel = uniqueRel(`${dir("assets/textures")}${stem}_${seg}_${key}`, `.${img.ext}`);
        usedRels.add(rel.toLowerCase());
        await api.writeAssetBinary(root, rel, bytesToBase64(img.bytes));
        writtenTextures.set(img, rel);
        textureCount++;
      }
      params[key] = rel;
    }

    const matRel = uniqueRel(`${dir("assets/materials")}${stem}_${seg}`, ".mat");
    usedRels.add(matRel.toLowerCase());
    await api.materialWrite(root, matRel, `${stem}_${seg}`, DEFAULT_SHADER_REL, params as unknown as Record<string, unknown>);
    overrides[mat.name] = matRel;
  }

  return { overrides, textures: textureCount, materials: extracted.length };
}

/** 模型资产相对路径 → 所在目录（同 framework/mesh 的 modelDirOf；本地复用避免再引依赖） */
function modelDirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i > 0 ? rel.slice(0, i) : "";
}
