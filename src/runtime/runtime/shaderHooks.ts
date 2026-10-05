// 着色器 Hook 注入（预览/运行时侧）：把 .shader 的 Hook 片段注入到内置 PBR/Toon/Unlit 材质。
// 与编辑器 src/framework/material/shaderHooks.ts 同范式双份实现：
// - WebGL 后端：onBeforeCompile 字符串替换，把钩子 GLSL 注入到 #include <chunk> 处
// - WebGPU/TSL 后端：暂占位（后续用 TSL 节点组合实现）
import * as THREE from "../core/three.module.min.js";
import type { ShaderHook, ShaderProp } from "./shader";

const TIME_UNIFORM = "_Time";
const EXT_UV_VARYING = "vExtUv";
const HOOK_SIG_KEY = "__tveHookSig";
const HOOK_UNIFORMS_KEY = "__tveHookUniforms";

/** Hook 注入点（内置着色器 chunk 锚位与变量映射） */
interface HookPoint {
  shader: "vertex" | "fragment";
  include: string;
  position: "before" | "after";
  varMap: Record<string, string>;
  prelude?: string;
}

const HOOK_POINTS: Record<string, HookPoint> = {
  Vertex: {
    shader: "vertex",
    include: "begin_vertex",
    position: "after",
    varMap: { position: "transformed" },
  },
  Normal: {
    shader: "fragment",
    include: "normal_fragment_maps",
    position: "after",
    varMap: { uv: EXT_UV_VARYING },
    prelude: "vec3 viewDir = normalize(vViewPosition);",
  },
  Diffuse: {
    shader: "fragment",
    include: "color_fragment",
    position: "after",
    varMap: { uv: EXT_UV_VARYING },
    prelude: "vec3 viewDir = normalize(vViewPosition);",
  },
  Emissive: {
    shader: "fragment",
    include: "emissivemap_fragment",
    position: "after",
    varMap: { emissive: "totalEmissiveRadiance", uv: EXT_UV_VARYING },
    prelude: "vec3 viewDir = normalize(vViewPosition);",
  },
  Fragment: {
    shader: "fragment",
    include: "dithering_fragment",
    position: "before",
    varMap: { fragColor: "gl_FragColor", uv: EXT_UV_VARYING },
    prelude: "vec3 viewDir = normalize(vViewPosition);",
  },
};

/** .shader 解析结果中被注入消费的子集（shader.ts parseShader 输出） */
interface ShaderExt {
  hooks: ShaderHook[];
  properties: ShaderProp[];
  base: string;
  include: string;
}

/** 钩子 uniform 对象（three IUniform 的强类型视图） */
interface TveUniform {
  value: unknown;
}

/** 材质 userData 上的钩子 uniform 表 */
type TveUniformTable = Record<string, TveUniform>;

/** 贴图加载面（applyShaderHooks 异步贴图回填用） */
interface ShaderTexLoader {
  loadTexture?(rel: string, srgb: boolean): Promise<THREE.Texture | null>;
}

function remapVars(code: string, varMap: Record<string, string>): string {
  let result = code;
  for (const [src, dst] of Object.entries(varMap)) {
    if (src === dst) continue;
    result = result.replace(new RegExp(`\\b${src}\\b`, "g"), dst);
  }
  return result;
}

