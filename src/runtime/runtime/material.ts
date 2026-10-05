// 材质资产（.mat）解析：节点只保存 .mat 引用，这里按引用预取文件并解析参数
// （缺失文件/字段回退默认），并附材质相关辅助（卡通灰阶渐变条、轮廓体外扩几何）。
// 与编辑器 framework/material（factory/types）的参数与默认值保持同步。
// 材质经 shader 字段引用 .shader 资产（Base → 渲染分支 + Hook 效果片段），
// 解析规则见 shader.mjs，注入见 shaderHooks.mjs。
//
import * as THREE from "../core/three.module.min.js";
import { num, u01, matColor } from "../core/utils";
import { parseShader, shaderKind } from "./shader";
import type { ShaderHook, ShaderProp } from "./shader";
import { resourceLoader } from "./resource";

/** 所挂 .shader 的解析数据（mesh 注入消费面） */
export interface ShaderData {
  base: string;
  include: string;
  hooks: ShaderHook[];
  properties: ShaderProp[];
}

/** 解析后的 .mat 参数（mesh/meshHooks/textures 的消费面） */
export interface MaterialParam {
  /** 渲染分支 key（physical/unlit/toon；.shader Base 归一后写入） */
  type: string;
  /** 所挂 .shader 资产引用（parseMaterialDoc 恒写入；MAT_DEFAULTS 缺省面可缺省） */
  shader?: string;
  color: number;
  metalness: number;
  roughness: number;
  specularIntensity: number;
  specularColor: number;
  ior: number;
  emissive: number;
  emissiveIntensity: number;
  emissionEnabled?: boolean;
  clearcoat: number;
  clearcoatRoughness: number;
  sheen: number;
  sheenColor: number;
  sheenRoughness: number;
  transmission: number;
  thickness: number;
  attenuationColor: number;
  attenuationDistance: number;
  anisotropy: number;
  anisotropyRotation: number;
  iridescence: number;
  iridescenceIOR: number;
  opacity: number;
  alphaClipThreshold: number;
  wireframe: boolean;
  toonSteps: number;
  toonShadowStrength: number;
  outlineEnabled: boolean;
  outlineColor: number;
  outlineWidth: number;
  /** 贴图通道相对路径（MAT_DEFAULTS 缺省面可缺省，按引用回填） */
  map?: string;
  metalnessMap?: string;
  roughnessMap?: string;
  normalMap?: string;
  emissiveMap?: string;
  /** 着色器参数（所挂 .shader 的 Properties 值：颜色 hex / 数字 / 向量数组 / 贴图路径） */
  props?: Record<string, unknown>;
  /** 所挂 .shader 的解析数据（shader 引用解析成功时存在） */
  shaderData?: ShaderData;
  shaderError?: string | null;
}

