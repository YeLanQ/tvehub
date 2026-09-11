// ---------------------------------------------------------------------------
// GLSL（受控子集）→ TSL 转译器（网页运行时侧）。
// 与编辑器 src/framework/material/tsl/{ast,glslLexer,glslParser,glslToTsl}.ts
// 逐行对应——纯逻辑、无 three 依赖，由 core/customNodeMaterial.mjs 以 THREE.TSL
// 作为 TslFnLib 注入后调用 translateProgram。受控子集与失败回退策略同编辑器侧。
// ---------------------------------------------------------------------------

// ===================== 词法（tokenizer） =====================

/** 多字符运算符（按长度降序，先匹配长符号） */
const MULTI_OPS = ["+=", "-=", "*=", "/=", "==", "!=", "<=", ">=", "&&", "||"];
const SINGLE_OPS = "+-*/=<>!(){}[].,;?:";

function isDigit(ch) {
  return ch >= "0" && ch <= "9";
}
function isIdentStart(ch) {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}
function isIdentPart(ch) {
  return isIdentStart(ch) || isDigit(ch);
}

/** 把 GLSL 源码切分为 token 流；非法字符跳过并记入 errors */
export function tokenize(src) {
  const tokens = [];
  const errors = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "#") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (isDigit(ch) || (ch === "." && isDigit(src[i + 1] ?? ""))) {
      const start = i;
      while (i < n && isDigit(src[i])) i++;
      if (src[i] === ".") {
        i++;
        while (i < n && isDigit(src[i])) i++;
      }
      if (src[i] === "e" || src[i] === "E") {
        i++;
        if (src[i] === "+" || src[i] === "-") i++;
        while (i < n && isDigit(src[i])) i++;
      }
      if (src[i] === "f" || src[i] === "F") i++;
      const text = src.slice(start, i);
      const value = Number(text);
      if (Number.isFinite(value)) {
        tokens.push({ type: "num", value, pos: start });
      } else {
        errors.push(`非法数字字面量 '${text}'（偏移 ${start}）`);
      }
      continue;
    }
    if (isIdentStart(ch)) {
      const start = i;
      while (i < n && isIdentPart(src[i])) i++;
      tokens.push({ type: "ident", value: src.slice(start, i), pos: start });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (MULTI_OPS.includes(two)) {
      tokens.push({ type: "op", value: two, pos: i });
      i += 2;
      continue;
    }
    if (SINGLE_OPS.includes(ch)) {
      tokens.push({ type: "op", value: ch, pos: i });
      i++;
      continue;
    }
    errors.push(`忽略无法识别的字符 '${ch}'（偏移 ${i}）`);
    i++;
  }

  return { tokens, errors };
}

// ===================== 语法（递归下降 parser） =====================

/** 翻译期错误（parser/codegen 抛出，translate 捕获后回退） */
export class TranslateError extends Error {
  constructor(message) {
    super(message);
    this.name = "TranslateError";
  }
}

const DECL_TYPES = new Set([
  "float", "int", "bool",
  "vec2", "vec3", "vec4",
  "ivec2", "ivec3", "ivec4",
  "bvec2", "bvec3", "bvec4",
  "mat2", "mat3", "mat4",
  "sampler2D", "samplerCube",
  "half", "fixed",
]);

const SWIZZLE_CHARS = new Set("xyzwrgbastpq".split(""));

/** Hook 编译的合成入口函数名（compileHookNode 生成；与编辑器侧 glslParser.ts 同名约定） */
const HOOK_ENTRY_NAME = "__tve_hook__";

class Parser {
  constructor(src) {
    this.tokens = tokenize(src).tokens;
    this.pos = 0;
  }

  peek(offset = 0) {
    return this.tokens[this.pos + offset];
  }
  next() {
    const t = this.tokens[this.pos];
    this.pos++;
    return t;
  }
  atEnd() {
    return this.pos >= this.tokens.length;
  }

