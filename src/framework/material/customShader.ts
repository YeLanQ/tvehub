// ---------------------------------------------------------------------------
// 自定义着色器（kind=custom）渲染侧：把组装好的 GLSL 程序装进 three ShaderMaterial，
// 并把 .mat 的 props 值转成 uniform（颜色/数值/向量/贴图）。
//
// - 程序来源：后端 shader_read（Rust 解析 ShaderLab 并拼好顶点/片元源码）；
//   本模块不解析着色器源码，只做 uniform 装配与运行期维护；
// - uniform 声明由组装产物自带（引擎按属性自动声明），这里只提供值；
// - _Time 为引擎注入的时间 uniform（编辑器 = 引擎运行时长，网页产物 = 加载后时长），
//   由渲染循环经 tickShaderTime 推进；
// - 程序缺失/组装失败时回退占位程序（洋红），避免 ShaderMaterial 无源码时渲染中断。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import type { MaterialParamGroup } from "./defs";
import type { MaterialParams, MaterialPropValue } from "./types";
import { colorToHexString, parseColorHex } from "./types";
import {
  CUSTOM_SHADER_KIND,
  type CustomShaderProgram,
  type ShaderPropertyDef,
} from "./shader";

export { CUSTOM_SHADER_KIND };

/** 引擎注入的时间 uniform（秒） */
export const TIME_UNIFORM = "_Time";

/** 贴图属性 uniform 的默认值（无贴图时为 null，three 绑定空纹理，采样不报错） */
const EMPTY_TEXTURE: THREE.Texture | null = null;

/** 自定义参数分组标题（材质卡片的属性分组） */
export const CUSTOM_PARAM_GROUP_TITLE = "着色器参数（Properties）";

/** 属性类型 → 面板控件类型（MaterialParamDef.kind 的取值域） */
function paramKindOf(prop: ShaderPropertyDef): "number" | "color" | "texture" | "vector" {
  switch (prop.kind) {
    case "color":
      return "color";
    case "texture":
      return "texture";
    case "vector":
      return "vector";
    default:
      return "number";
  }
}

/**
 * 着色器属性 → 材质面板参数分组（材质卡片/资产检查器数据驱动渲染）。
 * program 为 null（着色器缺失/组装失败）时返回空分组（面板改显示错误提示）。
 */
export function customParamGroups(properties: ShaderPropertyDef[]): MaterialParamGroup[] {
  if (properties.length === 0) return [];
  return [
    {
      title: CUSTOM_PARAM_GROUP_TITLE,
      defs: properties.map((prop) => ({
        key: prop.key,
        label: prop.label || prop.key,
        en: prop.key,
        kind: paramKindOf(prop),
        step: prop.kind === "int" ? 1 : 0.01,
        min: prop.min,
        max: prop.max,
      })),
    },
  ];
}

/** 属性默认值 → props 初值（面板展示/引擎取值共用；贴图默认为无贴图） */
export function customPropDefaults(
  properties: ShaderPropertyDef[],
): Record<string, MaterialPropValue> {
  const out: Record<string, MaterialPropValue> = {};
  for (const prop of properties) {
    switch (prop.kind) {
      case "color":
        out[prop.key] = typeof prop.default === "number" ? prop.default & 0xffffff : 0xffffff;
        break;
      case "vector":
        out[prop.key] = Array.isArray(prop.default)
          ? [...(prop.default as number[])]
          : [0, 0, 0, 0];
        break;
      case "texture":
        // 贴图默认值（"white"/"" 等 Unity 惯例名）不指向资产 → 无贴图
        out[prop.key] = typeof prop.default === "string" && prop.default.includes("/")
          ? prop.default
          : "";
        break;
      case "int":
        out[prop.key] = Math.round(typeof prop.default === "number" ? prop.default : 0);
        break;
      default:
        out[prop.key] = typeof prop.default === "number" ? prop.default : 0;
    }
  }
  return out;
}

/** 取参数值（props 缺失/类型不符时回退属性默认值） */
export function customPropValue(
  prop: ShaderPropertyDef,
  props: Record<string, MaterialPropValue>,
): MaterialPropValue {
  const v = props[prop.key];
  if (v === undefined) return customPropDefaults([prop])[prop.key];
  if (prop.kind === "vector" && !Array.isArray(v)) return customPropDefaults([prop])[prop.key];
  if (prop.kind !== "vector" && Array.isArray(v)) return customPropDefaults([prop])[prop.key];
  if (prop.kind === "int" && typeof v === "number") return Math.round(v);
  return v;
}

/** 颜色 → vec4 分量（sRGB hex → 线性工作空间，与 PBR 管线的颜色转换一致） */
function colorComponents(hex: number): [number, number, number, number] {
  const c = new THREE.Color().setHex(hex & 0xffffff);
  return [c.r, c.g, c.b, 1];
}

/**
 * 属性 → three uniform 初值：
 * - color → [r, g, b, 1]（vec4，线性空间）；vector → [x, y, z, w]；
 * - range/float/int → number；texture → Texture（异步装载后写入 uniform.value）
 */
export function customUniformValue(
  prop: ShaderPropertyDef,
  props: Record<string, MaterialPropValue>,
): { value: unknown } {
  const v = customPropValue(prop, props);
  switch (prop.kind) {
    case "color":
      return { value: colorComponents(parseColorHex(v, 0xffffff)) };
    case "vector":
      return { value: (Array.isArray(v) ? v : [0, 0, 0, 0]).slice(0, 4) };
    case "texture":
      return { value: EMPTY_TEXTURE };
    case "int":
      return { value: Math.round(typeof v === "number" ? v : 0) };
    default:
      return { value: typeof v === "number" ? v : 0 };
  }
}

