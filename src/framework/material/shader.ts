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
 * PreviewType=Skybox 标签识别，供天空材质（.mat）引用；
 * custom 为自定义着色器（GLSL 顶点/片元源码真正编译为 three ShaderMaterial，
 * 属性经 Properties 暴露给材质面板，见 customShader.ts）。
 */
export type ShaderKind =
  | "physical"
  | "unlit"
  | "toon"
  | "custom"
  | "skyprocedural"
  | "skycube";

/** 全部合法的着色器种类（注册表顺序 = 新建着色器子菜单 / 下拉展示顺序） */
export const SHADER_KINDS: ShaderKind[] = [
  "physical",
  "unlit",
  "toon",
  "custom",
  "skyprocedural",
  "skycube",
];

/** 自定义着色器种类 key（挂载它的材质按 ShaderMaterial 渲染） */
export const CUSTOM_SHADER_KIND: ShaderKind = "custom";

/** 着色器种类 → 菜单/下拉显示名 */
const SHADER_KIND_LABELS: Record<ShaderKind, string> = {
  physical: "PBR着色器",
  unlit: "Unlit着色器",
  toon: "卡通着色器",
  custom: "自定义着色器",
  skyprocedural: "程序化天空着色器",
  skycube: "立方体天空盒着色器",
};

/** 着色器种类 → 新建资产默认文件名（去重前基名） */
export const SHADER_KIND_STEMS: Record<ShaderKind, string> = {
  physical: "PBR",
  unlit: "Unlit",
  toon: "Toon",
  custom: "Custom",
  skyprocedural: "SkyProcedural",
  skycube: "SkyBox",
};

/** 自定义着色器属性类型（Properties 行第二段；与后端 shader.rs 的取值一致） */
export type ShaderPropertyKind =
  | "color"
  | "range"
  | "float"
  | "int"
  | "vector"
  | "texture";

/** 自定义着色器暴露的属性（Properties 块一项）→ 材质面板字段 + 自动 uniform 声明 */
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

/** 自定义着色器渲染状态（Tags/ZWrite/Cull 声明） */
export interface CustomShaderState {
  /** 半透明混合（Queue/RenderType = Transparent） */
  transparent: boolean;
  /** 深度写入（ZWrite Off 关闭） */
  depthWrite: boolean;
  /** 面剔除：front（缺省）/ back（Cull Front）/ double（Cull Off） */
  side: "front" | "back" | "double";
}

/** 组装后的自定义着色器程序（标题为 three ShaderMaterial 的顶点/片元源码） */
export interface CustomShaderProgram {
  vertex: string;
  fragment: string;
  state: CustomShaderState;
}

/** 解析后的着色器文档（后端 shader_read 返回形态） */
export interface ShaderDoc {
  name: string;
  kind: ShaderKind;
  /** 着色器源码全文（ShaderLab 风格；检查器/源码编辑器展示用） */
  source: string;
  /** 自定义着色器（kind=custom）暴露的属性（材质面板字段；其它种类为空表） */
  properties: ShaderPropertyDef[];
  /** 自定义着色器组装后的程序（顶点/片元源码 + 渲染状态）；不可组装/非自定义时为 null */
  program: CustomShaderProgram | null;
  /** 自定义着色器组装失败原因（null = 无错误） */
  error: string | null;
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
  custom: `${INTERNAL_SHADER_ROOT}/Custom.shader`,
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
