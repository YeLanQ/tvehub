// ---------------------------------------------------------------------------
// GLSL → TSL 转译器（编辑器侧，供 WebGPU 后端渲染自定义着色器）。
// 导出：词法/语法/转译三个层次，承载层（customNodeMaterial.ts）只依赖
// translateProgram + TslFnLib 类型。
// ---------------------------------------------------------------------------

export { tokenize, type GlslToken, type GlslTokenType } from "./glslLexer";
export { parseStage, TranslateError } from "./glslParser";
export type { Expr, GlslFunction, StageParse, Stmt, GlslType } from "./ast";
export {
  translateProgram,
  type TslFnLib,
  type TslNode,
  type TranslatedProgram,
  type TranslateInput,
} from "./glslToTsl";