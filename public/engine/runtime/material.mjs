// 材质资产（.mat）解析：节点只保存 .mat 引用，这里按引用预取文件并解析参数
// （缺失文件/字段回退默认），并附材质相关辅助（卡通灰阶渐变条、轮廓体外扩几何）。
// 与编辑器 framework/material（factory/types）的参数与默认值保持同步。
// 自定义着色器（kind=custom）额外解析 .shader 源码：组装后的顶点/片元程序与属性表
// 随材质文档输出，供 mesh.mjs 构建 ShaderMaterial（解析规则见 shaderlab.mjs）。
import * as THREE from "../core/three.module.min.js";
import { num, u01, matColor } from "../core/utils.mjs";
import { isCustomShader, parseCustomShader } from "./shaderlab.mjs";

// 材质参数兜底：与编辑器内置 internal/materials/Default.mat（含 PBR 默认）一致
export const MAT_DEFAULTS = {
  type: "physical",
  color: 0x9aa4b2,
  metalness: 0.1,
  roughness: 0.75,
  specularIntensity: 1,
  specularColor: 0xffffff,
  ior: 1.5,
  emissive: 0x000000,
  emissiveIntensity: 1,
  clearcoat: 0,
  clearcoatRoughness: 0,
  sheen: 0,
  sheenColor: 0xffffff,
  sheenRoughness: 0.5,
  transmission: 0,
  thickness: 0,
  attenuationColor: 0xffffff,
  attenuationDistance: 0,
  anisotropy: 0,
  anisotropyRotation: 0,
  iridescence: 0,
  iridescenceIOR: 1.3,
  opacity: 1,
  alphaClipThreshold: 0.5,
  wireframe: false,
  toonSteps: 3,
  toonShadowStrength: 0.6,
  outlineEnabled: false,
  outlineColor: 0x000000,
  outlineWidth: 0.02,
};

/** 卡通灰阶渐变条 DataTexture（n 列灰阶 暗→亮；与编辑器算法一致）。
 * MeshToonMaterial 约束：NearestFilter + 关 mipmap + NoColorSpace，shader 只取红通道分档。 */
export function makeToonGradient(steps, shadowStrength) {
  const n = Math.max(2, Math.min(6, Math.round(num(steps, 3))));
  const darkest = Math.max(0, Math.min(1, 1 - num(shadowStrength, 0.6)));
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = darkest + (i / (n - 1)) * (1 - darkest);
    const byte = Math.round(Math.max(0, Math.min(1, v)) * 255);
    data[i * 4] = byte;
    data[i * 4 + 1] = byte;
    data[i * 4 + 2] = byte;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, 1);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 拷贝几何并沿顶点外扩 offset（对象空间单位）作为轮廓体几何；无法线则返回未外扩克隆。
 * 外扩方向取“焊接平均法线”（同位置多面重复顶点法线按位置合并平均），避免硬边处
 * 各面沿自身法线外扩把轮廓撕开（连接处断开）。 */
export function displacedGeometry(geom, offset) {
  const pos = geom.getAttribute("position");
  const nor = geom.getAttribute("normal");
  const out = geom.clone();
  if (!pos || !nor || pos.count !== nor.count) return out;
  const pa = pos.array;
  const na = nor.array;
  const count = pos.count;
  const slotOf = new Map();
  const ax = [];
  const ay = [];
  const az = [];
  const keyOf = (i) =>
    `${Math.round(pa[i * 3] * 1e4)}_${Math.round(pa[i * 3 + 1] * 1e4)}_${Math.round(pa[i * 3 + 2] * 1e4)}`;
  for (let i = 0; i < count; i++) {
    const key = keyOf(i);
    let s = slotOf.get(key);
    if (s === undefined) {
      s = ax.length;
      slotOf.set(key, s);
      ax.push(na[i * 3]);
      ay.push(na[i * 3 + 1]);
      az.push(na[i * 3 + 2]);
    } else {
      ax[s] += na[i * 3];
      ay[s] += na[i * 3 + 1];
      az[s] += na[i * 3 + 2];
    }
  }
  const moved = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const s = slotOf.get(keyOf(i));
    const len = Math.hypot(ax[s], ay[s], az[s]);
    const oi = i * 3;
    if (len < 1e-6) {
      moved[oi] = pa[oi];
      moved[oi + 1] = pa[oi + 1];
      moved[oi + 2] = pa[oi + 2];
    } else {
      const o = offset / len;
      moved[oi] = pa[oi] + ax[s] * o;
      moved[oi + 1] = pa[oi + 1] + ay[s] * o;
      moved[oi + 2] = pa[oi + 2] + az[s] * o;
    }
  }
  out.setAttribute("position", new THREE.BufferAttribute(moved, 3));
  out.computeBoundingSphere();
  return out;
}