/** 组装 ShaderMaterial 的 uniforms 表（属性 + _Time；贴图值由调用方异步回填） */
export function buildCustomUniforms(
  properties: ShaderPropertyDef[],
  params: MaterialParams,
  previous?: Record<string, THREE.IUniform>,
): Record<string, THREE.IUniform> {
  const uniforms: Record<string, THREE.IUniform> = {};
  for (const prop of properties) {
    // 复用既有 uniform 对象（three 的材质 uniforms 变更以引用为单位；
    // 复用可避免每帧/每次编辑重建对象导致的开销与闪烁）
    const value = customUniformValue(prop, params.props);
    const prev = previous?.[prop.key];
    if (prev) prev.value = value.value;
    else uniforms[prop.key] = value;
    if (prev) uniforms[prop.key] = prev;
  }
  uniforms[TIME_UNIFORM] = previous?.[TIME_UNIFORM] ?? { value: 0 };
  return uniforms;
}

/** 贴图属性 → 纹理加载（rel 为空则清空该 uniform） */
export function applyCustomTextures(
  properties: ShaderPropertyDef[],
  params: MaterialParams,
  uniforms: Record<string, THREE.IUniform>,
  loader: { loadTexture?(rel: string, srgb: boolean): Promise<THREE.Texture | null> } | undefined,
): void {
  for (const prop of properties) {
    if (prop.kind !== "texture") continue;
    const rel = customPropValue(prop, params.props);
    const uniform = uniforms[prop.key];
    if (!uniform) continue;
    if (typeof rel !== "string" || rel === "" || !loader?.loadTexture) {
      uniform.value = EMPTY_TEXTURE;
      continue;
    }
    void loader.loadTexture(rel, true).then((tex) => {
      uniform.value = tex;
    });
  }
}

// ---------------------------------------------------------------------------
// 程序缺失时的占位材质：洋红渐变（一眼可见的「着色器不可用」信号），
// 避免 ShaderMaterial 没有着色器源码导致的渲染中断/报错刷屏。
// ---------------------------------------------------------------------------

const PLACEHOLDER_VERTEX = `varying vec2 vPlaceholderUv;
void main() {
  vPlaceholderUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PLACEHOLDER_FRAGMENT = `varying vec2 vPlaceholderUv;
void main() {
  float s = floor(vPlaceholderUv.x * 8.0) + floor(vPlaceholderUv.y * 8.0);
  float odd = mod(s, 2.0);
  gl_FragColor = vec4(mix(vec3(1.0, 0.0, 1.0), vec3(0.12, 0.12, 0.12), odd), 1.0);
}
`;

/** 程序签名（顶点 + 片元 + 渲染状态）：变化时重编三材质 */
export function programSignature(program: CustomShaderProgram | null): string {
  if (!program) return "placeholder";
  return [
    program.state.transparent ? "T" : "O",
    program.state.depthWrite ? "W" : "-",
    program.state.side,
    program.vertex.length,
    program.fragment.length,
    hashText(program.vertex),
    hashText(program.fragment),
  ].join("|");
}

/** 轻量文本哈希（程序内容变化检测；不要求抗碰撞，变化即可触发重建） */
function hashText(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/** 程序 → three 面剔除模式 */
export function programSide(program: CustomShaderProgram | null): THREE.Side {
  switch (program?.state.side) {
    case "double":
      return THREE.DoubleSide;
    case "back":
      return THREE.BackSide;
    default:
      return THREE.FrontSide;
  }
}

/**
 * 把程序（或占位程序）写入 ShaderMaterial：
 * 程序签名变化才重设源码并置 needsUpdate（避免每帧重编）。
 */
export function applyCustomProgram(mat: THREE.ShaderMaterial, program: CustomShaderProgram | null): void {
  const sig = programSignature(program);
  const userData = mat.userData as Record<string, unknown>;
  if (userData.__customProgramSig !== sig) {
    mat.vertexShader = program ? program.vertex : PLACEHOLDER_VERTEX;
    mat.fragmentShader = program ? program.fragment : PLACEHOLDER_FRAGMENT;
    mat.needsUpdate = true;
    userData.__customProgramSig = sig;
  }
  mat.transparent = program?.state.transparent ?? false;
  mat.depthWrite = program?.state.depthWrite ?? true;
  mat.side = programSide(program);
  mat.wireframe = false;
}

// ---------------------------------------------------------------------------
// 时间 uniform 推进：注册在册的自定义材质由引擎渲染循环每帧设置 _Time。
// 材质被 dispose（类型切换/场景重建）时自动出册，无需额外的生命周期管理。
// ---------------------------------------------------------------------------

const liveCustomMaterials = new Set<THREE.ShaderMaterial>();

/** 登记自定义材质（dispose 时自动移除） */
export function registerCustomMaterial(mat: THREE.ShaderMaterial): void {
  if (liveCustomMaterials.has(mat)) return;
  liveCustomMaterials.add(mat);
  mat.addEventListener("dispose", () => liveCustomMaterials.delete(mat));
}

/** 渲染循环推进：设置全部在册材质的 _Time（秒） */
export function tickShaderTime(seconds: number): void {
  if (liveCustomMaterials.size === 0) return;
  for (const mat of liveCustomMaterials) {
    const uniform = mat.uniforms?.[TIME_UNIFORM];
    if (uniform) uniform.value = seconds;
  }
}

/** 在册材质数量（调试用） */
export function customMaterialCount(): number {
  return liveCustomMaterials.size;
}

/** 颜色默认值展示（面板初始值用；props 缺失时回退属性默认） */
export function customPropColorString(
  prop: ShaderPropertyDef,
  props: Record<string, MaterialPropValue>,
): string {
  return colorToHexString(parseColorHex(customPropValue(prop, props), 0xffffff));
}