  isOp(value) {
    const t = this.peek();
    return t !== undefined && t.type === "op" && t.value === value;
  }
  isIdent(value) {
    const t = this.peek();
    if (!t || t.type !== "ident") return false;
    return value === undefined || t.value === value;
  }
  expectOp(value) {
    if (!this.isOp(value)) {
      const t = this.peek();
      throw new TranslateError(
        `期望 '${value}'，实际 ${t ? `${t.type}:${t.value}` : "文件结束"}（偏移 ${t ? t.pos : "?"}）`,
      );
    }
    this.next();
  }
  expectIdent() {
    const t = this.peek();
    if (!t || t.type !== "ident") {
      throw new TranslateError(`期望标识符（偏移 ${t ? t.pos : "?"}）`);
    }
    this.next();
    return String(t.value);
  }

  skipGlobalDeclaration(expectedKind) {
    if (!this.isIdent(expectedKind)) return;
    this.next();
    while (!this.atEnd() && !this.isOp(";")) this.next();
    if (this.isOp(";")) this.next();
  }

  tryParseVarying() {
    if (!this.isIdent("varying")) return null;
    this.next();
    const type = this.expectIdent();
    const name = this.expectIdent();
    if (this.isOp(";")) this.next();
    return [type, name];
  }

  tryParseFunction() {
    const t0 = this.peek();
    if (!t0 || t0.type !== "ident") return null;
    const t1 = this.peek(1);
    const t2 = this.peek(2);
    if (!t1 || t1.type !== "ident") return null;
    if (!t2 || t2.type !== "op" || t2.value !== "(") return null;
    const returnType = String(t0.value);
    if (returnType !== "void" && !DECL_TYPES.has(returnType)) return null;

    this.next();
    const name = this.expectIdent();
    this.expectOp("(");
    const params = [];
    if (!this.isOp(")")) {
      for (;;) {
        const ptype = this.expectIdent();
        const pname = this.expectIdent();
        params.push([ptype, pname]);
        if (this.isOp(",")) {
          this.next();
          continue;
        }
        break;
      }
    }
    this.expectOp(")");
    this.expectOp("{");
    if (name === "main") {
      const entryName = this.peekEntryCallName();
      const body = this.skipBracedBlock();
      return { returnType, name, params, body, entryName };
    }
    const body = this.parseBlock();
    return { returnType, name, params, body };
  }

  /** 扫描 main body 内第一个 `ident(` 形态的调用，作为入口函数名（vert/frag） */
  peekEntryCallName() {
    let p = this.pos;
    const n = this.tokens.length;
    while (p < n) {
      const t = this.tokens[p];
      if (t.type === "op" && t.value === "}") break;
      const next = this.tokens[p + 1];
      if (t.type === "ident" && next && next.type === "op" && next.value === "(") {
        return String(t.value);
      }
      p++;
    }
    return null;
  }

  skipBracedBlock() {
    let depth = 1;
    while (!this.atEnd() && depth > 0) {
      const t = this.next();
      if (t.type === "op" && t.value === "{") depth++;
      else if (t.type === "op" && t.value === "}") depth--;
    }
    return { kind: "block", stmts: [] };
  }

  parseStage() {
    const varyings = [];
    const functions = [];

    while (!this.atEnd()) {
      const t = this.peek();
      if (!t || t.type !== "ident") {
        if (t) this.next();
        else break;
        continue;
      }
      const id = String(t.value);
      if (id === "varying") {
        const v = this.tryParseVarying();
        if (v) varyings.push(v);
        continue;
      }
      if (id === "uniform" || id === "const" || id === "attribute") {
        this.skipGlobalDeclaration(id);
        continue;
      }
      const fn = this.tryParseFunction();
      if (fn) {
        functions.push(fn);
        continue;
      }
      break;
    }

    const mainFn = functions.find((f) => f.name === "main") ?? null;
    const entryName = mainFn?.entryName ?? null;
    // Hook 编译的合成源码（compileHookNode：CGINCLUDE 工具函数 + __tve_hook__ 入口）
    // 没有 main 包装 —— 入口必须按名取回，否则首个工具函数会被误选为入口、
    // 真正的 Hook 体落进 tools（WebGPU 下材质节点构建失败渲染成黑）。
    const entry =
      (entryName ? functions.find((f) => f.name === entryName) ?? null : null) ??
      functions.find((f) => f.name === HOOK_ENTRY_NAME) ??
      functions.find((f) => f.name !== "main") ??
      null;
    const tools = functions.filter((f) => f !== entry && f.name !== "main");
    return { entry, varyings, tools, error: null };
  }

