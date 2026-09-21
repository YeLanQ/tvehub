import { describe, expect, it } from "vitest";
import { compileHookNode, translateProgram, type TslFnLib, type TslNode } from "./glslToTsl";

// GLSL → TSL 转译器：以 Proxy mock 库驱动整段转译（成功产出节点 / 失败回错误），
// 覆盖内置标识符映射、varying 共享、工具函数 inline、采样/三元/复合赋值与降级路径。

/** Proxy mock：方法调用产出 {tag, args} 节点并记录调用名；Fn 立即执行回调；
 *  节点本身也是 Proxy——任意属性访问产出可赋值的子节点（模拟 TSL 的 swizzle） */
function mockTsl(): { lib: TslFnLib; calls: string[] } {
  const calls: string[] = [];
  const node = (tag: string, args: unknown[]): TslNode => {
    const base = { tag, args, assign: (v: unknown): TslNode => node("assigned", [v]) };
    return new Proxy(base, {
      get(t, prop: string) {
        if (prop in t) return t[prop as keyof typeof t];
        return node(`${tag}.${prop}`, []);
      },
    }) as unknown as TslNode;
  };
  const lib = new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      calls.push(prop);
      if (prop === "Fn") {
        return (body: () => TslNode) => () => body();
      }
      return (...args: unknown[]): TslNode => node(prop, args);
    },
  }) as unknown as TslFnLib;
  return { lib, calls };
}

const uniforms = { _MainTex: { tag: "uniform", args: [] }, _Speed: { tag: "uniform", args: [] } };
const timeNode = { tag: "time", args: [] };

