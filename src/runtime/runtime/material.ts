// 材质资产（.mat）解析：节点只保存 .mat 引用，这里按引用预取文件并解析参数
// （缺失文件/字段回退默认），并附材质相关辅助（卡通灰阶渐变条、轮廓体外扩几何）。
// 与编辑器 framework/material（factory/types）的参数与默认值保持同步。
// 材质经 shader 字段引用 .shader 资产（Base → 渲染分支 + Hook 效果片段），
// 解析规则见 shader.mjs，注入见 shaderHooks.mjs。
//
import * as THREE from "../core/three.module.min.js";
import { num, u01, matColor } from "../core/utils";
import { parseShader, shaderKind } from "./shader";
import { resourceLoader } from "./resource";

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
 * MeshToonMaterial 约束：NearestFilter + 关 mipmap + NoColorSpace，shader 只取红通道分档。
 * 按 steps|shadowStrength 缓存：同参数网格共享一份纹理（实例只读）。 */
const toonGradientCache = new Map();

export function makeToonGradient(steps, shadowStrength) {
  const n = Math.max(2, Math.min(6, Math.round(num(steps, 3))));
  const darkest = Math.max(0, Math.min(1, 1 - num(shadowStrength, 0.6)));
  const key = `${n}|${darkest}`;
  let tex = toonGradientCache.get(key);
  if (tex) return tex;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = darkest + (i / (n - 1)) * (1 - darkest);
    const byte = Math.round(Math.max(0, Math.min(1, v)) * 255);
    data[i * 4] = byte;
    data[i * 4 + 1] = byte;
    data[i * 4 + 2] = byte;
    data[i * 4 + 3] = 255;
  }
  tex = new THREE.DataTexture(data, n, 1);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  toonGradientCache.set(key, tex);
  return tex;
}

/** 轮廓体外扩几何按（源几何, 外扩量）缓存：同规格网格的描边壳共享一份顶点缓冲。
 * 缓存的克隆几何与源几何一样只读（运行时无几何写入路径）。 */
const displacedGeometryCache = new WeakMap();

/** 拷贝几何并沿顶点外扩 offset（对象空间单位）作为轮廓体几何；无法线则返回未外扩克隆。
 * 外扩方向取“焊接平均法线”（同位置多面重复顶点法线按位置合并平均），避免硬边处
 * 各面沿自身法线外扩把轮廓撕开（连接处断开）。 */
export function displacedGeometry(geom, offset) {
  let byOffset = displacedGeometryCache.get(geom);
  if (!byOffset) {
    byOffset = new Map();
    displacedGeometryCache.set(geom, byOffset);
  }
  const cached = byOffset.get(offset);
  if (cached) return cached;
  const out = displacedGeometryUncached(geom, offset);
  byOffset.set(offset, out);
  return out;
}

function displacedGeometryUncached(geom, offset) {
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

/** 合法渲染分支 key（与编辑器工厂注册表一致）；.shader 的 Base 归一到此集合 */
const SHADER_KINDS = new Set(["physical", "unlit", "toon"]);

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
    // 着色器参数（所挂 .shader 的 Properties 值：颜色 hex / 数字 / 向量数组 / 贴图相对路径）
    props: j.props && typeof j.props === "object" && !Array.isArray(j.props) ? { ...j.props } : {},
  };
}

/** 解析 .shader 源文本 → { kind, base, include, hooks, properties, error }。
 * 渲染分支由 Base 声明（天空程序按 PreviewType=Skybox 标签识别，不走网格分支）。
 * 旧版 JSON 格式（$type=shader，早期内部实现遗留）兼容读取。 */
function parseShaderDoc(text) {
  const trimmed = String(text ?? "").trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed);
      if (!j || j.$type !== "shader") return null;
      return { kind: SHADER_KINDS.has(j.kind) ? j.kind : "physical", base: "", hooks: [], properties: [], error: null };
    } catch {
      return null;
    }
  }
  const parsed = parseShader(text);
  const kind = shaderKind(text);
  return { ...parsed, kind };
}

/** 按引用拉取 .shader 资产 → 渲染分支 + 钩子数据。
 * 缺失/损坏/未知分支返回 null（调用方回退默认材质）。 */
async function fetchShaderDoc(rel) {
  try {
    const text = await resourceLoader.loadText(rel);
    const doc = parseShaderDoc(text);
    if (!doc) return null;
    // 天空程序/未知 Base：不构成网格渲染分支 → 调用方回退默认材质
    if (!doc.kind || !SHADER_KINDS.has(doc.kind)) return null;
    return doc;
  } catch {
    return null;
  }
}

/** 收集场景树里 meshNode 的 .mat 引用，逐个 fetch 解析为参数表（ref → params）。
 * 材质经 shader 字段引用 .shader 资产时二次拉取：Base → 渲染分支 key（写入 type），
 * 钩子 + 属性表 → shaderData（供 mesh.mjs 注入内置材质）。
 * 缺失/解析失败的引用不进表（后续按 MAT_DEFAULTS 回退）。 */
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
      const j = await resourceLoader.loadJSON(rel);
      const doc = parseMaterialDoc(j);
      if (doc.shader) {
        const shader = await fetchShaderDoc(doc.shader);
        if (shader) {
          doc.type = shader.kind;
          doc.shaderData = {
            base: shader.base,
            include: shader.include,
            hooks: shader.hooks,
            properties: shader.properties,
          };
          doc.shaderError = shader.error ?? null;
        }
      }
      materialParams.set(rel, doc);
    } catch {
      /* 缺失材质：回退默认 */
    }
  }
  return materialParams;
}
