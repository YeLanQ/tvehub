// ---------------------------------------------------------------------------
// 着色器资产基础类型与约定（framework 层，不依赖 app/api）。
//
// 着色器（.shader）是引擎唯一的"自定义着色"载体：它用 `Base` 声明材质走哪个
// 渲染分支（PBR / Unlit / 卡通，另有两个内置天空程序），用 `Hook` 块在该分支的
// 着色阶段叠加自定义效果。材质（.mat）通过 shader 字段引用一份 .shader 资产，
// 携带分支参数（color/metalness/… 顶字段）与着色器 Properties 值（props 字段）。
// .shader 格式解析/序列化所有权在 Rust（shader_read/shader_write），本模块只收敛
// UI 层需要的约定：kind 取值、显示名、文件名、内置着色器引用。
// ---------------------------------------------------------------------------

import { materialFileStem } from "./types";

/** 着色器资产文件扩展名 */
export const SHADER_EXT = ".shader";

/**
 * 着色器渲染分支（.shader 的 Base 声明；.mat 经引用解析后的分支 key）。
 * physical/unlit/toon 为三个网格渲染出口；天空程序 skyprocedural（大气散射）/
 * skycube（立方体贴图天空盒）是内置资产，由天空材质引用。
 */
export type ShaderKind = "physical" | "unlit" | "toon" | "skyprocedural" | "skycube";

/** 全部合法的渲染分支（注册表顺序 = 新建着色器子菜单 / 下拉展示顺序） */
export const SHADER_KINDS: ShaderKind[] = [
  "physical",
  "unlit",
  "toon",
  "skyprocedural",
  "skycube",
];

/** 着色器渲染分支 → 菜单/下拉显示名 */
const SHADER_KIND_LABELS: Record<ShaderKind, string> = {
  physical: "PBR着色器",
  unlit: "Unlit着色器",
  toon: "卡通着色器",
  skyprocedural: "程序化天空着色器",
  skycube: "立方体天空盒着色器",
};

/** 着色器渲染分支 → 新建资产默认文件名（去重前基名） */
export const SHADER_KIND_STEMS: Record<ShaderKind, string> = {
  physical: "PBR",
  unlit: "Unlit",
  toon: "Toon",
  skyprocedural: "SkyProcedural",
  skycube: "SkyBox",
};

/** 着色器属性类型（Properties 行第二段；与后端 shader.rs 的取值一致） */
export type ShaderPropertyKind =
  | "color"
  | "range"
  | "float"
  | "int"
  | "vector"
  | "texture";

/** 着色器属性（Properties 块一项）→ 材质面板字段 + uniform 声明 */
export interface ShaderPropertyDef {
  /** 属性名（= uniform 名，惯例以 _ 开头） */
  key: string;
  /** 显示名（Properties 行引号内文案） */
  label: string;
  kind: ShaderPropertyKind;
  /** 面板下界（range 用声明值；float/int 为宽松范围；颜色/贴图缺省） */
  min?: number;
  max?: number;
  /** 默认值：color → RGB hex 数字、range/float/int → 数字、vector → [x,y,z,w]、texture → "" */
  default: number | number[] | string;
}

/** 效果片段（.shader 的 Hook 块） */
export interface ShaderHook {
  /** 钩子名（Vertex/Normal/Diffuse/Emissive/Fragment） */
  name: string;
  /** 钩子体 GLSL 代码（注入到内置着色器对应阶段） */
  code: string;
}

/** 解析后的着色器文档（后端 shader_read 返回形态） */
export interface ShaderDoc {
  name: string;
  /** 渲染分支（由 Base 或天空标签判别） */
  kind: ShaderKind;
  /** 着色器源码全文（ShaderLab 风格；检查器/源码编辑器展示用） */
  source: string;
  /** Base 声明原文（PBR/Unlit/Toon；天空程序为空串） */
  base: string;
  /** CGINCLUDE 共享代码（inline 到各钩子之前） */
  include: string;
  /** 效果片段（空表 = 只选分支，不叠效果） */
  hooks: ShaderHook[];
  /** 暴露给材质面板的属性（值存 .mat 的 props；天空程序为空表） */
  properties: ShaderPropertyDef[];
  /** 解析错误（null = 无错误；非 null 时仍按 Base 分支渲染，只是不叠效果） */
  error: string | null;
  /** 缺 Base 时的建议值（按旧版 pragma 推断；空串 = 无需建议）——「补上 Base」一键迁移用 */
  suggestedBase: string;
}

