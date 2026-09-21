import { describe, expect, it } from "vitest";
import { HOOK_ENTRY_NAME, parseStage, TranslateError } from "./glslParser";
import type { Stmt } from "./ast";

// GLSL 受控子集解析器：入口定位（main 包装器 / Hook 合成入口）、语句与表达式
// 结构、优先级与受控子集外语法的报错。

const VERT = `
uniform mat4 mvp;
varying vec3 vNormalW;
void main() { vert(); }
vec4 vert() {
  vNormalW = normalize(normalMatrix * position);
  gl_Position = projectionMatrix * vec4(position, 1.0);
}
`;

describe("parseStage 顶层结构", () => {
  it("uniform 跳过、varying 收集、main 包装器定位入口函数", () => {
    const stage = parseStage(VERT);
    expect(stage.error).toBeNull();
    expect(stage.varyings).toEqual([["vec3", "vNormalW"]]);
    expect(stage.entry?.name).toBe("vert");
    expect(stage.tools).toHaveLength(0);
    // main 不参与翻译，也不会被误选为入口/工具
    expect(stage.entry?.body.kind).toBe("block");
  });

  it("无 main 时 Hook 合成入口按名定位（工具函数不抢入口）", () => {
    const src = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec4 ${HOOK_ENTRY_NAME}(vec4 emissive) {
  emissive += hash(uv);
  return emissive;
}
`;
    const stage = parseStage(src);
    expect(stage.entry?.name).toBe(HOOK_ENTRY_NAME);
    expect(stage.tools.map((f) => f.name)).toEqual(["hash"]);
    expect(stage.tools[0].params).toEqual([["vec2", "p"]]);
  });

  it("仅有工具函数且无 Hook 入口时回退首个非 main 函数", () => {
    const stage = parseStage("float hash(vec2 p) { return 0.0; }");
    expect(stage.entry?.name).toBe("hash");
  });

  it("空源码 / 无函数 → entry 为 null（翻译层回退占位）", () => {
    expect(parseStage("").entry).toBeNull();
    expect(parseStage("uniform float x;").entry).toBeNull();
  });
});

const bodyOf = (src: string): Stmt[] => {
  const stage = parseStage(`void main() { f(); }\nvoid f() { ${src} }`);
  return ((stage.entry?.body as { stmts: Stmt[] }).stmts);
};

describe("语句结构", () => {
  it("变量声明（含初始化与缺初始化）", () => {
    const stmts = bodyOf("float k = 1.5; vec3 c;");
    expect(stmts[0]).toMatchObject({ kind: "var", type: "float", name: "k" });
    expect(stmts[1]).toMatchObject({ kind: "var", type: "vec3", name: "c", init: null });
    expect(((stmts[0] as { init: unknown }).init as { value: number }).value).toBe(1.5);
  });

  it("赋值 / 复合赋值展开为二元（a += b → a = a + b）", () => {
    const stmts = bodyOf("x = x + 1; y *= 2;");
    expect(stmts[0].kind).toBe("assign");
    const compound = stmts[1] as { kind: string; value: { kind: string; op: string } };
    expect(compound.kind).toBe("assign");
    expect(compound.value).toMatchObject({ kind: "binary", op: "*" });
  });

  it("return / discard / if-else（含 else 分支）", () => {
    const stmts = bodyOf(
      "if (a > b) { return a; } else { discard; } return b;",
    );
    const ifStmt = stmts[0] as Extract<Stmt, { kind: "if" }>;
    expect(ifStmt.kind).toBe("if");
    expect(ifStmt.cond).toMatchObject({ kind: "binary", op: ">" });
    expect((ifStmt.then as { stmts: Stmt[] }).stmts[0].kind).toBe("return");
    expect((ifStmt.else as { stmts: Stmt[] }).stmts[0].kind).toBe("discard");
    expect(stmts[1].kind).toBe("return");
  });

  it("循环语句抛受控子集错误", () => {
    expect(() => bodyOf("for (int i = 0; i < 4; i++) { x += 1; }")).toThrowError(TranslateError);
    expect(() => bodyOf("while (true) { discard; }")).toThrowError(/暂不支持循环语句/);
  });

  it("类型构造调用不被误判为声明（vec4(position, 1.0)）", () => {
    const stmts = bodyOf("v = vec4(p, 1.0);");
    const assign = stmts[0] as { value: { kind: string; name: string; args: unknown[] } };
    expect(assign.value.kind).toBe("call");
    expect(assign.value.name).toBe("vec4");
    expect(assign.value.args).toHaveLength(2);
  });
});

describe("表达式优先级与形态", () => {
  const firstExprOf = (src: string): unknown =>
    (bodyOf(`return ${src};`)[0] as { value: unknown }).value;

  it("乘法结合高于加法（a + b * c → binary(+, a, binary(*, b, c))）", () => {
    const e = firstExprOf("a + b * c") as { kind: string; op: string; left: { name: string }; right: { kind: string; op: string } };
    expect(e.kind).toBe("binary");
    expect(e.op).toBe("+");
    expect(e.left.name).toBe("a");
    expect(e.right.op).toBe("*");
  });

  it("关系 > 相等 > 逻辑与 > 逻辑或逐层结合；括号可越级", () => {
    const or = firstExprOf("a == b || c > d && e != f") as { op: string; left: { op: string }; right: { op: string } };
    expect(or.op).toBe("||");
    expect(or.left.op).toBe("==");
    expect(or.right.op).toBe("&&");
    const paren = firstExprOf("(a || b) && c") as { op: string; left: { op: string } };
    expect(paren.op).toBe("&&");
    expect(paren.left.op).toBe("||");
  });

  it("三元规范化为 ternary 调用；一元负号；swizzle 链", () => {
    const ternary = firstExprOf("a > b ? x : y") as { kind: string; name: string; args: unknown[] };
    expect(ternary.kind).toBe("call");
    expect(ternary.name).toBe("ternary");
    expect(ternary.args).toHaveLength(3);
    const neg = firstExprOf("-a") as { kind: string; op: string; operand: { name: string } };
    expect(neg).toMatchObject({ kind: "unary", op: "-" });
    const sw = firstExprOf("color.rgb") as { kind: string; fields: string; base: { name: string } };
    expect(sw).toMatchObject({ kind: "swizzle", fields: "rgb" });
    expect(sw.base.name).toBe("color");
  });

  it("布尔字面量与成员访问限定 swizzle 字符集", () => {
    const bool = firstExprOf("true") as { kind: string; value: boolean };
    expect(bool).toMatchObject({ kind: "bool", value: true });
    expect(() => firstExprOf("a.length")).toThrowError(/不支持的成员访问/);
  });

  it("语法错误定位：缺括号/缺标识符抛 TranslateError 并带偏移", () => {
    expect(() => parseStage("void main() { f(); } vec4 f( { return vec4(0.0); }")).toThrowError(TranslateError);
    expect(() => bodyOf("x = (1 + 2;")).toThrowError(TranslateError);
    expect(() => bodyOf("return a > ? b : c;")).toThrowError(TranslateError);
  });

  it("varying 声明缺分号也能收集（宽容解析到下一条语句）", () => {
    const stage = parseStage("varying vec3 vN vec4 f() { return vec4(0.0); }");
    expect(stage.varyings).toEqual([["vec3", "vN"]]);
  });

  it("顶层无法识别的结构终止扫描（不误读为函数）", () => {
    const stage = parseStage("struct Light { vec3 color; };");
    expect(stage.entry).toBeNull();
  });

  it("返回类型不在白名单的顶层函数不识别（自定义结构体返回）", () => {
    const stage = parseStage("MyStruct f() { return m; }");
    expect(stage.entry).toBeNull();
  });

  it("main 包装器内没有入口调用 → entryName 空，回退首个非 main 函数", () => {
    const stage = parseStage(`
      void main() { }
      vec4 frag() { return vec4(0.0); }
    `);
    expect(stage.entry?.name).toBe("frag");
  });

  it("全局声明缺分号到 EOF 不死循环", () => {
    expect(parseStage("uniform vec3 x").entry).toBeNull();
  });

  it("varying 声明缺名字（EOF）抛 TranslateError", () => {
    expect(() => parseStage("varying vec3")).toThrowError(TranslateError);
  });
});