/** 轻量文本哈希（djb2；只用于变更检测与程序缓存 key） */
function hashText(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/**
 * 注入内容签名：钩子全文（哈希）+ CGINCLUDE + 属性集合（键 + 类型）。
 * 内容敏感是必需的：它同时用于变更检测与 customProgramCacheKey——注入函数对所有
 * 材质源码文本相同，three 默认取 onBeforeCompile.toString() 会算出同一个 key，
 * 不同钩子集合会复用同一条 program（后一个材质渲染出前一个材质的效果）。
 * 属性「值」不参与：值走 uniform，改值不应触发重编。
 */
function hookSignature(ext: ShaderExt | null): string {
  if (!ext) return "";
  const hookSig = ext.hooks.map((h) => `${h.name}:${hashText(h.code)}`).join("|");
  const propSig = ext.properties.map((p) => `${p.key}:${p.kind}`).join(",");
  return `${ext.base}#${hookSig}#${propSig}#${hashText(ext.include)}`;
}

function uniformInitialValue(prop: ShaderProp): TveUniform {
  switch (prop.kind) {
    case "color": {
      const hex = typeof prop.default === "number" ? prop.default : 0xffffff;
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

function writeUniformValue(uniform: TveUniform, prop: ShaderProp, raw: unknown): void {
  const v = raw ?? prop.default;
  switch (prop.kind) {
    case "color": {
      const hex = typeof v === "number" ? v : 0xffffff;
      const c = new THREE.Color().setHex(hex & 0xffffff);
      // color 属性 uniform 初值即 Vector4，此处断言安全
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
 * 每个 Hook 包在独立块作用域里：同一着色器的多个 Hook 注入到同一段 GLSL，
 * 各自声明的局部变量（含 viewDir 前言）不加隔离会互相重定义
 * （典型报错：'viewDir' : redefinition / 'n' : redefinition）。
 * Hook 之间通过端口变量通信，不共享局部变量。
 */
function assembleHookCode(hook: ShaderHook): string {
  const point = HOOK_POINTS[hook.name];
  if (!point) return "";
  const prelude = point.prelude ? point.prelude + "\n" : "";
  const userCode = remapVars(hook.code, point.varMap);
  return "{\n" + prelude + userCode + "\n}";
}

function uniformDeclarations(ext: ShaderExt, hookNames: Set<string>): string {
  const lines: string[] = [];
  for (const prop of ext.properties) {
    const ty = prop.kind === "color" || prop.kind === "vector" ? "vec4" : prop.kind === "texture" ? "sampler2D" : "float";
    lines.push(`uniform ${ty} ${prop.key};`);
  }
  if (hookNames.size > 0) {
    lines.push(`uniform float ${TIME_UNIFORM};`);
  }
  return lines.join("\n");
}

function injectAfter(shader: string, chunk: string, code: string): string {
  const tag = `#include <${chunk}>`;
  const idx = shader.indexOf(tag);
  if (idx < 0) return shader;
  return shader.slice(0, idx + tag.length) + "\n" + code + "\n" + shader.slice(idx + tag.length);
}

function injectBefore(shader: string, chunk: string, code: string): string {
  const tag = `#include <${chunk}>`;
  const idx = shader.indexOf(tag);
  if (idx < 0) return shader;
  return shader.slice(0, idx) + code + "\n" + shader.slice(idx);
}

function ensureUniformTable(mat: THREE.Material): TveUniformTable {
  const ud = mat.userData as Record<string, unknown>;
  let table = ud[HOOK_UNIFORMS_KEY] as TveUniformTable | undefined;
  if (!table) {
    table = {};
    ud[HOOK_UNIFORMS_KEY] = table;
  }
  return table;
}

// 在册钩子材质（每帧推进 _Time；材质释放时自动出册）
const liveHookMaterials = new Set<THREE.Material>();

function registerHookMaterial(mat: THREE.Material): void {
  if (liveHookMaterials.has(mat)) return;
  liveHookMaterials.add(mat);
  mat.addEventListener("dispose", () => liveHookMaterials.delete(mat));
}

function unregisterHookMaterial(mat: THREE.Material): void {
  liveHookMaterials.delete(mat);
}

/** 渲染循环推进：设置全部在册钩子材质的 _Time（秒） */
export function tickAllHookTime(seconds: number): void {
  if (liveHookMaterials.size === 0) return;
  for (const mat of liveHookMaterials) {
    const table = (mat.userData as Record<string, unknown> | undefined)?.[
      HOOK_UNIFORMS_KEY
    ] as TveUniformTable | undefined;
    const t = table?.[TIME_UNIFORM];
    if (t) t.value = seconds;
  }
}

function buildOnBeforeCompile(ext: ShaderExt, mat: THREE.Material): (shader: THREE.WebGLProgramParametersWithUniforms) => void {
  const hookNames = new Set(ext.hooks.map((h) => h.name));
  const decls = uniformDeclarations(ext, hookNames);
  const includeBlock = ext.include ? `\n${ext.include}\n` : "";
  const hasFragmentHooks = ext.hooks.some((h) => h.name !== "Vertex" && HOOK_POINTS[h.name]);
  const uvVaryingDecl = hasFragmentHooks ? `varying vec2 ${EXT_UV_VARYING};\n` : "";
  const uvVaryingAssign = hasFragmentHooks ? `\n${EXT_UV_VARYING} = uv;\n` : "";
  const table = ensureUniformTable(mat);

  return (shader) => {
    // uniform 表是唯一事实源：编译前写入的值（.mat 参数/贴图）必须被编译后的
    // 着色器继续引用，故这里把同一批 uniform 对象交给 shader.uniforms，
    // 而不是新建一批（新建会把编译前写入的值丢掉，表现为参数不生效）。
    for (const prop of ext.properties) {
      const u = table[prop.key] ?? (table[prop.key] = uniformInitialValue(prop));
      shader.uniforms[prop.key] = u;
    }
    const timeUniform = table[TIME_UNIFORM] ?? (table[TIME_UNIFORM] = { value: 0 });
    shader.uniforms[TIME_UNIFORM] = timeUniform;

    const vertexPrefix = (decls ? decls + "\n" : "") + uvVaryingDecl + (includeBlock ? `// CGINCLUDE\n${includeBlock}// ENDCG\n` : "");
    const fragmentPrefix = (decls ? decls + "\n" : "") + uvVaryingDecl + (includeBlock ? `// CGINCLUDE\n${includeBlock}// ENDCG\n` : "");
    if (vertexPrefix) shader.vertexShader = vertexPrefix + shader.vertexShader;
    if (fragmentPrefix) shader.fragmentShader = fragmentPrefix + shader.fragmentShader;

    if (uvVaryingAssign) {
      shader.vertexShader = injectAfter(shader.vertexShader, "begin_vertex", uvVaryingAssign.trim());
    }

    for (const hook of ext.hooks) {
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
let emptyTex: THREE.DataTexture | null = null;
function emptyTexture(): THREE.DataTexture {
  if (!emptyTex) {
    const data = new Uint8Array([255, 255, 255, 255]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    emptyTex = tex;
  }
  return emptyTex;
}

/** 应用着色器钩子到材质（注入片段 + 同步 uniform 值） */
export function applyShaderHooks(
  mat: THREE.Material,
  ext: ShaderExt | null,
  props: Record<string, unknown> | undefined,
  loader?: ShaderTexLoader,
): void {
  const ud = mat.userData as Record<string, unknown>;
  const sig = hookSignature(ext);

  if (!ext || ext.hooks.length === 0) {
    if (ud[HOOK_SIG_KEY]) {
      delete ud[HOOK_SIG_KEY];
      delete ud[HOOK_UNIFORMS_KEY];
      mat.onBeforeCompile = () => {};
      // 交还程序缓存 key 的默认实现（onBeforeCompile.toString()）
      delete (mat as { customProgramCacheKey?: unknown }).customProgramCacheKey;
      mat.needsUpdate = true;
      unregisterHookMaterial(mat);
    }
    return;
  }

  if (ud[HOOK_SIG_KEY] !== sig) {
    ud[HOOK_SIG_KEY] = sig;
    mat.onBeforeCompile = buildOnBeforeCompile(ext, mat);
    // 必须自带 cache key：注入函数对所有材质源码文本相同，three 默认取
    // onBeforeCompile.toString() 会算出同一个 key，导致不同钩子集合复用同一条
    // program（后一个材质渲染出前一个材质的效果）。
    mat.customProgramCacheKey = () => sig;
    mat.needsUpdate = true;
    registerHookMaterial(mat);
  }

  const table = ensureUniformTable(mat);
  for (const prop of ext.properties) {
    if (!table[prop.key]) {
      table[prop.key] = uniformInitialValue(prop);
    }
    writeUniformValue(table[prop.key], prop, props ? props[prop.key] : undefined);
  }
  if (!table[TIME_UNIFORM]) {
    table[TIME_UNIFORM] = { value: 0 };
  }

  // 贴图异步加载
  for (const prop of ext.properties) {
    if (prop.kind !== "texture") continue;
    const rel = props ? props[prop.key] : undefined;
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

/** 材质是否挂载了着色器钩子 */
export function hasShaderHooks(mat: THREE.Material): boolean {
  return !!(mat.userData as Record<string, unknown> | undefined)?.[HOOK_SIG_KEY];
}