  parseBlock() {
    const stmts = [];
    while (!this.atEnd() && !this.isOp("}")) {
      const before = this.pos;
      stmts.push(this.parseStatement());
      // 防御：语句解析必须消费 token——否则这里会原地空转（主线程卡死）
      if (this.pos === before) {
        const t = this.peek();
        throw new TranslateError(
          `无法解析的语句（偏移 ${t?.pos ?? "?"}: ${t?.type ?? "EOF"}:${String(t?.value ?? "")}）`,
        );
      }
    }
    this.expectOp("}");
    return { kind: "block", stmts };
  }

  parseStatement() {
    const t = this.peek();
    if (!t) throw new TranslateError("意外的文件结束");
    if (t.type === "op" && t.value === "{") {
      this.next();
      return this.parseBlock();
    }
    if (t.type === "ident") {
      const id = String(t.value);
      if (id === "return") return this.parseReturn();
      if (id === "discard") {
        this.next();
        this.consumeSemicolon();
        return { kind: "discard" };
      }
      if (id === "if") return this.parseIf();
      if (id === "for" || id === "while") {
        throw new TranslateError(`暂不支持循环语句 '${id}'（受控子集仅支持 if/else）`);
      }
      if (DECL_TYPES.has(id)) {
        const t1 = this.peek(1);
        const t2 = this.peek(2);
        if (t1 && t1.type === "ident" && !(t2 && t2.type === "op" && t2.value === "(")) {
          return this.parseVarDecl();
        }
      }
    }
    return this.parseAssignStatement();
  }

  consumeSemicolon() {
    if (this.isOp(";")) this.next();
  }

  parseReturn() {
    this.next();
    if (this.isOp(";")) {
      this.next();
      return { kind: "return", value: null };
    }
    const value = this.parseExpression();
    this.consumeSemicolon();
    return { kind: "return", value };
  }

  parseIf() {
    this.next();
    this.expectOp("(");
    const cond = this.parseExpression();
    this.expectOp(")");
    const then = this.parseStatement();
    let elseBranch = null;
    if (this.isIdent("else")) {
      this.next();
      elseBranch = this.parseStatement();
    }
    return { kind: "if", cond, then, else: elseBranch };
  }

  parseVarDecl() {
    const type = this.expectIdent();
    const name = this.expectIdent();
    let init = null;
    if (this.isOp("=")) {
      this.next();
      init = this.parseExpression();
    }
    this.consumeSemicolon();
    return { kind: "var", type, name, init };
  }

  peekOp() {
    const t = this.peek();
    return t && t.type === "op" ? t.value : null;
  }

  parseAssignStatement() {
    const target = this.parseExpression();
    // 复合赋值（emissive += x / diffuseColor.rgb *= k）展开为 target = target op rhs
    const compound = { "+=": "+", "-=": "-", "*=": "*", "/=": "/" };
    const op = this.peekOp();
    if (op && compound[op]) {
      this.next();
      const rhs = this.parseExpression();
      this.consumeSemicolon();
      return {
        kind: "assign",
        target,
        value: { kind: "binary", op: compound[op], left: target, right: rhs },
      };
    }
    if (!this.isOp("=")) {
      this.consumeSemicolon();
      return { kind: "block", stmts: [] };
    }
    this.next();
    const value = this.parseExpression();
    this.consumeSemicolon();
    return { kind: "assign", target, value };
  }

