// ---------------------------------------------------------------------------
// GLSL 受控子集递归下降解析器（token 流 → AST）。
//
// 顶层：跳过 uniform/const/attribute 声明，收集 varying 声明，识别函数定义；
// 语句：块 / 变量声明 / 赋值 / return / discard / if-else；
// 表达式：按 GLSL 优先级（三元 → || → && → == != → < > <= >= → + - → * / →
// 一元 → 后缀 swizzle/call → 字面量/标识符/括号）递归下降。
// 受控子集之外的结构（循环、数组、矩阵下标、复合赋值、向量方法、工具函数）
// 直接抛 TranslateError，由上层回退占位程序。
// ---------------------------------------------------------------------------

import type { Expr, GlslFunction, StageParse, Stmt } from "./ast";
import { tokenize, type GlslToken } from "./glslLexer";

/** 翻译期错误（parser/codegen 抛出，translate 捕获后回退） */
export class TranslateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslateError";
  }
}

/** 可出现在「声明语句开头」的 GLSL 类型名（用于区分声明与类型构造表达式） */
const DECL_TYPES = new Set([
  "float", "int", "bool",
  "vec2", "vec3", "vec4",
  "ivec2", "ivec3", "ivec4",
  "bvec2", "bvec3", "bvec4",
  "mat2", "mat3", "mat4",
  "sampler2D", "samplerCube",
  "half", "fixed",
]);

/** swizzle 允许的分量字符（x/y/z/w 与 r/g/b/a 与 s/t/p/q） */
const SWIZZLE_CHARS = new Set("xyzwrgbastpq".split(""));

class Parser {
  private tokens: GlslToken[];
  private pos = 0;

  constructor(src: string) {
    this.tokens = tokenize(src).tokens;
  }

  peek(offset = 0): GlslToken | undefined {
    return this.tokens[this.pos + offset];
  }

  next(): GlslToken {
    const t = this.tokens[this.pos];
    this.pos++;
    return t;
  }

  atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  private isOp(value: string): boolean {
    return this.peek()?.type === "op" && this.peek()!.value === value;
  }

  /** 当前 token 若为运算符则返回其原文（复合赋值判定用） */
  private peekOp(): string | null {
    const t = this.peek();
    return t && t.type === "op" && typeof t.value === "string" ? t.value : null;
  }

  private isIdent(value?: string): boolean {
    const t = this.peek();
    if (!t || t.type !== "ident") return false;
    return value === undefined || t.value === value;
  }

  private expectOp(value: string): void {
    if (!this.isOp(value)) {
      const t = this.peek();
      throw new TranslateError(
        `期望 '${value}'，实际 ${t ? `${t.type}:${t.value}` : "文件结束"}（偏移 ${t?.pos ?? "?"}）`,
      );
    }
    this.next();
  }

  private expectIdent(): string {
    const t = this.peek();
    if (!t || t.type !== "ident") {
      throw new TranslateError(`期望标识符（偏移 ${t?.pos ?? "?"}）`);
    }
    this.next();
    return String(t.value);
  }

  /** 跳过一条全局声明（到分号）——uniform/const/attribute 不在翻译范围 */
  skipGlobalDeclaration(expectedKind: string): void {
    if (!this.isIdent(expectedKind)) return;
    this.next();
    while (!this.atEnd() && !this.isOp(";")) this.next();
    if (this.isOp(";")) this.next();
  }

  /** 解析一个 varying 声明：`varying vec3 vNormalW;` → [type, name]（非 varying 返回 null） */
  tryParseVarying(): [string, string] | null {
    if (!this.isIdent("varying")) return null;
    this.next();
    const type = this.expectIdent();
    const name = this.expectIdent();
    if (this.isOp(";")) this.next();
    return [type, name];
  }