/** 各渲染分支支持的钩子（three 内置着色器的注入点差异；与后端 hook_support 一致） */
export const SHADER_HOOKS_BY_KIND: Record<string, string[]> = {
  physical: ["Vertex", "Normal", "Diffuse", "Emissive", "Fragment"],
  toon: ["Vertex", "Normal", "Diffuse", "Emissive", "Fragment"],
  unlit: ["Vertex", "Diffuse", "Fragment"],
};

/** 着色器种类显示名（未知 kind 回退原值展示，便于排查脏数据） */
export function shaderKindLabel(kind: string): string {
  return SHADER_KIND_LABELS[kind as ShaderKind] ?? kind;
}

/** 任意来源 → 合法着色器种类（未知/缺失回退 physical） */
export function normalizeShaderKind(v: unknown): ShaderKind {
  return SHADER_KINDS.includes(v as ShaderKind) ? (v as ShaderKind) : "physical";
}

/** 编辑器内置着色器目录（相对路径，根为 "internal/"） */
export const INTERNAL_SHADER_ROOT = "internal/shaders";

/** 内置着色器引用（新建材质默认挂 PBR；天空材质分别挂两个天空程序） */
export const DEFAULT_SHADER_RELS: Record<ShaderKind, string> = {
  physical: `${INTERNAL_SHADER_ROOT}/PBR.shader`,
  unlit: `${INTERNAL_SHADER_ROOT}/Unlit.shader`,
  toon: `${INTERNAL_SHADER_ROOT}/Toon.shader`,
  skyprocedural: `${INTERNAL_SHADER_ROOT}/SkyProcedural.shader`,
  skycube: `${INTERNAL_SHADER_ROOT}/SkyBox.shader`,
};

/** 默认着色器引用（材质缺失/未知 shader 时的回退） */
export const DEFAULT_SHADER_REL = DEFAULT_SHADER_RELS.physical;

/** 天空材质种类（.mat 的 kind 字段取值；与 ShaderKind 的 skyprocedural/skycube 对应） */
export type SkyMaterialKind = "procedural" | "cube";

/**
 * 天空着色器引用判定 → 天空材质种类（非天空着色器返回 null）。
 * 天空材质（.mat）与网格材质的区别**只在于 shader 字段引用的是哪份着色器**，
 * 因此这里按引用精确判定，不能用「是不是 .shader 引用」之类的宽松条件
 * （否则任何挂 .shader 的材质都会被误判成天空材质）：
 * - 新格式：引用天空着色器资产——按**文件名**精确匹配 SkyProcedural.shader / SkyBox.shader
 *   （同目录/别处的 MySkyBox.shader、SkyBoxes.shader 之类不匹配）；
 * - 旧格式：魔法串 "SkyProcedural" / "SkyBox"（早期内部实现，兼容读取）。
 */
export function skyKindOfShaderRef(shader: string): SkyMaterialKind | null {
  const ref = shader.trim();
  if (!ref) return null;
  if (ref === "SkyProcedural" || ref === "SkyBox") {
    return ref === "SkyProcedural" ? "procedural" : "cube";
  }
  const base = ref.split("/").pop() ?? ref;
  if (base === "SkyProcedural.shader") return "procedural";
  if (base === "SkyBox.shader") return "cube";
  return null;
}

/** 着色器资产相对路径 → 文件名（去扩展名） */
export function shaderFileStem(rel: string): string {
  return materialFileStem(rel);
}

/**
 * 旧版着色器迁移（纯文本手术）：在 Shader 块的开括号后插入一行 `Base "…"`，
 * 其余内容原样保留。用于「补上 Base」一键迁移——旧版（pragma 型）着色器缺少
 * Base 声明，补上后即可继续渲染原分支并在其上叠加 Hook。
 * 找不到 Shader 块/开括号时返回 null（调用方提示失败，不写盘）。
 */
export function insertBaseDeclaration(source: string, base: string): string | null {
  const value = base.trim();
  if (!value) return null;
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const braceAt = lines.findIndex((l) => l.trim() === "{");
  const shaderAt = lines.findIndex((l) => l.trim().startsWith("Shader "));
  const at = braceAt >= 0 ? braceAt + 1 : shaderAt + 1;
  if (at <= 0 || at > lines.length) return null;
  lines.splice(at, 0, `    Base "${value}"`);
  return lines.join("\n");
}
