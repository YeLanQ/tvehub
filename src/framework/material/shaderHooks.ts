// ---------------------------------------------------------------------------
// 着色器 Hook 注入：把 .shader 的 Hook 片段注入到内置 PBR/Toon/Unlit 材质。
//
// 引擎的渲染分支只有三个出口，自定义着色效果就写在着色器资产的 Base + Hook 里：
// 本模块把 Hook 片段注入到 Three.js 内置材质的对应着色阶段，基础材质的光照/贴图/
// 参数全部保留：
// - WebGL 后端：onBeforeCompile 字符串替换，把钩子 GLSL 注入到 #include <chunk> 处
// - WebGPU/TSL 后端：暂占位（onBeforeCompile 不参与 NodeMaterial 编译）
//
// 钩子注入点（Three.js shader chunk 结构）：
//   Vertex   → #include <begin_vertex> 后（可修改 transformed=position）
//   Normal   → #include <normal_fragment_maps> 后（可修改 normal）
//   Diffuse  → #include <color_fragment> 后（可修改 diffuseColor）
//   Emissive → #include <emissivemap_fragment> 后（可修改 totalEmissiveRadiance）
//   Fragment → #include <dithering_fragment> 前（可修改 gl_FragColor）
// 分支差异（与后端 shader.rs 的 hook_support 一致）：Unlit 没有法线/自发光阶段，
// 只有 Vertex/Diffuse/Fragment，且片元阶段没有 vViewPosition（viewDir 不可用）。
//
// 钩子内可用变量（约定名 → Three.js 实际名）：
//   normal（同名）/ viewDir（vViewPosition）/ uv（vExtUv）/ _Time（引擎注入）
//   emissive → totalEmissiveRadiance / diffuseColor（同名）/ fragColor → gl_FragColor
// ---------------------------------------------------------------------------

import * as THREE from "three";
import type { MaterialParamGroup } from "./defs";
import type { ShaderDoc, ShaderHook, ShaderPropertyDef } from "./shader";
import { parseColorHex } from "./types";

/** 钩子数据（着色器文档里参与注入的部分） */
export interface ShaderHookData {
  base: string;
  include: string;
  hooks: ShaderHook[];
  properties: ShaderPropertyDef[];
}

/** 着色器文档 → 注入用钩子数据（解析失败返回 null → 不注入） */
export function hookDataOf(doc: ShaderDoc | null): ShaderHookData | null {
  if (!doc || doc.error) return null;
  return {
    base: doc.base,
    include: doc.include,
    hooks: doc.hooks,
    properties: doc.properties,
  };
}

/** 着色器参数值（键 = 属性名，值 = 面板输入） */
export type ShaderProps = Record<string, number | boolean | string | number[]>;

/** 着色器参数分组标题（材质卡片的属性分组） */
export const SHADER_PARAM_GROUP_TITLE = "着色器参数（Properties）";

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
 * 扩展着色器属性 → 材质面板参数分组（材质卡片/资产检查器数据驱动渲染）。
 * 无属性返回空分组（面板不渲染该块）。
 */
