// ---------------------------------------------------------------------------
// TextureCube 资产操作（应用层薄封装）：.texcube 格式所有权在 Rust（序列化 +
// 落盘 + .meta），本文件只做类型桥接、文档读写与默认值。
// ---------------------------------------------------------------------------

import { api } from "../../lib/api";
import { isInternalAsset } from "../../lib/internal-assets";
import type { TexCubeDoc } from "../../framework/engine/modules/skyboxTextures";

/** 六面键（与引擎 TexCubeDoc 一致） */
export type TexCubeFaceKey = "px" | "nx" | "py" | "ny" | "pz" | "nz";
export const TEXCUBE_FACE_KEYS: TexCubeFaceKey[] = ["px", "nx", "py", "ny", "pz", "nz"];

/** 面键中文标签（检查器六面下拉用） */
export const TEXCUBE_FACE_LABELS: Record<TexCubeFaceKey, string> = {
  px: "+X 右",
  nx: "-X 左",
  py: "+Y 上",
  ny: "-Y 下",
  pz: "+Z 前",
  nz: "-Z 后",
};

/** 内置默认全景图（新建 TextureCube 的初始贴图，立即可用） */
export const DEFAULT_TEXCUBE_MAP = "internal/skybox/default_skybox.png";

/** 解析后的 TextureCube 文档 */
export interface TexCubeAssetDoc {
  name: string;
  source: "equirect" | "faces";
  map: string;
  faces: Partial<Record<TexCubeFaceKey, string>>;
}

/** 兼容宽松解析（未知 source 归一 equirect；字段缺失回默认） */
function normalizeDoc(raw: TexCubeDoc & { name?: string }): TexCubeAssetDoc {
  const faces: Partial<Record<TexCubeFaceKey, string>> = {};
  for (const k of TEXCUBE_FACE_KEYS) {
    const v = raw.faces?.[k];
    if (typeof v === "string" && v) faces[k] = v;
  }
  return {
    name: typeof raw.name === "string" ? raw.name : "TextureCube",
    source: raw.source === "faces" ? "faces" : "equirect",
    map: typeof raw.map === "string" ? raw.map : "",
    faces,
  };
}

/** 按引用读取并解析 .texcube 文档（internal/项目都走只读文本；失败返回 null） */
export async function loadTexCubeDoc(root: string | null, rel: string): Promise<TexCubeAssetDoc | null> {
  try {
    const text = isInternalAsset(rel)
      ? await api.readInternalAsset(rel)
      : root
        ? await api.readText(root, rel)
        : null;
    if (!text) return null;
    return normalizeDoc(JSON.parse(text) as TexCubeDoc & { name?: string });
  } catch {
    return null;
  }
}

/** 写入 .texcube 资产（后端序列化 + 落盘 + 补 .meta）；失败抛错由调用方处理 */
export async function saveTexCubeDoc(root: string, rel: string, doc: TexCubeAssetDoc): Promise<void> {
  await api.texcubeWrite(
    root,
    rel,
    doc.name,
    doc.source,
    doc.source === "faces" ? "" : doc.map,
    doc.source === "faces" ? doc.faces as Record<string, string> : null,
  );
}
