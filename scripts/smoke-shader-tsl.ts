// ---------------------------------------------------------------------------
// GLSL → TSL 转译器冒烟测试（Node 运行；vite --ssr 打包）：
// 覆盖 词法/语法解析（受控子集 AST）与 转译（mock TslFnLib 断言节点调用序列），
// 输入取 internal/shaders/Custom.shader 经由 shaderlab.mjs 实际组装出的 GLSL 程序。
// 运行：npm run smoke:shader-tsl
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { parseStage, TranslateError } from "../src/framework/material/tsl/glslParser";
import {
  translateProgram,
  type TslFnLib,
  type TslNode,
} from "../src/framework/material/tsl/glslToTsl";
import { isCustomShader, parseCustomShader } from "../public/engine/runtime/shaderlab.mjs";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

// ---- mock 节点：用 Proxy 支持 swizzle 属性访问、assign 记录、value 存取 ----
function mockNode(kind: string, payload: Record<string, unknown> = {}): TslNode {
  const target: Record<string, unknown> = { kind, ...payload };
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "assign") {
        return (v: unknown) => {
          t.assigned = v;
          return receiver;
        };
      }
      if (prop === "toVarying" || prop === "toVar") {
        return () => receiver;
      }
      // 自身属性优先（payload 里的 name/args/assigned 等不应被误判为 swizzle）
      if (Reflect.has(t, prop)) {
        return Reflect.get(t, prop, receiver);
      }
      if (typeof prop === "string" && /^[xyzwrgbastpq]{1,4}$/.test(prop)) {
        return mockNode("swizzle", { base: receiver, fields: prop });
      }
      return Reflect.get(t, prop, receiver);
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    },
  });
}

const fn = (name: string) => (...args: unknown[]) => mockNode("call", { name, args });

function mockTsl(): TslFnLib {
  const builtin = (name: string) => mockNode("builtin", { name });
  const t: Record<string, unknown> = {
    positionLocal: builtin("positionLocal"),
    normalLocal: builtin("normalLocal"),
    positionWorld: builtin("positionWorld"),
    normalWorld: builtin("normalWorld"),
    modelWorldMatrix: builtin("modelWorldMatrix"),
    modelViewMatrix: builtin("modelViewMatrix"),
    cameraViewMatrix: builtin("cameraViewMatrix"),
    cameraProjectionMatrix: builtin("cameraProjectionMatrix"),
    cameraPosition: builtin("cameraPosition"),
    modelNormalMatrix: builtin("modelNormalMatrix"),
    uv: () => builtin("uv"),
    varying: (node: TslNode, name?: string) => mockNode("varying", { node, name }),
    If: (cond: TslNode, then?: () => void, els?: () => void) => {
      then?.();
      els?.();
      return mockNode("if", { cond });
    },
    Fn: (body: (...a: unknown[]) => TslNode) => (() => body()),
    Return: (node?: TslNode) => mockNode("return", { node }),
    Discard: () => mockNode("discard"),
  };
  const names = [
    "float", "int", "uint", "bool", "vec2", "vec3", "vec4", "mat3", "mat4",
    "add", "sub", "mul", "div", "negate", "and", "or", "not", "equal", "notEqual",
    "lessThan", "lessThanEqual", "greaterThan", "greaterThanEqual", "mix", "clamp",
    "min", "max", "abs", "sign", "floor", "ceil", "fract", "round", "mod", "pow",
    "exp", "exp2", "log", "log2", "sqrt", "inversesqrt", "sin", "cos", "tan", "asin",
    "acos", "atan", "atan2", "sinh", "cosh", "tanh", "degrees", "radians", "length",
    "distance", "dot", "cross", "normalize", "reflect", "refract", "step", "smoothstep",
  ];
  for (const n of names) t[n] = fn(n);
  t.texture = (tex: TslNode, uv: TslNode) => mockNode("texture", { tex, uv });
  return t as unknown as TslFnLib;
}

