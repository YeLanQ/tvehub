// ---------------------------------------------------------------------------
// GLSL（受控子集）→ TSL 转译：把自定义着色器的顶点/片元源码翻译成 three 的
// TSL（Three Shading Language）节点回调体，供 WebGPU 后端的 NodeMaterial 使用。
//
// 设计要点（对齐 particleNodeMaterial.ts 的“最小结构声明 + 断言”哲学）：
// - 本模块不 import three/tsl（其类型不完整），而是通过注入的 TslFnLib 接口
//   构造节点，运行时由承载层（customNodeMaterial.ts）以动态 import 的真实库传入；
// - 节点以不透明类型 TslNode（any）传递，翻译结果是一组「回调体」——
//   承载层用 tsl.Fn(body)() 挂到 NodeMaterial.vertexNode / fragmentNode；
// - 内置矩阵/属性按 three 命名映射（gl_Position 是顶点回调的返回值；
//   projectionMatrix→cameraProjectionMatrix、viewMatrix→cameraViewMatrix、
//   modelMatrix→modelWorldMatrix、normalMatrix→modelNormalMatrix、position→positionLocal）；
// - 受控子集之外的语法在 parser 已抛 TranslateError，此处捕获后回退占位程序。
// ---------------------------------------------------------------------------

import type { Expr, GlslFunction, StageParse, Stmt } from "./ast";
import { parseStage, TranslateError, HOOK_ENTRY_NAME } from "./glslParser";

/** TSL 节点（运行时为 three 节点对象；不透明传递，避免被不完整类型绑住） */
export type TslNode = any;

/**
 * 注入的 TSL 函数库（承载层以 three/tsl 实现，测试以 mock 实现）。
 * 只声明转译器用到的入口；返回值/参数统一 TslNode 以跳过类型噪音。
 */