/** 合法渲染分支 key（与编辑器工厂注册表一致）；.shader kind 归一到此集合 */
const SHADER_KINDS = new Set(["physical", "unlit", "toon", "custom"]);

/** 解析单个 .mat JSON → 规整化参数对象（缺省回退 MAT_DEFAULTS）。
 * type 为渲染分支 key：shader 字段引用的 .shader 资产由 loadMaterialParams
 * 二次拉取解析；此处先取旧 materialType 字段作回退。 */
function parseMaterialDoc(j) {
  return {
    type: typeof j.materialType === "string" && j.materialType ? j.materialType : "physical",
    shader: typeof j.shader === "string" && j.shader.endsWith(".shader") ? j.shader : "",
    color: matColor(j.color, MAT_DEFAULTS.color),
    metalness: u01(j.metalness, MAT_DEFAULTS.metalness),
    roughness: u01(j.roughness, MAT_DEFAULTS.roughness),
    specularIntensity: u01(j.specularIntensity, MAT_DEFAULTS.specularIntensity),
    specularColor: matColor(j.specularColor, MAT_DEFAULTS.specularColor),
    ior: Math.max(1, Math.min(2.333, num(j.ior, MAT_DEFAULTS.ior))),
    emissive: matColor(j.emissive, MAT_DEFAULTS.emissive),
    emissiveIntensity: Math.max(0, Math.min(10, num(j.emissiveIntensity, MAT_DEFAULTS.emissiveIntensity))),
    emissionEnabled: j.emissionEnabled === true,
    clearcoat: u01(j.clearcoat, MAT_DEFAULTS.clearcoat),
    clearcoatRoughness: u01(j.clearcoatRoughness, MAT_DEFAULTS.clearcoatRoughness),
    sheen: u01(j.sheen, MAT_DEFAULTS.sheen),
    sheenColor: matColor(j.sheenColor, MAT_DEFAULTS.sheenColor),
    sheenRoughness: u01(j.sheenRoughness, MAT_DEFAULTS.sheenRoughness),
    transmission: u01(j.transmission, MAT_DEFAULTS.transmission),
    thickness: Math.max(0, Math.min(100, num(j.thickness, MAT_DEFAULTS.thickness))),
    attenuationColor: matColor(j.attenuationColor, MAT_DEFAULTS.attenuationColor),
    attenuationDistance: Math.max(0, Math.min(10, num(j.attenuationDistance, MAT_DEFAULTS.attenuationDistance))),
    anisotropy: u01(j.anisotropy, MAT_DEFAULTS.anisotropy),
    anisotropyRotation: u01(j.anisotropyRotation, MAT_DEFAULTS.anisotropyRotation),
    iridescence: u01(j.iridescence, MAT_DEFAULTS.iridescence),
    iridescenceIOR: Math.max(1, Math.min(2.333, num(j.iridescenceIOR, MAT_DEFAULTS.iridescenceIOR))),
    opacity: u01(j.opacity, MAT_DEFAULTS.opacity),
    alphaClipThreshold: u01(j.alphaClipThreshold, MAT_DEFAULTS.alphaClipThreshold),
    wireframe: j.wireframe === true,
    toonSteps: Math.max(2, Math.min(6, Math.round(num(j.toonSteps, MAT_DEFAULTS.toonSteps)))),
    toonShadowStrength: u01(j.toonShadowStrength, MAT_DEFAULTS.toonShadowStrength),
    outlineEnabled: j.outlineEnabled === true,
    outlineColor: matColor(j.outlineColor, MAT_DEFAULTS.outlineColor),
    outlineWidth: Math.max(0, Math.min(0.1, num(j.outlineWidth, MAT_DEFAULTS.outlineWidth))),
    map: typeof j.map === "string" ? j.map : "",
    metalnessMap: typeof j.metalnessMap === "string" ? j.metalnessMap : "",
    roughnessMap: typeof j.roughnessMap === "string" ? j.roughnessMap : "",
    normalMap: typeof j.normalMap === "string" ? j.normalMap : "",
    emissiveMap: typeof j.emissiveMap === "string" ? j.emissiveMap : "",
    // 自定义着色器参数（props：颜色 hex / 数字 / 向量数组 / 贴图相对路径）
    props: j.props && typeof j.props === "object" && !Array.isArray(j.props) ? { ...j.props } : {},
  };
}

