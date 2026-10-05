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

// ---------------------------------------------------------------------------
// 类型定义（与编辑器 framework/material/tsl/{ast,glslToTsl}.ts 保持镜像）
// ---------------------------------------------------------------------------

/** 词法 token（num/ident/op 三类；pos 为源偏移） */
interface Token {
  type: "num" | "ident" | "op";
  value: number | string;
  pos: number;
}

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
  | { kind: "var"; type: string; name: string; init: Expr | null }
  | { kind: "assign"; target: Expr; value: Expr }
  | { kind: "return"; value: Expr | null }
  | { kind: "discard" }
  | { kind: "block"; stmts: Stmt[] }
  | { kind: "if"; cond: Expr; then: Stmt; else: Stmt | null };

/** 函数签名（受控子集支持工具函数带参，入口函数无参） */
export interface GlslFunction {
  returnType: string;
  name: string;
  /** 形参表 [type, name][]（工具函数如 hash(vec2 p)；入口函数为空） */
  params: [string, string][];
  body: Stmt;
  /** main 包装器内被调用的入口函数名（仅 name==="main" 时有意义） */
  entryName?: string | null;
}

/** 顶点/片元分阶段解析结果（入口函数体 + 全局 varying 声明 + 工具函数表） */
export interface StageParse {
  entry: GlslFunction | null;
  varyings: [string, string][];
  tools: GlslFunction[];
  error: string | null;
}

/** TSL 节点（运行时为 three/tsl 节点对象；不透明结构传递，动态成员经索引签名放行） */
export interface TslNode {
  /** uniform 节点载荷 */
  value?: unknown;
  /** 变量化包装（Hook 端口等声明后再赋值的节点必须可 assign） */
  toVar(): TslNode;
  /** 节点赋值（GLSL assign 语句编译） */
  assign(value: TslNode): TslNode;
  /** swizzle / 动态属性访问（.rgb / .xyz 等；three/tsl 运行时提供） */
  [field: string]: unknown;
}

/** 注入的 TSL 函数库（three WebGPU 构建 THREE.TSL 命名空间的最小消费面） */
export interface TslFnLib {
  uniform(value: unknown): TslNode;
  float(x?: unknown): TslNode;
  int(x?: unknown): TslNode;
  uint(x?: unknown): TslNode;
  bool(x?: unknown): TslNode;
  vec2(...a: unknown[]): TslNode;
  vec3(...a: unknown[]): TslNode;
  vec4(...a: unknown[]): TslNode;
  mat3(...a: unknown[]): TslNode;
  mat4(...a: unknown[]): TslNode;
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
  mix(a: unknown, b: unknown, t: unknown): TslNode;
  clamp(x: unknown, lo: unknown, hi: unknown): TslNode;
  texture(tex: unknown, uv: unknown): TslNode;
  varying(node: TslNode, name?: string): TslNode;
  If(cond: TslNode, then: () => void, els?: () => void): TslNode;
  /** 返回可调用体（惯例 Fn(body)() 立即执行挂到节点槽位）；body 返回 null = 无显式返回 */
  Fn(body: (...args: unknown[]) => TslNode | null): () => TslNode;
  Discard(): TslNode;
  /** 内置节点（constant / 访问器；swizzle 经 TslNode 索引签名访问） */
  positionLocal: TslNode;
  positionView: TslNode;
  materialColor: TslNode;
  materialOpacity: TslNode;
  materialEmissive: TslNode;
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

/** 转译阶段上下文（本地变量 / varying / uniform / 内置 / 工具函数 的解析命名空间） */
interface GenContext {
  tsl: TslFnLib;
  locals: Map<string, TslNode>;
  varyings: Map<string, TslNode>;
  uniforms: Record<string, TslNode>;
  timeNode: TslNode;
  /** 工具函数表（name → 声明），genCall 遇自定义函数时 inline 展开 */
  tools: Map<string, GlslFunction>;
  /** 额外标识符 → 节点（Hook 端口语义里的 normal/viewDir 在此注入） */
  idents?: Record<string, TslNode>;
}

/** 语句生成过程中的控制流状态（return 提前终止 + 返回值） */
interface GenState {
  earlyReturn: boolean;
  returnValue: TslNode | null;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}
function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}
function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

