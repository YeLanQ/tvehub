// ---------------------------------------------------------------------------
// 着色器资产基础类型与约定（framework 层，不依赖 app/api）。
//
// 着色器与材质分离：着色器（.shader）是"渲染程序"资产，决定网格用哪种
// three 材质分支渲染（PBR/Unlit/卡通）以及材质暴露哪些参数分组；
// 材质（.mat）是"数据"资产，通过 shader 字段引用一份 .shader 资产并携带参数值。
// .shader 格式解析/序列化所有权在 Rust（shader_read/shader_write），本模块
// 只收敛 UI 层需要的约定：kind 取值、显示名、文件名、内置着色器引用。
// ---------------------------------------------------------------------------

import { materialFileStem } from "./types";

/** 着色器资产文件扩展名 */
export const SHADER_EXT = ".shader";

/**
 * 着色器种类（.shader 的 kind 字段；.mat 经引用解析后的渲染分支 key）。
 * 取值与旧 .mat materialType 字段一致（physical/unlit/toon），渲染端
 * （工厂注册表 / 网页预览 mesh.mjs）按同一 key 分派；
 * 天空程序 skyprocedural（大气散射）/ skycube（立方体贴图天空盒）由
 * PreviewType=Skybox 标签识别，供天空材质（.mat）引用。
 */
export type ShaderKind =
  | "physical"
  | "unlit"
  | "toon"
  | "skyprocedural"
  | "skycube";

/** 全部合法的着色器种类（注册表顺序 = 新建着色器子菜单 / 下拉展示顺序） */
export const SHADER_KINDS: ShaderKind[] = [
  "physical",
  "unlit",
  "toon",
  "skyprocedural",
  "skycube",
];

/** 着色器种类 → 菜单/下拉显示名 */
const SHADER_KIND_LABELS: Record<ShaderKind, string> = {
  physical: "PBR着色器",
  unlit: "Unlit着色器",
  toon: "卡通着色器",
  skyprocedural: "程序化天空着色器",
  skycube: "立方体天空盒着色器",
};

/** 着色器种类 → 新建资产默认文件名（去重前基名） */
export const SHADER_KIND_STEMS: Record<ShaderKind, string> = {
  physical: "PBR",
  unlit: "Unlit",
  toon: "Toon",
  skyprocedural: "SkyProcedural",
  skycube: "SkyBox",
};

/** 解析后的着色器文档（后端 shader_read 返回形态） */
export interface ShaderDoc {
  name: string;
  kind: ShaderKind;
  /** 着色器源码全文（Unity ShaderLab 风格；检查器内容展示用） */
  source: string;
}

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

/** 着色器资产相对路径 → 文件名（去扩展名） */
export function shaderFileStem(rel: string): string {
  return materialFileStem(rel);
}