export function shaderParamGroups(properties: ShaderPropertyDef[]): MaterialParamGroup[] {
  if (properties.length === 0) return [];
  return [
    {
      title: SHADER_PARAM_GROUP_TITLE,
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

/** 着色器属性默认值 → params.props 初值（面板展示用；贴图默认无贴图） */
export function shaderPropDefaults(
  properties: ShaderPropertyDef[],
): Record<string, number | string | number[]> {
  const out: Record<string, number | string | number[]> = {};
  for (const prop of properties) {
    switch (prop.kind) {
      case "color":
        out[prop.key] = typeof prop.default === "number" ? prop.default & 0xffffff : 0xffffff;
        break;
      case "vector":
        out[prop.key] = Array.isArray(prop.default) ? [...(prop.default as number[])] : [0, 0, 0, 0];
        break;
      case "texture":
        // 贴图默认值（"white"/"" 等惯例名）不指向资产 → 无贴图
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

/** 引擎注入的运行时间 uniform 名 */
const TIME_UNIFORM = "_Time";
/** 扩展专用 UV varying（始终声明，不依赖 USE_UV） */
const EXT_UV_VARYING = "vExtUv";

/** userData 标记：材质上挂载的扩展着色器签名（用于检测变更） */
const HOOK_SIG_KEY = "__tveHookSig";
/** userData 标记：扩展着色器 uniform 值表 */
const HOOK_UNIFORMS_KEY = "__tveHookUniforms";

// ---- 钩子注入点配置 ----

interface HookInjectPoint {
  shader: "vertex" | "fragment";
  include: string;
  position: "after" | "before";
  /** 约定变量名 → Three.js 变量名映射（单词边界替换） */
  varMap: Record<string, string>;
  /** 注入前需要声明的辅助代码（如 viewDir 计算） */
  prelude?: string;
}

const HOOK_POINTS: Record<string, HookInjectPoint> = {
  Vertex: {
    shader: "vertex",
    include: "begin_vertex",
    position: "after",
    // 顶点着色器里 uv/normal 都是 attribute，直接可用；position → transformed（可修改）
    varMap: { position: "transformed" },
  },
  Normal: {
    shader: "fragment",
    include: "normal_fragment_maps",
    position: "after",
    varMap: { uv: EXT_UV_VARYING },
    prelude: `vec3 viewDir = normalize(vViewPosition);`,
  },
  Diffuse: {
    shader: "fragment",
    include: "color_fragment",
    position: "after",
    varMap: { uv: EXT_UV_VARYING },
    prelude: `vec3 viewDir = normalize(vViewPosition);`,
  },
  Emissive: {
    shader: "fragment",
    include: "emissivemap_fragment",
    position: "after",
    varMap: { emissive: "totalEmissiveRadiance", uv: EXT_UV_VARYING },
    prelude: `vec3 viewDir = normalize(vViewPosition);`,
  },
  Fragment: {
    shader: "fragment",
    include: "dithering_fragment",
    position: "before",
    varMap: { fragColor: "gl_FragColor", uv: EXT_UV_VARYING },
    prelude: `vec3 viewDir = normalize(vViewPosition);`,
  },
};

/** 单词边界替换（避免误替换子串） */
function remapVars(code: string, varMap: Record<string, string>): string {
  let result = code;
  for (const [src, dst] of Object.entries(varMap)) {
    if (src === dst) continue;
    result = result.replace(new RegExp(`\\b${src}\\b`, "g"), dst);
  }
  return result;
}

/** 轻量文本哈希（djb2；只用于变更检测与程序缓存 key，不要求抗碰撞） */
function hashText(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/**
 * 注入内容签名：钩子全文（哈希）+ CGINCLUDE + 属性集合（键 + 类型）。
 * 两个用途，必须内容敏感：
 * - 变更检测：同长度改代码也要重建注入；
 * - 程序缓存 key（customProgramCacheKey）：不同钩子集合必须命中不同的 program
 *   ——否则 three 会按 onBeforeCompile.toString() 复用同一条 program，让后一个
 *   材质渲染出前一个材质的效果（两个网格都变成同一个效果）。
 * 属性「值」不参与：值走 uniform，改值不应触发重编。
 */
function hookSignature(hooks: ShaderHookData | null): string {
  if (!hooks) return "";
  const hookSig = hooks.hooks.map((h) => `${h.name}:${hashText(h.code)}`).join("|");
  const propSig = hooks.properties.map((p) => `${p.key}:${p.kind}`).join(",");
  return `${hooks.base}#${hookSig}#${propSig}#${hashText(hooks.include)}`;
}

/** 属性 → uniform 初始值 */
function uniformInitialValue(prop: ShaderPropertyDef): THREE.IUniform {
  switch (prop.kind) {
    case "color": {
      const hex = parseColorHex(prop.default as number, 0xffffff);
      const c = new THREE.Color().setHex(hex & 0xffffff);
      return { value: new THREE.Vector4(c.r, c.g, c.b, 1) };
    }
    case "vector": {
      const a = Array.isArray(prop.default) ? prop.default : [0, 0, 0, 0];
      return { value: new THREE.Vector4(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0) };
    }
    case "texture":
      return { value: null };
    default:
      return { value: typeof prop.default === "number" ? prop.default : 0 };
  }
}

/** 属性值 → uniform 值写入 */
function writeUniformValue(
  uniform: THREE.IUniform,
  prop: ShaderPropertyDef,
  raw: number | boolean | string | number[] | undefined,
): void {
  const v = raw ?? prop.default;
  switch (prop.kind) {
    case "color": {
      const hex = parseColorHex(typeof v === "number" ? v : 0xffffff, 0xffffff);
      const c = new THREE.Color().setHex(hex & 0xffffff);
      (uniform.value as THREE.Vector4).set(c.r, c.g, c.b, 1);
      break;
    }
    case "vector": {
      const a = Array.isArray(v) ? v : [0, 0, 0, 0];
      (uniform.value as THREE.Vector4).set(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0);
      break;
    }
    case "int":
      uniform.value = Math.round(typeof v === "number" ? v : 0);
      break;
    case "texture":
      break;
    default:
      uniform.value = typeof v === "number" ? v : 0;
  }
}

/**
 * 组装钩子注入代码（prelude + 变量映射后的用户代码）。
 * 每个 Hook 包在独立块作用域里：同一着色器的多个 Hook 会注入到同一段 GLSL，
 * 各自声明的局部变量（含引擎注入的 viewDir 前言）若不加隔离会互相重定义
 * （典型报错：'viewDir' : redefinition / 'n' : redefinition）。
 * Hook 之间通过端口变量通信（diffuseColor/emissive/… 在外层作用域），不共享局部变量。
 */
function assembleHookCode(hook: ShaderHook): string {
  const point = HOOK_POINTS[hook.name];
  if (!point) return "";
  const prelude = point.prelude ? `${point.prelude}\n` : "";
  const userCode = remapVars(hook.code, point.varMap);
  return `{\n${prelude}${userCode}\n}`;
}

/** 生成 uniform 声明（GLSL） */
function uniformDeclarations(hooks: ShaderHookData, hookNames: Set<string>): string {
  const lines: string[] = [];
  for (const prop of hooks.properties) {
    const ty = prop.kind === "color" || prop.kind === "vector" ? "vec4" : prop.kind === "texture" ? "sampler2D" : "float";
    lines.push(`uniform ${ty} ${prop.key};`);
  }
  if (hookNames.has("Vertex") || hookNames.has("Normal") || hookNames.has("Diffuse") || hookNames.has("Emissive") || hookNames.has("Fragment")) {
    lines.push(`uniform float ${TIME_UNIFORM};`);
  }
  return lines.join("\n");
}

/** 把 #include <chunk> 替换为 #include <chunk> + 注入代码 */
function injectAfter(shader: string, chunk: string, code: string): string {
  const tag = `#include <${chunk}>`;
  const idx = shader.indexOf(tag);
  if (idx < 0) return shader;
  return shader.slice(0, idx + tag.length) + "\n" + code + "\n" + shader.slice(idx + tag.length);
}

/** 把注入代码放到 #include <chunk> 之前 */
function injectBefore(shader: string, chunk: string, code: string): string {
  const tag = `#include <${chunk}>`;
  const idx = shader.indexOf(tag);
  if (idx < 0) return shader;
  return shader.slice(0, idx) + code + "\n" + shader.slice(idx);
}

/** 钩子 uniform 表（材质 userData 上持久化） */
interface HookUniformTable {
  [key: string]: THREE.IUniform;
}

/** 确保材质上有钩子 uniform 表 */
function ensureHookUniformTable(mat: THREE.Material): HookUniformTable {
  const ud = mat.userData as Record<string, unknown>;
  let table = ud[HOOK_UNIFORMS_KEY] as HookUniformTable | undefined;
  if (!table) {
    table = {};
    ud[HOOK_UNIFORMS_KEY] = table;
  }
  return table;
}


/** 构建 onBeforeCompile 注入函数（mat 用于持久化 uniform 表到 userData） */
function buildOnBeforeCompile(hooks: ShaderHookData, mat: THREE.Material) {
  const hookNames = new Set(hooks.hooks.map((h) => h.name));
  const decls = uniformDeclarations(hooks, hookNames);
  const includeBlock = hooks.include ? `\n${hooks.include}\n` : "";
  // 片元钩子需要 UV varying：声明 + 顶点着色器赋值
  const hasFragmentHooks = hooks.hooks.some(
    (h) => h.name !== "Vertex" && HOOK_POINTS[h.name],
  );
  const uvVaryingDecl = hasFragmentHooks ? `varying vec2 ${EXT_UV_VARYING};\n` : "";
  const uvVaryingAssign = hasFragmentHooks
    ? `\n${EXT_UV_VARYING} = uv;\n`
    : "";
  // uniform 表持久化在材质 userData 上（渲染循环通过它推进 _Time）
  const table = ensureHookUniformTable(mat);

  return (shader: { vertexShader: string; fragmentShader: string; uniforms: { [k: string]: THREE.IUniform } }) => {
    // uniform 表是唯一事实源：编译前写入的值（.mat 参数/贴图）必须被编译后的
    // 着色器继续引用，故这里把同一批 uniform 对象交给 shader.uniforms，
    // 而不是新建一批（新建会把编译前写入的值丢掉，表现为参数不生效）。
    for (const prop of hooks.properties) {
      const u = table[prop.key] ?? (table[prop.key] = uniformInitialValue(prop));
      shader.uniforms[prop.key] = u;
    }
    const timeUniform = table[TIME_UNIFORM] ?? (table[TIME_UNIFORM] = { value: 0 });
    shader.uniforms[TIME_UNIFORM] = timeUniform;

    // 注入 uniform 声明 + CGINCLUDE + UV varying 声明
    const vertexPrefix = `${decls ? decls + "\n" : ""}${uvVaryingDecl}${includeBlock ? `// CGINCLUDE\n${includeBlock}// ENDCG\n` : ""}`;
    const fragmentPrefix = `${decls ? decls + "\n" : ""}${uvVaryingDecl}${includeBlock ? `// CGINCLUDE\n${includeBlock}// ENDCG\n` : ""}`;
    if (vertexPrefix) shader.vertexShader = `${vertexPrefix}${shader.vertexShader}`;
    if (fragmentPrefix) shader.fragmentShader = `${fragmentPrefix}${shader.fragmentShader}`;

    // 顶点着色器：在 begin_vertex 后赋值 UV varying（与 Vertex 钩子同位置）
    if (uvVaryingAssign) {
      shader.vertexShader = injectAfter(shader.vertexShader, "begin_vertex", uvVaryingAssign.trim());
    }

    // 注入各钩子
    for (const hook of hooks.hooks) {
      const point = HOOK_POINTS[hook.name];
      if (!point) continue;
      const code = assembleHookCode(hook);
      if (!code) continue;
      if (point.shader === "vertex") {
        shader.vertexShader =
          point.position === "after"
            ? injectAfter(shader.vertexShader, point.include, code)
            : injectBefore(shader.vertexShader, point.include, code);
      } else {
        shader.fragmentShader =
          point.position === "after"
            ? injectAfter(shader.fragmentShader, point.include, code)
            : injectBefore(shader.fragmentShader, point.include, code);
      }
    }
  };
}

/** 共享白色 1×1 空贴图 */
let emptyTex: THREE.Texture | null = null;
function emptyTexture(): THREE.Texture {
  if (!emptyTex) {
    const data = new Uint8Array([255, 255, 255, 255]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    emptyTex = tex;
  }
  return emptyTex;
}

/** 贴图异步加载器接口 */
export interface ShaderTextureLoader {
  loadTexture?(rel: string, srgb: boolean): Promise<THREE.Texture | null>;
}

// ---------------------------------------------------------------------------
// 时间 uniform 推进：挂载扩展着色器的材质登记在册，渲染循环每帧统一推进 _Time。
// 材质 dispose（类型切换/场景重建/扩展移除）时自动出册，无需额外生命周期管理。
// ---------------------------------------------------------------------------

const liveHookMaterials = new Set<THREE.Material>();

/** 登记挂载扩展着色器的材质（dispose 时自动移除） */
function registerHookMaterial(mat: THREE.Material): void {
  if (liveHookMaterials.has(mat)) return;
  liveHookMaterials.add(mat);
  mat.addEventListener("dispose", () => liveHookMaterials.delete(mat));
}

/** 从在册表移除（扩展被清除时调用） */
function unregisterHookMaterial(mat: THREE.Material): void {
  liveHookMaterials.delete(mat);
}

/** 渲染循环推进：设置全部在册材质的 _Time（秒） */
export function tickAllHookTime(seconds: number): void {
  if (liveHookMaterials.size === 0) return;
  for (const mat of liveHookMaterials) {
    tickHookTime(mat, seconds);
  }
}

/** 在册材质数量（调试用） */
export function hookMaterialCount(): number {
  return liveHookMaterials.size;
}

/** 应用着色器钩子到材质（注入片段 + 同步 uniform 值） */
export function applyShaderHooks(
  mat: THREE.Material,
  hooks: ShaderHookData | null,
  props: ShaderProps,
  loader?: ShaderTextureLoader,
): void {
  const ud = mat.userData as Record<string, unknown>;
  const sig = hookSignature(hooks);

  // 无钩子 → 清除已有注入
  if (!hooks || hooks.hooks.length === 0) {
    if (ud[HOOK_SIG_KEY]) {
      delete ud[HOOK_SIG_KEY];
      delete ud[HOOK_UNIFORMS_KEY];
      mat.onBeforeCompile = () => {};
      // 交还程序缓存 key 的默认实现（onBeforeCompile.toString()）
      delete (mat as unknown as { customProgramCacheKey?: unknown }).customProgramCacheKey;
      mat.needsUpdate = true;
      unregisterHookMaterial(mat);
    }
    return;
  }

  // 注入内容变化 → 重建 onBeforeCompile + 程序缓存 key
  if (ud[HOOK_SIG_KEY] !== sig) {
    ud[HOOK_SIG_KEY] = sig;
    mat.onBeforeCompile = buildOnBeforeCompile(hooks, mat);
    // 必须自带 cache key：注入函数对所有材质源码文本相同，three 默认取
    // onBeforeCompile.toString() 会算出同一个 key，导致不同钩子集合复用同一条
    // program（后一个材质渲染出前一个材质的效果）。
    mat.customProgramCacheKey = () => sig;
    mat.needsUpdate = true;
    registerHookMaterial(mat);
  }

  // 同步 uniform 值
  const table = ensureHookUniformTable(mat);
  // onBeforeCompile 可能在首次编译时才把 uniform 挂到 shader.uniforms，
  // 但我们也在材质 userData 上维护一份，供渲染循环推进 _Time
  for (const prop of hooks.properties) {
    if (!table[prop.key]) {
      table[prop.key] = uniformInitialValue(prop);
    }
    writeUniformValue(table[prop.key], prop, props[prop.key]);
  }
  if (!table[TIME_UNIFORM]) {
    table[TIME_UNIFORM] = { value: 0 };
  }

  // 贴图异步加载
  for (const prop of hooks.properties) {
    if (prop.kind !== "texture") continue;
    const rel = props[prop.key];
    const u = table[prop.key];
    if (typeof rel === "string" && rel !== "" && loader?.loadTexture) {
      void loader.loadTexture(rel, true).then((tex) => {
        u.value = tex ?? emptyTexture();
      });
    } else if (!u.value) {
      u.value = emptyTexture();
    }
  }
}

/** 推进着色器钩子的 _Time uniform（渲染循环每帧调用） */
export function tickHookTime(mat: THREE.Material, seconds: number): void {
  const table = mat.userData?.[HOOK_UNIFORMS_KEY] as HookUniformTable | undefined;
  const t = table?.[TIME_UNIFORM];
  if (t) t.value = seconds;
}

/** 材质是否挂载了扩展着色器 */
export function hasShaderHooks(mat: THREE.Material): boolean {
  return !!mat.userData?.[HOOK_SIG_KEY];
}