  parseExpression() {
    return this.parseTernary();
  }
  parseTernary() {
    const cond = this.parseOr();
    if (this.isOp("?")) {
      this.next();
      const then = this.parseExpression();
      this.expectOp(":");
      const elseBranch = this.parseTernary();
      return { kind: "call", name: "ternary", args: [cond, then, elseBranch] };
    }
    return cond;
  }
  parseOr() {
    let left = this.parseAnd();
    while (this.isOp("||")) {
      const op = String(this.next().value);
      const right = this.parseAnd();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }
  parseAnd() {
    let left = this.parseEquality();
    while (this.isOp("&&")) {
      const op = String(this.next().value);
      const right = this.parseEquality();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }
  parseEquality() {
    let left = this.parseRelational();
    while (this.isOp("==") || this.isOp("!=")) {
      const op = String(this.next().value);
      const right = this.parseRelational();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }
  parseRelational() {
    let left = this.parseAdditive();
    while (this.isOp("<") || this.isOp(">") || this.isOp("<=") || this.isOp(">=")) {
      const op = String(this.next().value);
      const right = this.parseAdditive();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }
  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.isOp("+") || this.isOp("-")) {
      const op = String(this.next().value);
      const right = this.parseMultiplicative();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }
  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.isOp("*") || this.isOp("/")) {
      const op = String(this.next().value);
      const right = this.parseUnary();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }
  parseUnary() {
    const t = this.peek();
    if (t && t.type === "op" && (t.value === "-" || t.value === "!" || t.value === "+")) {
      const op = String(this.next().value);
      const operand = this.parseUnary();
      return { kind: "unary", op, operand };
    }
    return this.parsePostfix();
  }
  parsePostfix() {
    let e = this.parsePrimary();
    for (;;) {
      if (this.isOp(".")) {
        this.next();
        const field = this.expectIdent();
        if ([...field].every((c) => SWIZZLE_CHARS.has(c))) {
          e = { kind: "swizzle", base: e, fields: field };
        } else {
          throw new TranslateError(`不支持的成员访问 '.${field}'（受控子集仅支持 swizzle）`);
        }
      } else {
        break;
      }
    }
    return e;
  }
  parsePrimary() {
    const t = this.peek();
    if (!t) throw new TranslateError("意外的表达式结束");
    if (t.type === "num") {
      this.next();
      return { kind: "number", value: t.value };
    }
    if (t.type === "ident") {
      const name = String(t.value);
      if (name === "true" || name === "false") {
        this.next();
        return { kind: "bool", value: name === "true" };
      }
      this.next();
      if (this.isOp("(")) {
        this.next();
        const args = [];
        if (!this.isOp(")")) {
          for (;;) {
            args.push(this.parseExpression());
            if (this.isOp(",")) {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expectOp(")");
        return { kind: "call", name, args };
      }
      return { kind: "ident", name };
    }
    if (t.type === "op" && t.value === "(") {
      this.next();
      const e = this.parseExpression();
      this.expectOp(")");
      return e;
    }
    throw new TranslateError(`无法解析的表达式 token ${t.type}:${t.value}（偏移 ${t.pos}）`);
  }
}

/** 解析单个阶段源码（顶点或片元），返回入口函数与 varying 声明 */
export function parseStage(src) {
  return new Parser(src).parseStage();
}

// ===================== 转译（codegen） =====================

/** GLSL 内置标识符 → tsl 内置节点属性名 */
const BUILTIN_IDENT = {
  position: "positionLocal",
  normal: "normalLocal",
  modelMatrix: "modelWorldMatrix",
  modelViewMatrix: "modelViewMatrix",
  viewMatrix: "cameraViewMatrix",
  projectionMatrix: "cameraProjectionMatrix",
  cameraPosition: "cameraPosition",
  normalMatrix: "modelNormalMatrix",
};

const TYPE_CONSTRUCTORS = new Set([
  "float", "int", "uint", "bool", "vec2", "vec3", "vec4",
  "bvec2", "bvec3", "bvec4", "ivec2", "ivec3", "ivec4", "mat2", "mat3", "mat4",
]);

const SAMPLE_FUNCS = new Set(["texture", "texture2D", "textureCube"]);

const FUNC_MAP = {
  mix: "mix", clamp: "clamp", min: "min", max: "max", abs: "abs", sign: "sign",
  floor: "floor", ceil: "ceil", fract: "fract", round: "round", mod: "mod",
  pow: "pow", exp: "exp", exp2: "exp2", log: "log", log2: "log2", sqrt: "sqrt",
  inversesqrt: "inversesqrt", sin: "sin", cos: "cos", tan: "tan", asin: "asin",
  acos: "acos", atan: "atan", atan2: "atan2", sinh: "sinh", cosh: "cosh",
  tanh: "tanh", degrees: "degrees", radians: "radians", length: "length",
  distance: "distance", dot: "dot", cross: "cross", normalize: "normalize",
  reflect: "reflect", refract: "refract", step: "step", smoothstep: "smoothstep",
};

const BINARY_OPS = {
  "+": "add", "-": "sub", "*": "mul", "/": "div",
  "==": "equal", "!=": "notEqual", "<": "lessThan", "<=": "lessThanEqual",
  ">": "greaterThan", ">=": "greaterThanEqual", "&&": "and", "||": "or",
};

const VARYING_INIT = {
  vec2: "vec2", vec3: "vec3", vec4: "vec4", float: "float", int: "int", uint: "uint",
  bool: "bool", ivec2: "ivec2", ivec3: "ivec3", ivec4: "ivec4",
  bvec2: "bvec2", bvec3: "bvec3", bvec4: "bvec4",
};

function compileStageNode(stage, ctx) {
  if (!stage.entry) {
    throw new TranslateError("未找到入口函数（CGPROGRAM 缺 #pragma vertex/fragment 对应函数体）");
  }
  const entryBody = stage.entry.body;
  return ctx.tsl.Fn(() => {
    const state = { earlyReturn: false, returnValue: null };
    genStmts(entryBody, { ...ctx, locals: new Map() }, state);
    return state.returnValue;
  })();
}

function resolveIdent(name, ctx) {
  // 说明：idents 由 Hook 端口注入（normal → 视空间法线、viewDir → 视空间视线）
  if (name === "_Time") return ctx.timeNode;
  if (ctx.locals.has(name)) return ctx.locals.get(name);
  if (ctx.varyings.has(name)) return ctx.varyings.get(name);
  if (name in ctx.uniforms) return ctx.uniforms[name];
  if (ctx.idents && name in ctx.idents) return ctx.idents[name];
  if (name in BUILTIN_IDENT) return ctx.tsl[BUILTIN_IDENT[name]];
  if (name === "uv") return ctx.tsl.uv();
  if (name.startsWith("gl_")) {
    throw new TranslateError(`内置变量 ${name} 不能作为表达式值使用（仅 gl_Position 可作为赋值目标）`);
  }
  throw new TranslateError(`未知标识符 '${name}'（非 varying/uniform/内置变量，且工具函数不在受控子集内）`);
}

function genExpr(e, ctx) {
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
      return operand;
    }
    case "binary": {
      const left = genExpr(e.left, ctx);
      const right = genExpr(e.right, ctx);
      const fnName = BINARY_OPS[e.op];
      if (!fnName) throw new TranslateError(`不支持的运算符 '${e.op}'`);
      return tsl[fnName](left, right);
    }
    case "call":
      return genCall(e.name, e.args, ctx);
  }
}

function genCall(name, args, ctx) {
  const tsl = ctx.tsl;
  if (SAMPLE_FUNCS.has(name)) {
    if (args.length < 2) throw new TranslateError(`${name}() 至少需要 (sampler, uv) 两个参数`);
    return tsl.texture(genExpr(args[0], ctx), genExpr(args[1], ctx));
  }
  if (TYPE_CONSTRUCTORS.has(name)) {
    return tsl[name](...args.map((a) => genExpr(a, ctx)));
  }
  if (name === "ternary") {
    if (args.length !== 3) throw new TranslateError("三元表达式需要三个操作数");
    return tsl.mix(genExpr(args[2], ctx), genExpr(args[1], ctx), genExpr(args[0], ctx));
  }
  const mapped = FUNC_MAP[name];
  if (mapped) {
    return tsl[mapped](...args.map((a) => genExpr(a, ctx)));
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
    const subCtx = { ...ctx, locals: new Map() };
    for (let i = 0; i < tool.params.length; i++) {
      subCtx.locals.set(tool.params[i][1], genExpr(args[i], ctx));
    }
    const subState = { earlyReturn: false, returnValue: null };
    genStmts(tool.body, subCtx, subState);
    if (subState.returnValue === null) {
      throw new TranslateError(`工具函数 ${name}() 未返回值`);
    }
    return subState.returnValue;
  }

  throw new TranslateError(`不支持的函数调用 '${name}()'（受控子集仅支持类型构造与常见内置函数）`);
}

/** 局部变量是否包成可写节点（.toVar()）：Hook 片段常"声明后再赋值" */
let varAsWritable = false;

function genStmts(node, ctx, state) {
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
      // Hook 片段里局部变量常被再次赋值（其它场景按 SSA 处理）
      ctx.locals.set(node.name, varAsWritable ? value.toVar() : value);
      return;
    }
    case "assign": {
      const value = genExpr(node.value, ctx);
      if (node.target.kind === "ident" && node.target.name === "gl_Position") {
        state.returnValue = value;
        return;
      }
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

function lvalueNode(target, ctx) {
  if (target.kind === "ident") {
    return resolveIdent(target.name, ctx);
  }
  if (target.kind === "swizzle") {
    const base = genExpr(target.base, ctx);
    return base[target.fields];
  }
  throw new TranslateError("不支持该赋值目标（仅局部变量 / varying / swizzle）");
}

function zeroOf(type, ctx) {
  const tsl = ctx.tsl;
  const ctor = VARYING_INIT[type] ?? "float";
  return (tsl[ctor] ?? tsl.float)();
}

/**
 * 把组装好的 GLSL 顶点/片元源码翻译成 TSL 回调体。
 * 失败（受控子集外语法 / 结构缺失）返回 error，上层回退占位程序。
 */
export function translateProgram(input) {
  try {
    const vStage = parseStage(input.vertex);
    const fStage = parseStage(input.fragment);

    const varyings = new Map();
    const collect = (stage) => {
      for (const [type, name] of stage.varyings) {
        if (varyings.has(name)) continue;
        const ctor = VARYING_INIT[type] ?? "vec3";
        const init = (input.tsl[ctor] ?? input.tsl.vec3)();
        varyings.set(name, input.tsl.varying(init, name));
      }
    };
    collect(vStage);
    collect(fStage);

    // 工具函数表（顶点/片元共享 CGINCLUDE 里的辅助函数，如 hash/noise）
    const tools = new Map();
    for (const fn of vStage.tools) tools.set(fn.name, fn);
    for (const fn of fStage.tools) tools.set(fn.name, fn);

    const ctx = {
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
// ---------------------------------------------------------------------------
// Hook 片段 → TSL（WebGPU 运行时用）：端口作为可写局部参与读写，返回修改后的端口
// 节点；只读环境（normal/viewDir/uv/_Time）与 Properties uniform 由调用方注入。
// 与编辑器侧 src/framework/material/tsl/glslToTsl.ts 的 compileHookNode 同规则。
// ---------------------------------------------------------------------------
export function compileHookNode(input) {
  const tsl = input.tsl;
  const source = `${input.include}
vec4 ${HOOK_ENTRY_NAME}(vec4 ${input.port.name}) {
${input.code}
return ${input.port.name};
}
`;
  const stage = parseStage(source);
  if (stage.error) throw new TranslateError(stage.error);
  if (!stage.entry) throw new TranslateError("Hook 片段为空或无法解析");

  const tools = new Map();
  for (const fn of stage.tools) tools.set(fn.name, fn);

  const prevWritable = varAsWritable;
  varAsWritable = true;
  try {
    return tsl.Fn(() => {
      const locals = new Map();
      locals.set(input.port.name, input.port.seed.toVar());
      const ctx = {
        tsl,
        locals,
        varyings: new Map(),
        uniforms: input.uniforms,
        timeNode: input.timeNode,
        tools,
        idents: input.idents,
      };
      const state = { earlyReturn: false, returnValue: null };
      genStmts(stage.entry.body, ctx, state);
      return state.returnValue ?? locals.get(input.port.name);
    })();
  } finally {
    varAsWritable = prevWritable;
  }
}