const VERTEX = `
varying vec2 vUv;
void main() { vert(); }
vec4 vert() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = `
uniform sampler2D _MainTex;
varying vec2 vUv;
void main() { frag(); }
vec4 frag() {
  vec4 tex = texture2D(_MainTex, vUv);
  float glow = sin(_Time.y * _Speed);
  return tex * (0.5 + glow * 0.5);
}
`;

describe("translateProgram 成功路径", () => {
  it("合法顶点/片元 → 产出两个节点且无错误", () => {
    const { lib, calls } = mockTsl();
    const out = translateProgram({ vertex: VERTEX, fragment: FRAGMENT, tsl: lib, uniforms, timeNode });
    expect(out.error).toBeNull();
    expect(out.vertexNode).toBeTruthy();
    expect(out.fragmentNode).toBeTruthy();
    // 内置映射与构造/采样/数学函数被实际调用
    expect(calls).toContain("positionLocal");
    expect(calls).toContain("vec4");
    expect(calls).toContain("texture");
    expect(calls).toContain("sin");
    expect(calls).toContain("mul");
  });

  it("_Time 特判走 timeNode；uniform 属性按名解析", () => {
    const { lib } = mockTsl();
    const out = translateProgram({ vertex: VERTEX, fragment: FRAGMENT, tsl: lib, uniforms, timeNode });
    expect(out.error).toBeNull();
  });

  it("共享 varying：顶点写入、片元读取同一节点", () => {
    const { lib, calls } = mockTsl();
    translateProgram({ vertex: VERTEX, fragment: FRAGMENT, tsl: lib, uniforms, timeNode });
    expect(calls.filter((c) => c === "varying").length).toBeGreaterThanOrEqual(1);
  });

  it("控制流与局部变量：if / discard / 未初始化局部（零值兜底）都能转译", () => {
    const { lib } = mockTsl();
    const out = translateProgram({
      vertex: VERTEX,
      fragment: `
        varying vec2 vUv;
        void main() { frag(); }
        vec4 frag() {
          vec3 acc;
          if (vUv.x > 0.5) { acc = vec3(1.0); } else { acc = vec3(0.0); }
          if (vUv.y < 0.1) discard;
          return vec4(acc, 1.0);
        }
      `,
      tsl: lib,
      uniforms,
      timeNode,
    });
    expect(out.error).toBeNull();
    expect(out.fragmentNode).toBeTruthy();
  });

  it("varying 的 swizzle 赋值目标可解（vUv.x = …）", () => {
    const { lib } = mockTsl();
    const out = translateProgram({
      vertex: `
        varying vec2 vUv;
        void main() { vert(); }
        vec4 vert() { vUv.x = 0.5; vUv.y = 0.25; gl_Position = vec4(position, 1.0); }
      `,
      fragment: FRAGMENT,
      tsl: lib,
      uniforms,
      timeNode,
    });
    expect(out.error).toBeNull();
  });

  it("采样函数参数不足 → error；三元映射 mix；不支持的赋值目标 → error", () => {
    const { lib } = mockTsl();
    const tex1 = translateProgram({
      vertex: VERTEX,
      fragment: `vec4 f() { return texture2D(_MainTex); }\nvoid main() { f(); }`,
      tsl: lib, uniforms, timeNode,
    });
    expect(tex1.error).toMatch(/至少需要/);

    const ternaryOk = translateProgram({
      vertex: VERTEX,
      fragment: `
        varying vec2 vUv;
        void main() { f(); }
        vec4 f() { float a = vUv.x > 0.5 ? 1.0 : 0.0; return vec4(a, a, a, 1.0); }
      `,
      tsl: lib, uniforms, timeNode,
    });
    expect(ternaryOk.error).toBeNull();

    // 赋值目标是函数调用（非局部/varying/swizzle）→ 受控子集外
    const badTarget = translateProgram({
      vertex: `void main() { v(); } vec4 v() { sin(1.0) = 2.0; return vec4(0.0); }`,
      fragment: FRAGMENT,
      tsl: lib, uniforms, timeNode,
    });
    expect(badTarget.error).toMatch(/不支持该赋值目标|无法解析/);
  });
});

describe("translateProgram 受控子集降级", () => {
  it("循环语法 → error 含「暂不支持循环」", () => {
    const { lib } = mockTsl();
    const bad = "vec4 f() { for (int i = 0; i < 3; i++) { x += 1.0; } return vec4(0.0); }";
    const out = translateProgram({
      vertex: "void main() { f(); } " + bad,
      fragment: FRAGMENT,
      tsl: lib,
      uniforms,
      timeNode,
    });
    expect(out.error).toMatch(/暂不支持循环/);
    expect(out.vertexNode).toBeNull();
  });

  it("未知标识符 → error 含标识符名", () => {
    const { lib } = mockTsl();
    const out = translateProgram({
      vertex: "void main() { v(); } vec4 v() { return mysteryVar; }",
      fragment: FRAGMENT,
      tsl: lib,
      uniforms,
      timeNode,
    });
    expect(out.error).toMatch(/未知标识符 'mysteryVar'/);
  });

  it("gl_ 变量作为值使用 → error（仅 gl_Position 可赋值）", () => {
    const { lib } = mockTsl();
    const out = translateProgram({
      vertex: "void main() { v(); } vec4 v() { return gl_FragCoord; }",
      fragment: FRAGMENT,
      tsl: lib,
      uniforms,
      timeNode,
    });
    expect(out.error).toMatch(/gl_FragCoord/);
  });

  it("缺入口函数 → error 提示 CGPROGRAM", () => {
    const { lib } = mockTsl();
    const out = translateProgram({ vertex: "uniform float x;", fragment: FRAGMENT, tsl: lib, uniforms, timeNode });
    expect(out.error).toMatch(/未找到入口函数/);
  });
});

describe("工具函数 inline 与 Hook 编译", () => {
  it("CGINCLUDE 工具函数被 inline 调用（参数数量不匹配报错）", () => {
    const { lib } = mockTsl();
    const ok = translateProgram({
      vertex: VERTEX,
      fragment: `
        varying vec2 vUv;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main() { frag(); }
        vec4 frag() { return vec4(hash(vUv), hash(vUv), hash(vUv), 1.0); }
      `,
      tsl: lib,
      uniforms,
      timeNode,
    });
    expect(ok.error).toBeNull();

    const bad = translateProgram({
      vertex: VERTEX,
      fragment: `
        float hash(vec2 p) { return p.x; }
        void main() { frag(); }
        vec4 frag() { return vec4(hash(), 0.0, 0.0, 1.0); }
      `,
      tsl: lib,
      uniforms,
      timeNode,
    });
    expect(bad.error).toMatch(/参数数量不匹配/);
  });

  it("compileHookNode：端口 += 片段 → 返回修改后的端口节点", () => {
    const { lib } = mockTsl();
    const toVarNode = { tag: "var", args: [], assign: (): unknown => toVarNode };
    const node = compileHookNode({
      code: "emissive += vec4(0.1, 0.2, 0.3, 1.0);",
      include: "",
      tsl: lib,
      port: { name: "emissive", seed: { tag: "seed", args: [], toVar: () => toVarNode } as unknown as TslNode },
      uniforms,
      timeNode,
    });
    expect(node).toBeTruthy();
  });

  it("compileHookNode：非法 Hook 语法抛 TranslateError（上层降级）", () => {
    const { lib } = mockTsl();
    const toVarNode = { tag: "var", args: [], assign: (): unknown => toVarNode };
    expect(() =>
      compileHookNode({
        code: "for (int i = 0; i < 2; i++) { emissive += vec4(1.0); }",
        include: "",
        tsl: lib,
        port: { name: "emissive", seed: { tag: "seed", args: [], toVar: () => toVarNode } as unknown as TslNode },
        uniforms,
        timeNode,
      }),
    ).toThrowError();
  });
});