export interface TslFnLib {
  // uniform（承载层用它创建/改写 uniform 节点；translate 不直接调用）
  uniform(value: unknown): TslNode;
  // 类型构造
  float(x?: unknown): TslNode;
  int(x?: unknown): TslNode;
  uint(x?: unknown): TslNode;
  bool(x?: unknown): TslNode;
  vec2(...a: unknown[]): TslNode;
  vec3(...a: unknown[]): TslNode;
  vec4(...a: unknown[]): TslNode;
  bvec2?(...a: unknown[]): TslNode;
  bvec3?(...a: unknown[]): TslNode;
  bvec4?(...a: unknown[]): TslNode;
  ivec2?(...a: unknown[]): TslNode;
  ivec3?(...a: unknown[]): TslNode;
  ivec4?(...a: unknown[]): TslNode;
  mat2?(...a: unknown[]): TslNode;
  mat3(...a: unknown[]): TslNode;
  mat4(...a: unknown[]): TslNode;
  // 运算符
  add(a: unknown, b: unknown): TslNode;
  sub(a: unknown, b: unknown): TslNode;
  mul(a: unknown, b: unknown): TslNode;
  div(a: unknown, b: unknown): TslNode;
  negate(a: unknown): TslNode;
  and(a: unknown, b: unknown): TslNode;
  or(a: unknown, b: unknown): TslNode;
  not(a: unknown): TslNode;
  equal(a: unknown, b: unknown): TslNode;
  notEqual(a: unknown, b: unknown): TslNode;
  lessThan(a: unknown, b: unknown): TslNode;
  lessThanEqual(a: unknown, b: unknown): TslNode;
  greaterThan(a: unknown, b: unknown): TslNode;
  greaterThanEqual(a: unknown, b: unknown): TslNode;
  // 数学（常用子集）
  mix(a: unknown, b: unknown, t: unknown): TslNode;
  clamp(x: unknown, lo: unknown, hi: unknown): TslNode;
  min(a: unknown, b: unknown): TslNode;
  max(a: unknown, b: unknown): TslNode;
  abs(a: unknown): TslNode;
  sign(a: unknown): TslNode;
  floor(a: unknown): TslNode;
  ceil(a: unknown): TslNode;
  fract(a: unknown): TslNode;
  round(a: unknown): TslNode;
  mod(a: unknown, b: unknown): TslNode;
  pow(a: unknown, b: unknown): TslNode;
  exp(a: unknown): TslNode;
  exp2(a: unknown): TslNode;
  log(a: unknown): TslNode;
  log2(a: unknown): TslNode;
  sqrt(a: unknown): TslNode;
  inversesqrt(a: unknown): TslNode;
  sin(a: unknown): TslNode;
  cos(a: unknown): TslNode;
  tan(a: unknown): TslNode;
  asin(a: unknown): TslNode;
  acos(a: unknown): TslNode;
  atan(a: unknown): TslNode;
  atan2(y: unknown, x: unknown): TslNode;
  sinh(a: unknown): TslNode;
  cosh(a: unknown): TslNode;
  tanh(a: unknown): TslNode;
  degrees(a: unknown): TslNode;
  radians(a: unknown): TslNode;
  length(a: unknown): TslNode;
  distance(a: unknown, b: unknown): TslNode;
  dot(a: unknown, b: unknown): TslNode;
  cross(a: unknown, b: unknown): TslNode;
  normalize(a: unknown): TslNode;
  reflect(i: unknown, n: unknown): TslNode;
  refract(i: unknown, n: unknown, eta: unknown): TslNode;
  step(edge: unknown, x: unknown): TslNode;
  smoothstep(lo: unknown, hi: unknown, x: unknown): TslNode;
  // 纹理
  texture(tex: unknown, uv: unknown): TslNode;
  textureSize?(tex: unknown, level?: unknown): TslNode;
  // varying / 控制流
  varying(node: TslNode, name?: string): TslNode;
  If(cond: TslNode, then: () => void, els?: () => void): TslNode;
  Fn(body: (...args: unknown[]) => TslNode): TslNode;
  Return(node?: TslNode): TslNode;
  Discard(): TslNode;
  // 内置节点（constant / 访问器）
  positionLocal: TslNode;
  /** 视空间位置（-positionView ≈ GL 的 vViewPosition） */
  positionView: TslNode;
  /** 基色 × 贴图（= GL 注入点 diffuseColor.rgb 的种子） */
  materialColor: TslNode;
  /** 当前不透明度（含 alphaMap；= diffuseColor.a 的种子） */
  materialOpacity: TslNode;
  /** 自发光 × 强度 × 贴图（= GL 的 totalEmissiveRadiance 种子） */
  materialEmissive: TslNode;
  /** 视空间法线（含法线贴图；= GL 片元阶段的 normal） */
  normalView: TslNode;
  normalLocal: TslNode;
  positionWorld: TslNode;
  normalWorld: TslNode;
  modelWorldMatrix: TslNode;
  modelViewMatrix: TslNode;
  cameraViewMatrix: TslNode;
  cameraProjectionMatrix: TslNode;
  cameraPosition: TslNode;
  modelNormalMatrix: TslNode;
  uv(): TslNode;
}

/** GLSL 内置标识符 → tsl 内置节点属性名（同名函数/节点映射表） */
const BUILTIN_IDENT: Record<string, keyof TslFnLib> = {
  position: "positionLocal",
  normal: "normalLocal",
  modelMatrix: "modelWorldMatrix",
  modelViewMatrix: "modelViewMatrix",
  viewMatrix: "cameraViewMatrix",
  projectionMatrix: "cameraProjectionMatrix",
  cameraPosition: "cameraPosition",
  normalMatrix: "modelNormalMatrix",
};

/** GLSL 类型构造器名集合 → tsl 类型构造方法名（同名，仅作识别白名单） */
const TYPE_CONSTRUCTORS = new Set([
  "float", "int", "uint", "bool", "vec2", "vec3", "vec4",
  "bvec2", "bvec3", "bvec4", "ivec2", "ivec3", "ivec4", "mat2", "mat3", "mat4",
]);

/** GLSL 采样函数名 → tsl.texture（texture2D / textureCube 等旧写法归一） */
const SAMPLE_FUNCS = new Set(["texture", "texture2D", "textureCube"]);

