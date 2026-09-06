// ---------------------------------------------------------------------------
// 材质资产文件（.mat，JSON 文本）的解析/序列化。
// 文件格式（与 public/internal/materials/*.mat 一致）：
//   {
//     "$type": "material",
//     "$ver": 1,
//     "name": "Default",
//     "materialType": "physical",  // 材质类型（工厂注册表 key；缺失 = physical）
//     "color": "#9aa4b2",          // 也接受 RGB hex number
//     "metalness": 0.1,
//     "roughness": 0.75,
//     "emissive": "#000000",
//     "wireframe": false
//   }
// 参数按超集存储：类型未暴露的字段原样保留（切回支持该字段的类型时恢复生效）。
// ---------------------------------------------------------------------------

import {
  materialParamsFrom,
  colorToHexString,
  type MaterialParams,
} from "./types";
import { DEFAULT_MATERIAL_TYPE, materialTypeRegistry } from "./factory";

/** 解析后的材质资产文档 */
export interface MaterialDoc {
  name: string;
  /** 材质类型（注册表 key；未知 key 渲染时回退 physical） */
  type: string;
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
  const type =
    typeof o.materialType === "string" && o.materialType.trim()
      ? o.materialType.trim()
      : DEFAULT_MATERIAL_TYPE;
  const params = materialParamsFrom(o);
  return { name, type, params };
}

/** 把材质文档序列化为 .mat 文本（颜色写为 "#rrggbb" 便于人工阅读/编辑） */
export function serializeMaterialFile(doc: MaterialDoc): string {
  const p = doc.params;
  const json = {
    $type: MAGIC_TYPE,
    $ver: MAGIC_VER,
    name: doc.name,
    materialType: doc.type || DEFAULT_MATERIAL_TYPE,
    color: colorToHexString(p.color),
    metalness: p.metalness,
    roughness: p.roughness,
    specularIntensity: p.specularIntensity,
    specularColor: colorToHexString(p.specularColor),
    ior: p.ior,
    emissive: colorToHexString(p.emissive),
    emissiveIntensity: p.emissiveIntensity,
    emissionEnabled: p.emissionEnabled,
    clearcoat: p.clearcoat,
    clearcoatRoughness: p.clearcoatRoughness,
    clearcoatEnabled: p.clearcoatEnabled,
    sheen: p.sheen,
    sheenColor: colorToHexString(p.sheenColor),
    sheenRoughness: p.sheenRoughness,
    sheenEnabled: p.sheenEnabled,
    transmission: p.transmission,
    thickness: p.thickness,
    attenuationColor: colorToHexString(p.attenuationColor),
    attenuationDistance: p.attenuationDistance,
    transmissionEnabled: p.transmissionEnabled,
    anisotropy: p.anisotropy,
    anisotropyRotation: p.anisotropyRotation,
    iridescence: p.iridescence,
    iridescenceIOR: p.iridescenceIOR,
    opacity: p.opacity,
    alphaClipThreshold: p.alphaClipThreshold,
    wireframe: p.wireframe,
    toonSteps: p.toonSteps,
    toonShadowStrength: p.toonShadowStrength,
    map: p.map,
    metalnessMap: p.metalnessMap,
    roughnessMap: p.roughnessMap,
    normalMap: p.normalMap,
    emissiveMap: p.emissiveMap,
  };
  return JSON.stringify(json, null, 2);
}

/** 材质文档默认构造：参数取该类型工厂默认值；类型未注册回退默认类型 */
export function defaultMaterialDoc(name: string, type = DEFAULT_MATERIAL_TYPE): MaterialDoc {
  const def = materialTypeRegistry.getOrDefault(type);
  return { name, type: def.key, params: def.defaultParams() };
}