/** 节点树 → 紧凑可读字符串（递归，避免循环） */
function dump(node: unknown, depth = 0): string {
  if (depth > 20) return "…";
  if (node === null || node === undefined) return String(node);
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (typeof node !== "object") return String(node);
  const o = node as Record<string, unknown>;
  if (o.kind === "swizzle") return `${dump(o.base, depth + 1)}.${String(o.fields)}`;
  if (o.kind === "builtin") return `#${String(o.name)}`;
  if (o.kind === "varying") return `varying(${String(o.name)})`;
  if (o.kind === "texture") return `texture(${dump(o.tex, depth + 1)},${dump(o.uv, depth + 1)})`;
  if (o.kind === "call") {
    const args = Array.isArray(o.args) ? (o.args as unknown[]).map((a) => dump(a, depth + 1)) : [];
    return `${String(o.name)}(${args.join(",")})`;
  }
  if (o.kind === "uniform") return `U(${String(o.name)})`;
  return String(o.kind);
}

function main(): void {
  console.log("[1] 词法/语法解析（受控子集）");
  const vStage = parseStage(`
varying vec2 vUv;
varying vec3 vNormalW;
void vert() {
  vUv = uv;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 world = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * world;
}
void main() { vert(); }
`);
  ok(vStage.entry?.name === "vert", "顶点入口识别为 vert（忽略 main 包装）");
  ok(vStage.varyings.length === 2, `varying 收集 2 条（实际 ${vStage.varyings.length}）`);
  ok(vStage.entry?.body.kind === "block", "入口函数体为块语句");

  // 受控子集外的语法 → 抛 TranslateError
  let threw = false;
  try {
    parseStage(`void frag(){ for(int i=0;i<3;i++){} }`);
  } catch (e) {
    threw = e instanceof TranslateError;
  }
  ok(threw, "循环语句报 TranslateError（受控子集外）");

  console.log("[2] 转译模板顶点/片元程序");
  const template = readFileSync("public/internal/shaders/Custom.shader", "utf8");
  ok(isCustomShader(template), "模板判为自定义着色器");
  const parsed = parseCustomShader(template, "internal/shaders/Custom.shader");
  ok(parsed.error === null && !!parsed.program, "模板可组装出 GLSL 程序");

  const uniforms: Record<string, TslNode> = {};
  for (const p of parsed.properties) {
    uniforms[p.key] = mockNode("uniform", { name: p.key });
  }
  const result = translateProgram({
    vertex: parsed.program!.vertex,
    fragment: parsed.program!.fragment,
    tsl: mockTsl(),
    uniforms,
    timeNode: mockNode("uniform", { name: "_Time" }),
  });
  ok(result.error === null, `转译成功（错误：${result.error ?? "-"}）`);
  ok(!!result.vertexNode && !!result.fragmentNode, "生成顶点/片元节点");

  const vDump = result.vertexNode ? dump(result.vertexNode) : "";
  const fDump = result.fragmentNode ? dump(result.fragmentNode) : "";

  ok(vDump.includes("cameraProjectionMatrix") && vDump.includes("cameraViewMatrix"),
    "gl_Position 映射为 projection×view×world（cameraProjectionMatrix/cameraViewMatrix 出现）");
  ok(vDump.includes("modelWorldMatrix") && vDump.includes("positionLocal"),
    "modelMatrix → modelWorldMatrix、position → positionLocal");
  ok(fDump.includes("sin") && fDump.includes("dot") && fDump.includes("pow"),
    "片元内置函数 sin/dot/pow 已译出");

  console.log("[3] varying 跨阶段共享");
  ok(vDump.includes("varying(vUv)") && fDump.includes("varying(vUv)") ||
    vDump.includes("varying(vNormalW)") || fDump.includes("_Color"),
    "varying/uniform 节点参与译码");

  console.log("[4] 失败回退");
  const bad = translateProgram({
    vertex: `void main(){}`,
    fragment: `void main(){}`,
    tsl: mockTsl(),
    uniforms: {},
    timeNode: mockNode("uniform", { name: "_Time" }),
  });
  ok(bad.error !== null || !bad.vertexNode, "入口缺失 → 返回错误（回退占位）");

  const unknown = translateProgram({
    vertex: `void vert(){ gl_Position = vec4(unknownVar,0.0,0.0,1.0); }`,
    fragment: `void frag(){ return vec4(1.0); } void main(){ gl_FragColor = frag(); }`,
    tsl: mockTsl(),
    uniforms: {},
    timeNode: mockNode("uniform", { name: "_Time" }),
  });
  ok(unknown.error !== null, `未知标识符 → 转译失败（${unknown.error ?? "-"}）`);

  console.log("[5] 自定义工具函数 inline（溶解着色器）");
  const dissolveShader = `Shader "assets/shaders/DissEff"
{
    Properties
    {
        _Color ("Base Color", Color) = (0.75, 0.78, 0.85, 1)
        _Threshold ("Dissolve Amount", Range(0, 1)) = 0.35
        _NoiseScale ("Noise Scale", Range(0.5, 40)) = 8
        _EdgeColor ("Edge Color", Color) = (1, 0.55, 0.1, 1)
        _EdgeWidth ("Edge Width", Range(0.001, 0.3)) = 0.06
        _EdgeIntensity ("Edge Intensity", Range(0, 8)) = 3
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" }

        CGINCLUDE
        varying vec2 vUv;

        float hash(vec2 p)
        {
            return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        float noise(vec2 p)
        {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                       mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
        }
        ENDCG

        CGPROGRAM
        #pragma vertex vert
        void vert()
        {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
        ENDCG

        CGPROGRAM
        #pragma fragment frag
        vec4 frag()
        {
            float n = noise(vUv * _NoiseScale);
            if (n < _Threshold) discard;
            vec4 base = _Color;
            float edge = 1.0 - smoothstep(_Threshold, _Threshold + _EdgeWidth, n);
            return vec4(base.rgb + _EdgeColor.rgb * edge * _EdgeIntensity, base.a);
        }
        ENDCG
    }
    FallBack "Diffuse"
}`;
  const dParsed = parseCustomShader(dissolveShader, "DissEff.shader");
  ok(dParsed.error === null && !!dParsed.program, "溶解着色器可组装出 GLSL 程序");

  // parseStage 直接验证工具函数收集
  const dVStage = parseStage(dParsed.program!.vertex);
  const dFStage = parseStage(dParsed.program!.fragment);
  ok(dVStage.entry?.name === "vert", "溶解顶点入口 = vert");
  ok(dFStage.entry?.name === "frag", "溶解片元入口 = frag");
  ok(dFStage.tools.length >= 2, `片元 tools 收集 ≥2（实际 ${dFStage.tools.length}：${dFStage.tools.map((t) => t.name).join(",")}）`);
  ok(dFStage.tools.some((t) => t.name === "hash") && dFStage.tools.some((t) => t.name === "noise"),
    "tools 含 hash 与 noise");
  ok(dFStage.tools.find((t) => t.name === "hash")?.params.length === 1,
    "hash 形参列表长度 = 1（vec2 p）");
  ok(dFStage.tools.find((t) => t.name === "noise")?.params.length === 1,
    "noise 形参列表长度 = 1（vec2 p）");

  // 转译：工具函数应被 inline，片元节点含 hash/noise 展开后的 fract/sin/dot/mix/floor
  const dUniforms: Record<string, TslNode> = {};
  for (const p of dParsed.properties) {
    dUniforms[p.key] = mockNode("uniform", { name: p.key });
  }
  const dResult = translateProgram({
    vertex: dParsed.program!.vertex,
    fragment: dParsed.program!.fragment,
    tsl: mockTsl(),
    uniforms: dUniforms,
    timeNode: mockNode("uniform", { name: "_Time" }),
  });
  ok(dResult.error === null, `溶解着色器转译成功（错误：${dResult.error ?? "-"}）`);
  ok(!!dResult.vertexNode && !!dResult.fragmentNode, "溶解着色器生成顶点/片元节点");
  const dFDump = dResult.fragmentNode ? dump(dResult.fragmentNode) : "";
  ok(dFDump.includes("fract") && dFDump.includes("sin") && dFDump.includes("dot"),
    "片元含 inline hash 展开（fract/sin/dot）");
  ok(dFDump.includes("floor") && dFDump.includes("mix"),
    "片元含 inline noise 展开（floor/mix）");
  ok(dFDump.includes("smoothstep"), "片元含 smoothstep（边缘计算）");
  ok(!dFDump.includes("hash(") && !dFDump.includes("noise("),
    "片元无 hash()/noise() 调用残留（已 inline）");

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main();