/** 把 GLSL 源码切分为 token 流；非法字符跳过并记入 errors */
export function tokenize(src: string): { tokens: Token[]; errors: string[] } {
  const tokens: Token[] = [];
  const errors: string[] = [];
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
  constructor(message: string) {
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
  tokens: Token[];
  pos: number;

  constructor(src: string) {
    this.tokens = tokenize(src).tokens;
    this.pos = 0;
  }

  peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }
  next(): Token | undefined {
    const t = this.tokens[this.pos];
    this.pos++;
    return t;
  }
  atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  isOp(value: string): boolean {
    const t = this.peek();
    return t !== undefined && t.type === "op" && t.value === value;
  }
  isIdent(value?: string): boolean {
    const t = this.peek();
    if (!t || t.type !== "ident") return false;
    return value === undefined || t.value === value;
  }
  expectOp(value: string): void {
    if (!this.isOp(value)) {
      const t = this.peek();
      throw new TranslateError(
        `期望 '${value}'，实际 ${t ? `${t.type}:${t.value}` : "文件结束"}（偏移 ${t ? t.pos : "?"}）`,
      );
    }
    this.next();
  }
  expectIdent(): string {
    const t = this.peek();
    if (!t || t.type !== "ident") {
      throw new TranslateError(`期望标识符（偏移 ${t ? t.pos : "?"}）`);
    }
    this.next();
    return String(t.value);
  }

  skipGlobalDeclaration(expectedKind: string): void {
    if (!this.isIdent(expectedKind)) return;
    this.next();
    while (!this.atEnd() && !this.isOp(";")) this.next();
    if (this.isOp(";")) this.next();
  }

  tryParseVarying(): [string, string] | null {
    if (!this.isIdent("varying")) return null;
    this.next();
    const type = this.expectIdent();
    const name = this.expectIdent();
    if (this.isOp(";")) this.next();
    return [type, name];
  }

  tryParseFunction(): GlslFunction | null {
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
      return { returnType, name, params: params as [string, string][], body, entryName };
    }
    const body = this.parseBlock();
    return { returnType, name, params: params as [string, string][], body };
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

  skipBracedBlock(): Stmt {
    let depth = 1;
    while (!this.atEnd() && depth > 0) {
      const t = this.next();
      if (t && t.type === "op" && t.value === "{") depth++;
      else if (t && t.type === "op" && t.value === "}") depth--;
    }
    return { kind: "block", stmts: [] };
  }

  parseStage(): StageParse {
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

  parseBlock(): Stmt {
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

  parseStatement(): Stmt {
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

  parseReturn(): Stmt {
    this.next();
    if (this.isOp(";")) {
      this.next();
      return { kind: "return", value: null };
    }
    const value = this.parseExpression();
    this.consumeSemicolon();
    return { kind: "return", value };
  }

  parseIf(): Stmt {
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

  parseVarDecl(): Stmt {
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

  parseAssignStatement(): Stmt {
    const target = this.parseExpression();
    // 复合赋值（emissive += x / diffuseColor.rgb *= k）展开为 target = target op rhs
    const compound: Record<string, string> = { "+=": "+", "-=": "-", "*=": "*", "/=": "/" };
    const opRaw = this.peekOp();
    const op = typeof opRaw === "string" ? opRaw : undefined;
    const mapped = op !== undefined ? compound[op] : undefined;
    if (op !== undefined && mapped) {
      this.next();
      const rhs = this.parseExpression();
      this.consumeSemicolon();
      return {
        kind: "assign",
        target,
        value: { kind: "binary", op: mapped, left: target, right: rhs },
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

  parseExpression(): Expr {
    return this.parseTernary();
  }
  parseTernary(): Expr {
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
  parseOr(): Expr {
    let left = this.parseAnd();
    while (this.isOp("||")) {
      const op = String(this.next()!.value);
      const right = this.parseAnd();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }
  parseAnd(): Expr {
    let left = this.parseEquality();
    while (this.isOp("&&")) {
      const op = String(this.next()!.value);
      const right = this.parseEquality();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }
  parseEquality(): Expr {
    let left = this.parseRelational();
    while (this.isOp("==") || this.isOp("!=")) {
      const op = String(this.next()!.value);
      const right = this.parseRelational();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }
  parseRelational(): Expr {
    let left = this.parseAdditive();
    while (this.isOp("<") || this.isOp(">") || this.isOp("<=") || this.isOp(">=")) {
      const op = String(this.next()!.value);
      const right = this.parseAdditive();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }
  parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.isOp("+") || this.isOp("-")) {
      const op = String(this.next()!.value);
      const right = this.parseMultiplicative();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }
  parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.isOp("*") || this.isOp("/")) {
      const op = String(this.next()!.value);
      const right = this.parseUnary();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }
  parseUnary(): Expr {
    const t = this.peek();
    if (t && t.type === "op" && (t.value === "-" || t.value === "!" || t.value === "+")) {
      const op = String(this.next()!.value);
      const operand = this.parseUnary();
      return { kind: "unary", op, operand };
    }
    return this.parsePostfix();
  }
  parsePostfix(): Expr {
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
  parsePrimary(): Expr {
    const t = this.peek();
    if (!t) throw new TranslateError("意外的表达式结束");
    if (t.type === "num") {
      this.next();
      return { kind: "number", value: t.value as number };
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
export function parseStage(src: string): StageParse {
  return new Parser(src).parseStage();
}

// ===================== 转译（codegen） =====================

/** GLSL 内置标识符 → tsl 内置节点属性名 */
const BUILTIN_IDENT: Record<string, string> = {
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

const BINARY_OPS: Record<string, string> = {
  "+": "add", "-": "sub", "*": "mul", "/": "div",
  "==": "equal", "!=": "notEqual", "<": "lessThan", "<=": "lessThanEqual",
  ">": "greaterThan", ">=": "greaterThanEqual", "&&": "and", "||": "or",
};

const VARYING_INIT: Record<string, string> = {
  vec2: "vec2", vec3: "vec3", vec4: "vec4", float: "float", int: "int", uint: "uint",
  bool: "bool", ivec2: "ivec2", ivec3: "ivec3", ivec4: "ivec4",
  bvec2: "bvec2", bvec3: "bvec3", bvec4: "bvec4",
};

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

function resolveIdent(name: string, ctx: GenContext): TslNode {
  // 说明：idents 由 Hook 端口注入（normal → 视空间法线、viewDir → 视空间视线）
  if (name === "_Time") return ctx.timeNode;
  const local = ctx.locals.get(name);
  if (local !== undefined) return local;
  const varying = ctx.varyings.get(name);
  if (varying !== undefined) return varying;
  if (name in ctx.uniforms) return ctx.uniforms[name];
  if (ctx.idents && name in ctx.idents) return ctx.idents[name];
  if (name in BUILTIN_IDENT) {
    return ctx.tsl[BUILTIN_IDENT[name] as keyof TslFnLib] as TslNode;
  }
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
      // swizzle 是 three/tsl 的动态属性（.xyz 等），消费点断言回节点
      return base[e.fields] as TslNode;
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
      return (tsl as unknown as Record<string, (...a: unknown[]) => TslNode>)[fnName](left, right);
    }
    case "call":
      return genCall(e.name, e.args, ctx);
  }
}

function genCall(name: string, args: Expr[], ctx: GenContext): TslNode {
  const tsl = ctx.tsl;
  if (SAMPLE_FUNCS.has(name)) {
    if (args.length < 2) throw new TranslateError(`${name}() 至少需要 (sampler, uv) 两个参数`);
    return tsl.texture(genExpr(args[0], ctx), genExpr(args[1], ctx));
  }
  if (TYPE_CONSTRUCTORS.has(name)) {
    return (tsl as unknown as Record<string, (...a: unknown[]) => TslNode>)[name](
      ...args.map((a) => genExpr(a, ctx)),
    );
  }
  if (name === "ternary") {
    if (args.length !== 3) throw new TranslateError("三元表达式需要三个操作数");
    return tsl.mix(genExpr(args[2], ctx), genExpr(args[1], ctx), genExpr(args[0], ctx));
  }
  const mapped = FUNC_MAP[name];
  if (mapped) {
    return (tsl as unknown as Record<string, (...a: unknown[]) => TslNode>)[mapped](
      ...args.map((a) => genExpr(a, ctx)),
    );
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

/** 局部变量是否包成可写节点（.toVar()）：Hook 片段常"声明后再赋值" */
let varAsWritable = false;

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
      // 分支体由 three 在材质构建期回调执行（惰性），必须使用**独立的分支 state**：
      // 1) 合成钩子源码末尾的 return 会把共享 state.earlyReturn 置真，分支回调
      //    此时才执行会被整段跳过（镂空丢失、只剩辉光）；
      // 2) 分支内的 return 也不应把 earlyReturn 泄漏回外层语句流。
      const branchState = (): GenState => ({ earlyReturn: false, returnValue: null });
      const thenFn = () => genStmts(thenStmts, ctx, branchState());
      const elseFn = elseStmts ? () => genStmts(elseStmts, ctx, branchState()) : undefined;
      ctx.tsl.If(cond, thenFn, elseFn);
      return;
    }
  }
}

function lvalueNode(target: Expr, ctx: GenContext): TslNode {
  if (target.kind === "ident") {
    return resolveIdent(target.name, ctx);
  }
  if (target.kind === "swizzle") {
    const base = genExpr(target.base, ctx);
    // swizzle 是 three/tsl 的动态属性（.xyz 等），消费点断言回节点
    return base[target.fields] as TslNode;
  }
  throw new TranslateError("不支持该赋值目标（仅局部变量 / varying / swizzle）");
}

function zeroOf(type: string, ctx: GenContext): TslNode {
  const tsl = ctx.tsl as unknown as Record<string, (...a: unknown[]) => TslNode> & TslFnLib;
  const ctor = VARYING_INIT[type] ?? "float";
  return (tsl[ctor] ?? tsl.float)();
}

/**
 * 把组装好的 GLSL 顶点/片元源码翻译成 TSL 回调体。
 * 失败（受控子集外语法 / 结构缺失）返回 error，上层回退占位程序。
 */
export function translateProgram(input: {
  vertex: string;
  fragment: string;
  tsl: TslFnLib;
  uniforms: Record<string, TslNode>;
  timeNode: TslNode;
}): { vertexNode: TslNode | null; fragmentNode: TslNode | null; error: string | null } {
  try {
    const vStage = parseStage(input.vertex);
    const fStage = parseStage(input.fragment);

    const varyings = new Map<string, TslNode>();
    const collect = (stage: StageParse): void => {
      for (const [type, name] of stage.varyings) {
        if (varyings.has(name)) continue;
        const ctor = VARYING_INIT[type] ?? "vec3";
        const lib = input.tsl as unknown as Record<string, (...a: unknown[]) => TslNode> & TslFnLib;
        const init = (lib[ctor] ?? input.tsl.vec3)();
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
// ---------------------------------------------------------------------------
// Hook 片段 → TSL（WebGPU 运行时用）：端口作为可写局部参与读写，返回修改后的端口
// 节点；只读环境（normal/viewDir/uv/_Time）与 Properties uniform 由调用方注入。
// 与编辑器侧 src/framework/material/tsl/glslToTsl.ts 的 compileHookNode 同规则。
// ---------------------------------------------------------------------------
export function compileHookNode(input: {
  code: string;
  include: string;
  tsl: TslFnLib;
  port: { name: string; seed: TslNode };
  idents?: Record<string, TslNode>;
  uniforms: Record<string, TslNode>;
  timeNode: TslNode;
}): TslNode {
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

  const tools = new Map<string, GlslFunction>();
  for (const fn of stage.tools) tools.set(fn.name, fn);

  const prevWritable = varAsWritable;
  varAsWritable = true;
  try {
    return tsl.Fn(() => {
      const locals = new Map<string, TslNode>();
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
      // Hook 源码末尾固定 return 端口，returnValue 必有值；此处兜底回端口变量
      return state.returnValue ?? (locals.get(input.port.name) as TslNode);
    })();
  } finally {
    varAsWritable = prevWritable;
  }
}