/** GLSL 内置函数 → tsl 函数名（多数同名；缺额在此展开） */
const FUNC_MAP: Record<string, string> = {
  mix: "mix", clamp: "clamp", min: "min", max: "max", abs: "abs", sign: "sign",
  floor: "floor", ceil: "ceil", fract: "fract", round: "round", mod: "mod",
  pow: "pow", exp: "exp", exp2: "exp2", log: "log", log2: "log2", sqrt: "sqrt",
  inversesqrt: "inversesqrt", sin: "sin", cos: "cos", tan: "tan", asin: "asin",
  acos: "acos", atan: "atan", atan2: "atan2", sinh: "sinh", cosh: "cosh",
  tanh: "tanh", degrees: "degrees", radians: "radians", length: "length",
  distance: "distance", dot: "dot", cross: "cross", normalize: "normalize",
  reflect: "reflect", refract: "refract", step: "step", smoothstep: "smoothstep",
};

/** 二元运算符 → tsl 函数名 */
const BINARY_OPS: Record<string, string> = {
  "+": "add", "-": "sub", "*": "mul", "/": "div",
  "==": "equal", "!=": "notEqual", "<": "lessThan", "<=": "lessThanEqual",
  ">": "greaterThan", ">=": "greaterThanEqual", "&&": "and", "||": "or",
};

/** varying 声明类型 → 初始化空节点构造名 */
const VARYING_INIT: Record<string, keyof TslFnLib> = {
  vec2: "vec2", vec3: "vec3", vec4: "vec4", float: "float", int: "int", uint: "uint",
  bool: "bool", ivec2: "ivec2", ivec3: "ivec3", ivec4: "ivec4",
  bvec2: "bvec2", bvec3: "bvec3", bvec4: "bvec4",
};

/** 转译阶段上下文（本地变量 / varying / uniform / 内置 / 工具函数 的解析命名空间） */
interface GenContext {
  tsl: TslFnLib;
  locals: Map<string, TslNode>;
  varyings: Map<string, TslNode>;
  uniforms: Record<string, TslNode>;
  timeNode: TslNode;
  /** 工具函数表（name → 声明），genCall 遇自定义函数时 inline 展开 */
  tools: Map<string, GlslFunction>;
  /** 额外标识符 → 节点（优先级低于 locals/varyings/uniforms，高于内置表）：
   *  Hook 端口语义里的 normal（视空间法线）/ viewDir（视空间视线）在此注入 */
  idents?: Record<string, TslNode>;
}

/** 语句生成过程中的控制流状态（return 提前终止 + 返回值） */
interface GenState {
  earlyReturn: boolean;
  returnValue: TslNode | null;
}

/** 局部变量是否包成可写节点（.toVar()）：Hook 片段常常"声明后再赋值"
 * （如 `float scan = sin(...); scan = scan * 0.5 + 0.5;`），必须可 assign */
let varAsWritable = false;

/**
 * 阶段源码 → TSL 节点：在 tsl.Fn 回调内执行语句生成（assign/If/Discard 等控制流
 * 节点依赖 Fn 的 stack，必须在回调内调用）。失败抛 TranslateError，由上层捕获。
 */
function compileStageNode(stage: StageParse, ctx: GenContext): TslNode {
  if (!stage.entry) {
    throw new TranslateError("未找到入口函数（CGPROGRAM 缺 #pragma vertex/fragment 对应函数体）");
  }
  const entryBody = stage.entry.body;
  return ctx.tsl.Fn(() => {
    const state: GenState = { earlyReturn: false, returnValue: null };
    genStmts(entryBody, { ...ctx, locals: new Map() }, state);
    return state.returnValue;
  })();
}

