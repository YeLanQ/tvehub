// ---------------------------------------------------------------------------
// 材质资产文件（.mat，JSON 文本）的解析/序列化。
// 文件格式（与 public/internal/materials/*.mat 一致）：
//   {
//     "$type": "material",
//     "$ver": 1,
//     "name": "Default",
//     "color": "#9aa4b2",      // 也接受 RGB hex number
//     "metalness": 0.1,
//     "roughness": 0.75,
//     "emissive": "#000000",
//     "wireframe": false
//   }
// ---------------------------------------------------------------------------

import {
  DEFAULT_MATERIAL_PARAMS,
  materialParamsFrom,
  colorToHexString,
  type MaterialParams,
} from "./types";

/** 解析后的材质资产文档 */
export interface MaterialDoc {
  name: string;
  params: MaterialParams;
}

const MAGIC_TYPE = "material";
const MAGIC_VER = 1;

/** 解析 .mat 文本 → 材质文档；失败（非 JSON/非材质文档）返回 null */
export function parseMaterialFile(text: string): MaterialDoc | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (o.$type !== MAGIC_TYPE) return null;
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : "Material";
  const params = materialParamsFrom(o);
  return { name, params };
}

/** 把材质文档序列化为 .mat 文本（颜色写为 "#rrggbb" 便于人工阅读/编辑） */
export function serializeMaterialFile(doc: MaterialDoc): string {
  const json = {
    $type: MAGIC_TYPE,
    $ver: MAGIC_VER,
    name: doc.name,
    color: colorToHexString(doc.params.color),
    metalness: doc.params.metalness,
    roughness: doc.params.roughness,
    emissive: colorToHexString(doc.params.emissive),
    wireframe: doc.params.wireframe,
  };
  return JSON.stringify(json, null, 2);
}

/** 材质文档默认构造（参数取默认值） */
export function defaultMaterialDoc(name: string): MaterialDoc {
  return { name, params: { ...DEFAULT_MATERIAL_PARAMS } };
}