/** ShaderLab 源文本 → 渲染分支 key（与后端 parse_shader_doc 同规则）：
 * 天空程序（PreviewType=Skybox 标签）→ skyprocedural/skycube（不属于网格渲染
 * 分支，fetchShaderKind 校验时回退）；自定义着色器（CGINCLUDE / 双 CGPROGRAM 块，
 * 源码真正编译）→ custom；surface 光照模型 Toon → toon / Standard → physical
 * （其余 surface 模型归 physical）；无 surface pragma 但有顶点片元 pragma
 * （#pragma fragment/vertex）→ unlit。 */
function shaderKindFromSource(text) {
  const src = String(text ?? "");
  if (src.includes('"PreviewType"="Skybox"')) {
    return src.includes("samplerCUBE") ? "skycube" : "skyprocedural";
  }
  if (isCustomShader(src)) return "custom";
  let kind = "";
  for (const line of src.split(/\r?\n/)) {
    const t = line.trim();
    const m = t.match(/^#pragma\s+surface\s+\S+\s+(\S+)/);
    if (m) {
      kind = m[1].toLowerCase() === "toon" ? "toon" : "physical";
      break;
    }
    if (!kind && /^#pragma\s+(fragment|vertex)/.test(t)) kind = "unlit";
  }
  return kind || "physical";
}

/** 按引用拉取 .shader 资产 → 渲染分支 key 与（自定义着色器的）程序/属性表。
 * 缺失/损坏/未知 kind 返回 null；旧版 JSON 格式（$type=shader）兼容读取。 */
async function fetchShaderDoc(rel) {
  try {
    const r = await fetch(rel);
    if (!r.ok) return null;
    const text = await r.text();
    const trimmed = text.trimStart();
    if (trimmed.startsWith("{")) {
      try {
        const j = JSON.parse(trimmed);
        return j && j.$type === "shader" && SHADER_KINDS.has(j.kind) ? { kind: j.kind } : null;
      } catch {
        return null;
      }
    }
    const kind = shaderKindFromSource(text);
    if (!SHADER_KINDS.has(kind)) return null;
    if (kind !== "custom") return { kind };
    // 自定义着色器：组装顶点/片元程序 + 属性表（面板/渲染同源）
    const parsed = parseCustomShader(text, rel);
    return { kind, program: parsed.program, properties: parsed.properties, error: parsed.error };
  } catch {
    return null;
  }
}

/** 收集场景树里 meshNode 的 .mat 引用，逐个 fetch 解析为参数表（ref → params）。
 * 材质经 shader 字段引用 .shader 资产时二次拉取，把渲染分支 key 写入 type，
 * 自定义着色器另带 program（组装后的顶点/片元源码）与 properties（属性表）
 * （旧 .mat 无 shader 字段则沿用 materialType）。缺失/解析失败的引用不进表
 * （后续按 MAT_DEFAULTS 回退）。 */
export async function loadMaterialParams(rootJson) {
  const materialParams = new Map();
  const refs = new Set();
  (function walkMatRefs(o) {
    if (!o || typeof o !== "object") return;
    if (o.type === "meshNode" && typeof o.material === "string" && o.material) refs.add(o.material);
    if (Array.isArray(o.children)) o.children.forEach(walkMatRefs);
  })(rootJson);
  for (const rel of refs) {
    try {
      const r = await fetch(rel);
      if (r.ok) {
        const j = await r.json();
        const doc = parseMaterialDoc(j);
        if (doc.shader) {
          const shader = await fetchShaderDoc(doc.shader);
          if (shader) {
            doc.type = shader.kind;
            doc.program = shader.program ?? null;
            doc.properties = shader.properties ?? [];
            doc.shaderError = shader.error ?? null;
          }
        }
        materialParams.set(rel, doc);
      }
    } catch {
      /* 缺失材质：回退默认 */
    }
  }
  return materialParams;
}