/** 解析单个标识符到 TSL 节点（locals > varyings > uniforms > idents > 内置；_Time 特判） */
function resolveIdent(name: string, ctx: GenContext): TslNode {
  if (name === "_Time") return ctx.timeNode;
  if (ctx.locals.has(name)) return ctx.locals.get(name);
  if (ctx.varyings.has(name)) return ctx.varyings.get(name);
  if (name in ctx.uniforms) return ctx.uniforms[name];
  if (ctx.idents && name in ctx.idents) return ctx.idents[name];
  if (name in BUILTIN_IDENT) return ctx.tsl[BUILTIN_IDENT[name]] as TslNode;
  if (name === "uv") return ctx.tsl.uv();
  if (name.startsWith("gl_")) {
    throw new TranslateError(`内置变量 ${name} 不能作为表达式值使用（仅 gl_Position 可作为赋值目标）`);
  }
  throw new TranslateError(`未知标识符 '${name}'（非 varying/uniform/内置变量，且工具函数不在受控子集内）`);
}

function genExpr(e: Expr, ctx: GenContext): TslNode {
  const tsl = ctx.tsl;
  switch (e.kind) {
    case "number":
      return tsl.float(e.value);
    case "bool":
      return tsl.bool(e.value);
    case "ident":
      return resolveIdent(e.name, ctx);
    case "swizzle": {
      const base = genExpr(e.base, ctx);
      return base[e.fields];
    }
    case "unary": {
      const operand = genExpr(e.operand, ctx);
      if (e.op === "-") return tsl.negate(operand);
      if (e.op === "!") return tsl.not(operand);
      return operand; // '+'
    }
    case "binary": {
      const left = genExpr(e.left, ctx);
      const right = genExpr(e.right, ctx);
      const fnName = BINARY_OPS[e.op];
      if (!fnName) throw new TranslateError(`不支持的运算符 '${e.op}'`);
      return (tsl as unknown as Record<string, (...a: unknown[]) => TslNode>)[fnName](left, right);
    }
    case "call":
      return genCall(e.name, e.args, ctx);
  }
}

function genCall(name: string, args: Expr[], ctx: GenContext): TslNode {
  const tsl = ctx.tsl;
  const t = tsl as unknown as Record<string, (...a: unknown[]) => TslNode>;

  // 采样函数：texture2D(tex, uv) / texture(tex, uv) → tsl.texture
  if (SAMPLE_FUNCS.has(name)) {
    if (args.length < 2) throw new TranslateError(`${name}() 至少需要 (sampler, uv) 两个参数`);
    return tsl.texture(genExpr(args[0], ctx), genExpr(args[1], ctx));
  }

  // 类型构造：vec4(...) / mat3(...) / float(...) 等
  if (TYPE_CONSTRUCTORS.has(name)) {
    return t[name](...args.map((a) => genExpr(a, ctx)));
  }

  // 三元（parser 把 `?:` 规范化为 call("ternary", [cond, then, else])）
  if (name === "ternary") {
    if (args.length !== 3) throw new TranslateError("三元表达式需要三个操作数");
    // mix(a, b, t)：t 为 bool 时按 select 语义 → mix(else, then, cond)
    return tsl.mix(genExpr(args[2], ctx), genExpr(args[1], ctx), genExpr(args[0], ctx));
  }

  // 内置数学函数（同名直映射）
  const mapped = FUNC_MAP[name];
  if (mapped) {
    return t[mapped](...args.map((a) => genExpr(a, ctx)));
  }

  // 自定义工具函数 → inline 展开：形参绑实参节点，在当前 Fn stack 内执行 body，
  // 取其 return 值作为调用结果（递归 inline：工具函数可调其他工具函数）
  const tool = ctx.tools.get(name);
  if (tool) {
    if (args.length !== tool.params.length) {
      throw new TranslateError(
        `函数 ${name}() 参数数量不匹配（声明 ${tool.params.length} 个，调用 ${args.length} 个）`,
      );
    }
    const subCtx: GenContext = { ...ctx, locals: new Map() };
    for (let i = 0; i < tool.params.length; i++) {
      subCtx.locals.set(tool.params[i][1], genExpr(args[i], ctx));
    }
    const subState: GenState = { earlyReturn: false, returnValue: null };
    genStmts(tool.body, subCtx, subState);
    if (subState.returnValue === null) {
      throw new TranslateError(`工具函数 ${name}() 未返回值`);
    }
    return subState.returnValue;
  }

  throw new TranslateError(`不支持的函数调用 '${name}()'（受控子集仅支持类型构造与常见内置函数）`);
}

