// ---------------------------------------------------------------------------
// 天空盒材质（.mat 中 shader=SkyBox/SkyProcedural 的特殊材质）文档读写：
// - procedural：三段配色（顶/地平线/下方地面）；
// - cube：TextureCube 引用（cubeMap）+ 旋转/强度/世界不透明度/模糊。
// material_read/paramsFor 不携带天空字段，资产检查器对这类资产走文本直读 →
// 局部解析 → 整卡写回（保留全部原始字段，仅更新已知键）。
// 内置（internal/…）只读；写回仅限项目内资产。
// ---------------------------------------------------------------------------

import { api } from "../../lib/api";
import { isInternalAsset } from "../../lib/internal-assets";

export type SkyMatKind = "cube" | "procedural";

export interface SkyMatDoc {
  kind: SkyMatKind;
  // —— cube：TextureCube + 渲染参数 ——
  /** TextureCube（.texcube）资产引用 */
  cubeMap: string;
  /** 天空旋转（度，绕世界 Y 轴） */
  rotation: number;
  /** 强度（背景亮度倍率） */
  strength: number;
  /** 世界不透明度（保留字段） */
  worldOpacity: number;
  /** 模糊（0~1） */
  blur: number;
  // —— procedural：Blender 天空纹理风格参数 ——
  sunDisc: boolean;
  sunSize: number;
  sunStrength: number;
  sunElevation: number;
  sunRotation: number;
  altitude: number;
  air: number;
  dust: number;
  ozone: number;
  ms: boolean;
  /** 完整原始 JSON（写回时以它为底，保留未知字段） */
  raw: Record<string, unknown>;
}

function parseStr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function parseNum(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function parseBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** 解析天空材质文本；非天空材质（普通 material/非 JSON）返回 null */
export function parseSkyMatDoc(text: string): SkyMatDoc | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (!obj || obj.$type !== "material") return null;
    const shader = typeof obj.shader === "string" ? obj.shader : "";
    const kind = typeof obj.kind === "string" ? obj.kind : "";
    if (!["cube", "procedural"].includes(kind) && shader !== "SkyBox" && shader !== "SkyProcedural") {
      return null;
    }
    const docKind: SkyMatKind =
      kind === "procedural" || shader === "SkyProcedural" ? "procedural" : "cube";
    return {
      kind: docKind,
      cubeMap: parseStr(obj.cubeMap, "internal/skybox/DefaultSkybox.texcube"),
      rotation: parseNum(obj.rotation, 0),
      strength: parseNum(obj.strength, 1),
      worldOpacity: parseNum(obj.worldOpacity, 0),
      blur: parseNum(obj.blur, 0),
      sunDisc: parseBool(obj.sunDisc, true),
      sunSize: parseNum(obj.sunSize, 1),
      sunStrength: parseNum(obj.sunStrength, 1),
      sunElevation: parseNum(obj.sunElevation, 25),
      sunRotation: parseNum(obj.sunRotation, 0),
      altitude: parseNum(obj.altitude, 0),
      air: parseNum(obj.air, 1),
      dust: parseNum(obj.dust, 1),
      ozone: parseNum(obj.ozone, 1),
      ms: parseBool(obj.ms, true),
      raw: obj,
    };
  } catch {
    return null;
  }
}

/** 读取天空材质文档（internal/项目都走只读文本；失败/非天空材质返回 null） */
export async function loadSkyMatDoc(root: string | null, rel: string): Promise<SkyMatDoc | null> {
  try {
    const text = isInternalAsset(rel)
      ? await api.readInternalAsset(rel)
      : root
        ? await api.readText(root, rel)
        : null;
    return text ? parseSkyMatDoc(text) : null;
  } catch {
    return null;
  }
}

/** 写回天空材质（项目资产；保留原始字段，仅更新已知键） */
export async function saveSkyMatDoc(root: string, rel: string, doc: SkyMatDoc): Promise<void> {
  doc.raw.kind = doc.kind;
  doc.raw.shader = doc.kind === "procedural" ? "SkyProcedural" : "SkyBox";
  doc.raw.cubeMap = doc.cubeMap;
  doc.raw.rotation = doc.rotation;
  doc.raw.strength = doc.strength;
  doc.raw.worldOpacity = doc.worldOpacity;
  doc.raw.blur = doc.blur;
  doc.raw.sunDisc = doc.sunDisc;
  doc.raw.sunSize = doc.sunSize;
  doc.raw.sunStrength = doc.sunStrength;
  doc.raw.sunElevation = doc.sunElevation;
  doc.raw.sunRotation = doc.sunRotation;
  doc.raw.altitude = doc.altitude;
  doc.raw.air = doc.air;
  doc.raw.dust = doc.dust;
  doc.raw.ozone = doc.ozone;
  doc.raw.ms = doc.ms;
  await api.writeText(root, rel, JSON.stringify(doc.raw, null, 2) + "\n");
}
