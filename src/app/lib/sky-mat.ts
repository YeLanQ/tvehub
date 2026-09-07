// ---------------------------------------------------------------------------
// 天空盒材质（.mat 中 shader=SkyBox/SkyProcedural 的特殊材质）文档读写：
// material_read/paramsFor 不携带天空字段（kind/三色），资产检查器对这类资产
// 走文本直读 → 局部解析 → 整卡写回（保留全部原始字段，仅更新已知键）。
// 内置（internal/…）只读；写回仅限项目内资产。
// ---------------------------------------------------------------------------

import { api } from "../../lib/api";
import { isInternalAsset } from "../../lib/internal-assets";

export interface SkyMatDoc {
  kind: "cube" | "procedural";
  topColor: number;
  horizonColor: number;
  groundColor: number;
  /** 完整原始 JSON（写回时以它为底，保留未知字段） */
  raw: Record<string, unknown>;
}

const SKY_KINDS = new Set(["cube", "procedural"]);

function hex6(c: number): string {
  return "#" + (c & 0xffffff).toString(16).padStart(6, "0");
}

function parseHex(v: unknown, fallback: number): number {
  if (typeof v !== "string") return fallback;
  const n = parseInt(v.replace("#", ""), 16);
  return Number.isNaN(n) ? fallback : n & 0xffffff;
}

/** 解析天空材质文本；非天空材质（普通 material/非 JSON）返回 null */
export function parseSkyMatDoc(text: string): SkyMatDoc | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (!obj || obj.$type !== "material") return null;
    const shader = typeof obj.shader === "string" ? obj.shader : "";
    const kind = typeof obj.kind === "string" ? obj.kind : "";
    if (!SKY_KINDS.has(kind) && shader !== "SkyBox" && shader !== "SkyProcedural") return null;
    const safeKind = kind === "procedural" || shader === "SkyProcedural" ? "procedural" : "cube";
    return {
      kind: safeKind,
      topColor: parseHex(obj.topColor, 0x2f6fbb),
      horizonColor: parseHex(obj.horizonColor, 0xcfe4f7),
      groundColor: parseHex(obj.groundColor, 0x8fa2b5),
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

/** 写回天空材质（项目资产；保留原始字段，仅更新 kind/三色） */
export async function saveSkyMatDoc(root: string, rel: string, doc: SkyMatDoc): Promise<void> {
  doc.raw.kind = doc.kind;
  doc.raw.shader = doc.kind === "procedural" ? "SkyProcedural" : "SkyBox";
  doc.raw.topColor = hex6(doc.topColor);
  doc.raw.horizonColor = hex6(doc.horizonColor);
  doc.raw.groundColor = hex6(doc.groundColor);
  await api.writeText(root, rel, JSON.stringify(doc.raw, null, 2) + "\n");
}