function genStmts(node: Stmt, ctx: GenContext, state: GenState): void {
  if (state.earlyReturn) return;
  switch (node.kind) {
    case "block": {
      for (const s of node.stmts) {
        genStmts(s, ctx, state);
        if (state.earlyReturn) return;
      }
      return;
    }
    case "var": {
      const init = node.init ? genExpr(node.init, ctx) : null;
      const value = init ?? zeroOf(node.type, ctx);
      // Hook 片段里局部变量常被再次赋值（受控子集其它场景按 SSA 处理）
      ctx.locals.set(node.name, varAsWritable ? value.toVar() : value);
      return;
    }
    case "assign": {
      const value = genExpr(node.value, ctx);
      if (node.target.kind === "ident" && node.target.name === "gl_Position") {
        // 顶点阶段输出：记录为返回值
        state.returnValue = value;
        return;
      }
      // varying / 局部 / swizzle 赋值：调用目标节点的 assign
      const target = lvalueNode(node.target, ctx);
      target.assign(value);
      return;
    }
    case "return": {
      state.returnValue = node.value ? genExpr(node.value, ctx) : null;
      state.earlyReturn = true;
      return;
    }
    case "discard": {
      ctx.tsl.Discard();
      return;
    }
    case "if": {
      const cond = genExpr(node.cond, ctx);
      const thenStmts = node.then;
      const elseStmts = node.else;
      const thenFn = () => genStmts(thenStmts, ctx, state);
      const elseFn = elseStmts ? () => genStmts(elseStmts, ctx, state) : undefined;
      ctx.tsl.If(cond, thenFn, elseFn);
      return;
    }
  }
}

/** 赋值目标（ident/ swizzle）→ 可 assign 的节点 */
function lvalueNode(target: Expr, ctx: GenContext): TslNode {
  if (target.kind === "ident") {
    return resolveIdent(target.name, ctx);
  }
  if (target.kind === "swizzle") {
    const base = genExpr(target.base, ctx);
    return base[target.fields];
  }
  throw new TranslateError("不支持该赋值目标（仅局部变量 / varying / swizzle）");
}

/** 声明类型 → 零值节点（无初始化的局部变量兜底） */
function zeroOf(type: string, ctx: GenContext): TslNode {
  const tsl = ctx.tsl;
  const t = tsl as unknown as Record<string, (...a: unknown[]) => TslNode>;
  const ctor = VARYING_INIT[type] ?? "float";
  return (t[ctor] ?? tsl.float)();
}

export interface TranslatedProgram {
  /** 顶点节点（挂 NodeMaterial.vertexNode；返回裁剪坐标 vec4） */
  vertexNode: TslNode | null;
  /** 片元节点（挂 NodeMaterial.fragmentNode；返回输出颜色 vec4） */
  fragmentNode: TslNode | null;
  /** 转译失败原因（null = 成功） */
  error: string | null;
}

export interface TranslateInput {
  vertex: string;
  fragment: string;
  tsl: TslFnLib;
  /** 属性 uniform 节点（属性名 → 已建好的 TSL uniform/采样器节点，由承载层提供） */
  uniforms: Record<string, TslNode>;
  /** _Time 的 uniform 节点 */
  timeNode: TslNode;
}

/**
 * 把组装好的 GLSL 顶点/片元源码翻译成 TSL 回调体。
 * 失败（受控子集外语法 / 结构缺失）返回 error，upper 层回退占位程序。
 */
