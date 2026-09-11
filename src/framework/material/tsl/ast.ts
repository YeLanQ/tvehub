// ---------------------------------------------------------------------------
// GLSL 受控子集的抽象语法树（AST）类型定义。
//
// 翻译器只覆盖自定义着色器（ShaderLab → three ShaderMaterial）组装产物里的
// 常见写法（模板级子集），不追求完整 GLSL：
// - 局部变量声明（一次赋值，SSA 风格）、赋值、return、if/else、discard；
// - 表达式：数值/布尔字面量、标识符、swizzle、函数调用/类型构造、一元/二元运算；
// 其余（循环、数组、结构体、自定义工具函数、矩阵下标等）在 parser 阶段报错，
// 由 translate 上层回退占位程序并告警。
// ---------------------------------------------------------------------------

/** GLSL 类型名（受控子集关注标量/向量/矩阵；采样器单独标注） */
export type GlslType = string;

/** 表达式节点（判别联合） */
export type Expr =
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "ident"; name: string }
  | { kind: "swizzle"; base: Expr; fields: string }
  | { kind: "call"; name: string; args: Expr[] }
  | { kind: "unary"; op: string; operand: Expr }
  | { kind: "binary"; op: string; left: Expr; right: Expr };

/** 语句节点（判别联合） */
export type Stmt =
  | { kind: "var"; type: GlslType; name: string; init: Expr | null }
  | { kind: "assign"; target: Expr; value: Expr }
  | { kind: "return"; value: Expr | null }
  | { kind: "discard" }
  | { kind: "block"; stmts: Stmt[] }
  | { kind: "if"; cond: Expr; then: Stmt; else: Stmt | null };

/** 函数签名（返回类型 + 名称 + 形参；受控子集支持工具函数带参，入口函数无参） */
export interface GlslFunction {
  returnType: string;
  name: string;
  /** 形参表 [type, name][]（工具函数如 hash(vec2 p) → [["vec2","p"]]；入口函数为空） */
  params: [string, string][];
  body: Stmt;
  /** main 包装器内被调用的入口函数名（仅 name==="main" 时有意义，供 parseStage 定位 entry） */
  entryName?: string | null;
}

/** 顶点/片元分阶段解析结果（入口函数体 + 全局 varying 声明 + 工具函数表） */
export interface StageParse {
  /** 非 main 的入口函数（顶点 = vert、片元 = frag）；缺失 → 翻译失败 */
  entry: GlslFunction | null;
  /** 全局 varying 声明（`varying vec3 vNormalW;` → [type, name]） */
  varyings: [string, string][];
  /** 工具函数（CGINCLUDE 里定义的带参辅助函数，如 hash/noise；供 inline 调用） */
  tools: GlslFunction[];
  /** 解析/结构错误说明（首次致命错误） */
  error: string | null;
}