  /**
   * 尝试解析函数定义：`<retType> <name> ( ) { body }`。
   * 判定：当前 token 是「类型或 void」，下一个是标识符，再下一个是 '('。
   */
  tryParseFunction(): GlslFunction | null {
    const t0 = this.peek();
    if (!t0 || t0.type !== "ident") return null;
    const t1 = this.peek(1);
    const t2 = this.peek(2);
    if (!t1 || t1.type !== "ident") return null;
    if (!t2 || t2.type !== "op" || t2.value !== "(") return null;
    const returnType = String(t0.value);
    if (returnType !== "void" && !DECL_TYPES.has(returnType)) return null;

    this.next(); // returnType
    const name = this.expectIdent();
    this.expectOp("(");
    const params: [string, string][] = [];
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
      // main 是引擎包装器：提取其调用的入口函数名，再整体跳过 body（不参与翻译）
      const entryName = this.peekEntryCallName();
      const body = this.skipBracedBlock();
      return { returnType, name, params, body, entryName };
    }
    const body = this.parseBlock();
    return { returnType, name, params, body };
  }

  /** 扫描 main body 内第一个 `ident(` 形态的调用，作为入口函数名（vert/frag） */
  private peekEntryCallName(): string | null {
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

  /** 跳过一段花括号配平的块（用于 main 包装器，不解析其内容） */
  private skipBracedBlock(): Stmt {
    let depth = 1;
    while (!this.atEnd() && depth > 0) {
      const t = this.next();
      if (t.type === "op" && t.value === "{") depth++;
      else if (t.type === "op" && t.value === "}") depth--;
    }
    return { kind: "block", stmts: [] };
  }

  /** 解析整个阶段源码：入口函数 + varying 声明 */
  parseStage(): StageParse {
    const varyings: [string, string][] = [];
    const functions: GlslFunction[] = [];

    while (!this.atEnd()) {
      const t = this.peek();
      if (!t || t.type !== "ident") {
        // 顶层杂项（空语句/预处理残留等），跳过
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
      // 无法继续推进（受控子集外的顶层结构），终止以免死循环
      break;
    }

    const mainFn = functions.find((f) => f.name === "main") ?? null;
    const entryName = mainFn?.entryName ?? null;
    const entry =
      (entryName ? functions.find((f) => f.name === entryName) ?? null : null) ??
      functions.find((f) => f.name !== "main") ??
      null;
    const tools = functions.filter((f) => f !== entry && f.name !== "main");
    return { entry, varyings, tools, error: null };
  }

  // ------------------------------------------------------------------ 语句

  private parseBlock(): Stmt {
    const stmts: Stmt[] = [];
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

  private parseStatement(): Stmt {
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

  private consumeSemicolon(): void {
    if (this.isOp(";")) this.next();
  }

  private parseReturn(): Stmt {
    this.next();
    if (this.isOp(";")) {
      this.next();
      return { kind: "return", value: null };
    }
    const value = this.parseExpression();
    this.consumeSemicolon();
    return { kind: "return", value };
  }

  private parseIf(): Stmt {
    this.next();
    this.expectOp("(");
    const cond = this.parseExpression();
    this.expectOp(")");
    const then = this.parseStatement();
    let elseBranch: Stmt | null = null;
    if (this.isIdent("else")) {
      this.next();
      elseBranch = this.parseStatement();
    }
    return { kind: "if", cond, then, else: elseBranch };
  }

  private parseVarDecl(): Stmt {
    const type = this.expectIdent();
    const name = this.expectIdent();
    let init: Expr | null = null;
    if (this.isOp("=")) {
      this.next();
      init = this.parseExpression();
    }
    this.consumeSemicolon();
    return { kind: "var", type, name, init };
  }

  private parseAssignStatement(): Stmt {
    const target = this.parseExpression();
    // 复合赋值（`emissive += x` / `diffuseColor.rgb *= k`）展开为 `target = target op x`
    const compound: Record<string, string> = { "+=": "+", "-=": "-", "*=": "*", "/=": "/" };
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
      // 纯表达式语句（如包装器里的 `vert();`）——受控子集忽略其副作用
      this.consumeSemicolon();
      return { kind: "block", stmts: [] };
    }
    this.next();
    const value = this.parseExpression();
    this.consumeSemicolon();
    return { kind: "assign", target, value };
  }

  // ---------------------------------------------------------------- 表达式

  private parseExpression(): Expr {
    return this.parseTernary();
  }

  private parseTernary(): Expr {
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

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.isOp("||")) {
      const op = String(this.next().value);
      const right = this.parseAnd();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseEquality();
    while (this.isOp("&&")) {
      const op = String(this.next().value);
      const right = this.parseEquality();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseEquality(): Expr {
    let left = this.parseRelational();
    while (this.isOp("==") || this.isOp("!=")) {
      const op = String(this.next().value);
      const right = this.parseRelational();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseRelational(): Expr {
    let left = this.parseAdditive();
    while (this.isOp("<") || this.isOp(">") || this.isOp("<=") || this.isOp(">=")) {
      const op = String(this.next().value);
      const right = this.parseAdditive();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.isOp("+") || this.isOp("-")) {
      const op = String(this.next().value);
      const right = this.parseMultiplicative();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.isOp("*") || this.isOp("/")) {
      const op = String(this.next().value);
      const right = this.parseUnary();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t && t.type === "op" && (t.value === "-" || t.value === "!" || t.value === "+")) {
      const op = String(this.next().value);
      const operand = this.parseUnary();
      return { kind: "unary", op, operand };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
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

  private parsePrimary(): Expr {
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
        const args: Expr[] = [];
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