export function translateProgram(input: TranslateInput): TranslatedProgram {
  try {
    const vStage = parseStage(input.vertex);
    const fStage = parseStage(input.fragment);

    // 收集并创建 varying 节点（顶点负责写入，片元读取——两个阶段共享同一节点）
    const varyings = new Map<string, TslNode>();
    const collect = (stage: StageParse) => {
      for (const [type, name] of stage.varyings) {
        if (varyings.has(name)) continue;
        const t = input.tsl as unknown as Record<string, (...a: unknown[]) => TslNode>;
        const ctor = VARYING_INIT[type] ?? input.tsl.vec3;
        const init = (t[VARYING_INIT[type]] ?? ctor)();
        varyings.set(name, input.tsl.varying(init, name));
      }
    };
    collect(vStage);
    collect(fStage);

    // 工具函数表（顶点/片元共享 CGINCLUDE 里的辅助函数，如 hash/noise）
    const tools = new Map<string, GlslFunction>();
    for (const fn of vStage.tools) tools.set(fn.name, fn);
    for (const fn of fStage.tools) tools.set(fn.name, fn);

    const ctx: GenContext = {
      tsl: input.tsl,
      locals: new Map(),
      varyings,
      uniforms: input.uniforms,
      timeNode: input.timeNode,
      tools,
    };

    const vertexNode = compileStageNode(vStage, ctx);
    const fragmentNode = compileStageNode(fStage, ctx);

    return {
      vertexNode,
      fragmentNode,
      error: null,
    };
  } catch (e) {
    return {
      vertexNode: null,
      fragmentNode: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export { TranslateError, parseStage as parseStageGlsl };

// ---------------------------------------------------------------------------
// Hook 片段 → TSL（WebGPU 后端用）
//
// 与"整程序转译"不同，Hook 只是效果片段：它读环境（normal/viewDir/uv/_Time 与
// 着色器 Properties）、写**一个端口**（position / diffuseColor / emissive / normal），
// 由引擎把端口接回内置材质的对应节点槽位（positionNode / colorNode / emissiveNode /
// normalNode）。契约与 GL 侧的注入完全一致，只是端口在 GL 侧是 three 的着色器变量、
// 在这里是节点。
// ---------------------------------------------------------------------------

/** Hook 编译输入：端口种子 + 只读环境 + Properties uniform */
export interface HookCompileInput {
  /** Hook 片段（语句块；由调用方拼好，无需 main/函数外壳） */
  code: string;
  /** CGINCLUDE 共享代码（工具函数，inline 到 Hook 里） */
  include: string;
  tsl: TslFnLib;
  /** 端口：Hook 里可读写的变量名（如 emissive）与其种子节点（该端口在当前分支的初值） */
  port: { name: string; seed: TslNode };
  /** 只读环境标识符 → 节点（normal → 视空间法线、viewDir → 视空间视线方向等） */
  idents?: Record<string, TslNode>;
  /** 着色器 Properties 的 uniform 节点（属性名 → 节点） */
  uniforms: Record<string, TslNode>;
  /** _Time uniform 节点 */
  timeNode: TslNode;
}

/**
 * Hook 片段 → TSL 节点（返回修改后的端口值）。失败抛 TranslateError，由上层捕获
 * 并按"该 Hook 不生效"降级（材质仍按分支渲染）。
 */
export function compileHookNode(input: HookCompileInput): TslNode {
  const { tsl } = input;
  // 用函数外壳解析片段：端口作为形参名出现在体内，返回值即端口本身
  const source = `${input.include}\nvec4 ${HOOK_ENTRY_NAME}(vec4 ${input.port.name}) {\n${input.code}\nreturn ${input.port.name};\n}\n`;
  const stage = parseStage(source);
  if (stage.error) throw new TranslateError(stage.error);
  if (!stage.entry) throw new TranslateError("Hook 片段为空或无法解析");

  const tools = new Map<string, GlslFunction>();
  for (const fn of stage.tools) tools.set(fn.name, fn);

  const prevWritable = varAsWritable;
  varAsWritable = true;
  try {
    return tsl.Fn(() => {
      const locals = new Map<string, TslNode>();
      // 端口 = 可写局部（Hook 里的 `emissive += …` / `position += …` 直接改它）
      locals.set(input.port.name, input.port.seed.toVar());
      const ctx: GenContext = {
        tsl,
        locals,
        varyings: new Map(),
        uniforms: input.uniforms,
        timeNode: input.timeNode,
        tools,
        idents: input.idents,
      };
      const state: GenState = { earlyReturn: false, returnValue: null };
      genStmts(stage.entry!.body, ctx, state);
      return state.returnValue ?? locals.get(input.port.name);
    })();
  } finally {
    varAsWritable = prevWritable;
  }
}