import { describe, expect, it } from "vitest";
import { tokenize } from "./glslLexer";

// GLSL 词法分析器：数字形态、标识符、多字符运算符、注释与预处理指令跳过、非法字符。

describe("tokenize 数字", () => {
  it("整数 / 小数 / 前置点 / 科学计数 / f 后缀", () => {
    const { tokens } = tokenize("1 2.5 .5 1e3 1.5e-2 3f");
    const nums = tokens.map((t) => t.value);
    expect(nums).toEqual([1, 2.5, 0.5, 1000, 0.015, 3]);
    expect(tokens.every((t) => t.type === "num")).toBe(true);
  });

  it("非法数字字面量记入 errors 不产出 token", () => {
    const { tokens, errors } = tokenize("1e999");
    expect(tokens).toHaveLength(0);
    expect(errors[0]).toMatch(/非法数字/);
  });
});

describe("tokenize 标识符与运算符", () => {
  it("标识符含下划线与数字", () => {
    const { tokens } = tokenize("vNormalW _t _Time2 vec3");
    expect(tokens.map((t) => t.value)).toEqual(["vNormalW", "_t", "_Time2", "vec3"]);
  });

  it("多字符运算符优先于单字符（+= == != <= && || …）", () => {
    const { tokens } = tokenize("a += b; x == y; p != q; l <= r; u && v; m || n;");
    const ops = tokens.filter((t) => t.type === "op").map((t) => t.value);
    expect(ops).toEqual(["+=", ";", "==", ";", "!=", ";", "<=", ";", "&&", ";", "||", ";"]);
  });

  it("全部单字符运算符与标点可识别", () => {
    const { tokens } = tokenize("+-*/=<>!(){}[].,;?:");
    expect(tokens).toHaveLength(18);
    expect(tokens.every((t) => t.type === "op")).toBe(true);
  });
});

describe("注释 / 预处理 / 非法字符", () => {
  it("行注释与块注释整体跳过", () => {
    const { tokens } = tokenize("a // 注释到行尾\n b /* 块\n注释 */ c");
    expect(tokens.map((t) => t.value)).toEqual(["a", "b", "c"]);
  });

  it("预处理指令行（#include/#pragma/#version）整行跳过", () => {
    const { tokens } = tokenize("#version 300 es\n#pragma vertex vert\nfloat x;");
    expect(tokens.map((t) => t.value)).toEqual(["float", "x", ";"]);
  });

  it("未知字符跳过并告警（含偏移）", () => {
    const { tokens, errors } = tokenize("a @ b");
    expect(tokens.map((t) => t.value)).toEqual(["a", "b"]);
    expect(errors[0]).toMatch(/无法识别的字符 '@'/);
  });

  it("空串与纯空白返回空 token 流", () => {
    expect(tokenize("").tokens).toEqual([]);
    expect(tokenize(" \t\r\n ").tokens).toEqual([]);
  });
});