// 材质参数兜底：与编辑器内置 internal/materials/Default.mat（含 PBR 默认）一致
export const MAT_DEFAULTS: MaterialParam = {
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
const toonGradientCache = new Map<string, THREE.DataTexture>();

export function makeToonGradient(steps: unknown, shadowStrength: unknown): THREE.DataTexture {
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
const displacedGeometryCache = new WeakMap<THREE.BufferGeometry, Map<number, THREE.BufferGeometry>>();

/** 拷贝几何并沿顶点外扩 offset（对象空间单位）作为轮廓体几何；无法线则返回未外扩克隆。
 * 外扩方向取“焊接平均法线”（同位置多面重复顶点法线按位置合并平均），避免硬边处
 * 各面沿自身法线外扩把轮廓撕开（连接处断开）。 */
export function displacedGeometry(geom: THREE.BufferGeometry, offset: number): THREE.BufferGeometry {
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

function displacedGeometryUncached(geom: THREE.BufferGeometry, offset: number): THREE.BufferGeometry {
  const pos = geom.getAttribute("position");
  const nor = geom.getAttribute("normal");
  const out = geom.clone();
  if (!pos || !nor || pos.count !== nor.count) return out;
  const pa = pos.array;
  const na = nor.array;
  const count = pos.count;
  const slotOf = new Map<string, number>();
  const ax: number[] = [];
  const ay: number[] = [];
  const az: number[] = [];
  const keyOf = (i: number): string =>
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
    // keyOf(i) 在上一循环必然登记过槽位，非空断言
    const s = slotOf.get(keyOf(i))!;
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

/** .shader 解析结果（渲染分支 key + 钩子数据；kind=null 表示未知分支） */
interface ParsedShaderDoc {
  kind: string | null;
  base: string;
  include: string;
  hooks: ShaderHook[];
  properties: ShaderProp[];
  error: string | null;
}

/** 解析单个 .mat JSON → 规整化参数对象（缺省回退 MAT_DEFAULTS）。
 * type 为渲染分支 key：shader 字段引用的 .shader 资产由 loadMaterialParams
 * 二次拉取解析；此处先取旧 materialType 字段作回退。 */
function parseMaterialDoc(j: unknown): MaterialParam {
  const o: Record<string, unknown> =
    j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
  return {
    type: typeof o.materialType === "string" && o.materialType ? o.materialType : "physical",
    shader: typeof o.shader === "string" && o.shader.endsWith(".shader") ? o.shader : "",
    color: matColor(o.color, MAT_DEFAULTS.color),
    metalness: u01(o.metalness, MAT_DEFAULTS.metalness),
    roughness: u01(o.roughness, MAT_DEFAULTS.roughness),
    specularIntensity: u01(o.specularIntensity, MAT_DEFAULTS.specularIntensity),
    specularColor: matColor(o.specularColor, MAT_DEFAULTS.specularColor),
    ior: Math.max(1, Math.min(2.333, num(o.ior, MAT_DEFAULTS.ior))),
    emissive: matColor(o.emissive, MAT_DEFAULTS.emissive),
    emissiveIntensity: Math.max(0, Math.min(10, num(o.emissiveIntensity, MAT_DEFAULTS.emissiveIntensity))),
    emissionEnabled: o.emissionEnabled === true,
    clearcoat: u01(o.clearcoat, MAT_DEFAULTS.clearcoat),
    clearcoatRoughness: u01(o.clearcoatRoughness, MAT_DEFAULTS.clearcoatRoughness),
    sheen: u01(o.sheen, MAT_DEFAULTS.sheen),
    sheenColor: matColor(o.sheenColor, MAT_DEFAULTS.sheenColor),
    sheenRoughness: u01(o.sheenRoughness, MAT_DEFAULTS.sheenRoughness),
    transmission: u01(o.transmission, MAT_DEFAULTS.transmission),
    thickness: Math.max(0, Math.min(100, num(o.thickness, MAT_DEFAULTS.thickness))),
    attenuationColor: matColor(o.attenuationColor, MAT_DEFAULTS.attenuationColor),
    attenuationDistance: Math.max(0, Math.min(10, num(o.attenuationDistance, MAT_DEFAULTS.attenuationDistance))),
    anisotropy: u01(o.anisotropy, MAT_DEFAULTS.anisotropy),
    anisotropyRotation: u01(o.anisotropyRotation, MAT_DEFAULTS.anisotropyRotation),
    iridescence: u01(o.iridescence, MAT_DEFAULTS.iridescence),
    iridescenceIOR: Math.max(1, Math.min(2.333, num(o.iridescenceIOR, MAT_DEFAULTS.iridescenceIOR))),
    opacity: u01(o.opacity, MAT_DEFAULTS.opacity),
    alphaClipThreshold: u01(o.alphaClipThreshold, MAT_DEFAULTS.alphaClipThreshold),
    wireframe: o.wireframe === true,
    toonSteps: Math.max(2, Math.min(6, Math.round(num(o.toonSteps, MAT_DEFAULTS.toonSteps)))),
    toonShadowStrength: u01(o.toonShadowStrength, MAT_DEFAULTS.toonShadowStrength),
    outlineEnabled: o.outlineEnabled === true,
    outlineColor: matColor(o.outlineColor, MAT_DEFAULTS.outlineColor),
    outlineWidth: Math.max(0, Math.min(0.1, num(o.outlineWidth, MAT_DEFAULTS.outlineWidth))),
    map: typeof o.map === "string" ? o.map : "",
    metalnessMap: typeof o.metalnessMap === "string" ? o.metalnessMap : "",
    roughnessMap: typeof o.roughnessMap === "string" ? o.roughnessMap : "",
    normalMap: typeof o.normalMap === "string" ? o.normalMap : "",
    emissiveMap: typeof o.emissiveMap === "string" ? o.emissiveMap : "",
    // 着色器参数（所挂 .shader 的 Properties 值：颜色 hex / 数字 / 向量数组 / 贴图相对路径）
    props: o.props && typeof o.props === "object" && !Array.isArray(o.props)
      ? { ...(o.props as Record<string, unknown>) }
      : {},
  };
}

/** 解析 .shader 源文本 → { kind, base, include, hooks, properties, error }。
 * 渲染分支由 Base 声明（天空程序按 PreviewType=Skybox 标签识别，不走网格分支）。
 * 旧版 JSON 格式（$type=shader，早期内部实现遗留）兼容读取。 */
function parseShaderDoc(text: unknown): ParsedShaderDoc | null {
  const trimmed = String(text ?? "").trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed) as Record<string, unknown> | null;
      if (!j || j.$type !== "shader") return null;
      return {
        kind: typeof j.kind === "string" && SHADER_KINDS.has(j.kind) ? j.kind : "physical",
        base: "",
        hooks: [],
        properties: [],
        include: "",
        error: null,
      };
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
async function fetchShaderDoc(rel: string): Promise<(ParsedShaderDoc & { kind: string }) | null> {
  try {
    const text = await resourceLoader.loadText(rel);
    const doc = parseShaderDoc(text);
    if (!doc) return null;
    // 天空程序/未知 Base：不构成网格渲染分支 → 调用方回退默认材质
    if (!doc.kind || !SHADER_KINDS.has(doc.kind)) return null;
    // 上方守卫已保证 kind 为合法渲染分支字符串
    return doc as ParsedShaderDoc & { kind: string };
  } catch {
    return null;
  }
}

/** 收集场景树里 meshNode 的 .mat 引用，逐个 fetch 解析为参数表（ref → params）。
 * 材质经 shader 字段引用 .shader 资产时二次拉取：Base → 渲染分支 key（写入 type），
 * 钩子 + 属性表 → shaderData（供 mesh.mjs 注入内置材质）。
 * 缺失/解析失败的引用不进表（后续按 MAT_DEFAULTS 回退）。 */
export async function loadMaterialParams(rootJson: unknown): Promise<Map<string, MaterialParam>> {
  const materialParams = new Map<string, MaterialParam>();
  const refs = new Set<string>();
  (function walkMatRefs(o: unknown): void {
    if (!o || typeof o !== "object") return;
    const node = o as Record<string, unknown>;
    if (node.type === "meshNode" && typeof node.material === "string" && node.material) refs.add(node.material);
    if (Array.isArray(node.children)) (node.children as unknown[]).forEach(walkMatRefs);
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
