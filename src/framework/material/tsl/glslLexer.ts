// ---------------------------------------------------------------------------
// GLSL 受控子集词法分析器（tokenizer）。
//
// 产物为统一的 token 流（number / ident / op），供递归下降 parser 消费。
// 覆盖：整数/浮点/科学计数数字、标识符、多/单字符运算符与标点、
// 单行与块注释、任意空白。不区分关键字（float/vec3 等一律作为 ident，
// 语义在 parser 层判定），以保持词法层极简。
// ---------------------------------------------------------------------------

export type GlslTokenType = "num" | "ident" | "op";

export interface GlslToken {
  type: GlslTokenType;
  /** num → 数值；ident / op → 原文 */
  value: string | number;
  /** 源文本偏移（报错定位用） */
  pos: number;
}

/** 多字符运算符（按长度降序，先匹配长符号；含复合赋值——效果片段里极常见） */
const MULTI_OPS = ["+=", "-=", "*=", "/=", "==", "!=", "<=", ">=", "&&", "||"];
const SINGLE_OPS = "+-*/=<>!(){}[].,;?:" as const;

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}
function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}
function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

/**
 * 把 GLSL 源码切分为 token 流。
 * 非法字符（受控子集之外的符号）直接跳过并记录到 errors，避免整段失败。
 */
export function tokenize(src: string): { tokens: GlslToken[]; errors: string[] } {
  const tokens: GlslToken[] = [];
  const errors: string[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];

    // 空白
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }

    // 行注释
    if (ch === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      continue;
    }

    // 块注释
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // 预处理指令行（#include / #pragma / #version …）：整行跳过，不进入 AST
    if (ch === "#") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }

    // 数字（含 .5、1.5、1e3、1.5e-2、3f）
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
      // GLSL 浮点后缀 f 不是 JS 数字语法（Number("3f") = NaN），剥掉后再转
      const value = Number(text.replace(/[fF]$/, ""));
      if (Number.isFinite(value)) {
        tokens.push({ type: "num", value, pos: start });
      } else {
        errors.push(`非法数字字面量 '${text}'（偏移 ${start}）`);
      }
      continue;
    }

    // 标识符
    if (isIdentStart(ch)) {
      const start = i;
      while (i < n && isIdentPart(src[i])) i++;
      tokens.push({ type: "ident", value: src.slice(start, i), pos: start });
      continue;
    }

    // 多字符运算符
    const two = src.slice(i, i + 2);
    if (MULTI_OPS.includes(two)) {
      tokens.push({ type: "op", value: two, pos: i });
      i += 2;
      continue;
    }

    // 单字符运算符/标点
    if ((SINGLE_OPS as string).includes(ch)) {
      tokens.push({ type: "op", value: ch, pos: i });
      i++;
      continue;
    }

    // 未知字符：跳过并告警
    errors.push(`忽略无法识别的字符 '${ch}'（偏移 ${i}）`);
    i++;
  }

  return { tokens, errors };
}