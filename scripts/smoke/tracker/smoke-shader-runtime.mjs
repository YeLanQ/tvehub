// ---------------------------------------------------------------------------
// @priority P0
// 着色器「网页运行时」端到端冒烟（Node 直接运行，不经打包）：
// 用 fetch 桩把导出产物内的 .mat / .shader 文本喂给 public/engine/runtime 的解析
// 与网格构建链路，验证：
//   - .mat 的 shader 引用解析出渲染分支（Base → kind）与钩子数据（Hook + 属性表）；
//   - 网格构建**内置**材质（MeshPhysicalMaterial / MeshBasicMaterial / MeshToonMaterial），
//     Hook 以 onBeforeCompile 注入到内置着色器；
//   - 材质 uniform 表：编译前写入的 .mat props 值被编译后的着色器引用；
//   - _Time 由渲染循环推进；着色器 Properties 的贴图参数由 textures.mjs 回填；
//   - 着色器缺失/Base 缺失/Unlit 不支持的钩子时回退内置材质（不中断渲染）；
//   - WebGPU 路径：同一份 Hook 经 glslToTsl 翻译为 TSL 接到节点材质端口槽位
//     （headless 构造节点图；classFor/matches/applyHooks 与编辑器侧同规则）。
// 运行：pnpm smoke shader-runtime
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createSuite, runtimeURL as runtime } from "../harness.mjs";

const { ok, finish } = createSuite();

const root = resolve(import.meta.dirname, "..", "..", "..");

/** 内置示例：边缘光（PBR + Emissive 钩子 + 颜色/数值属性） */
const rimSrc = readFileSync(resolve(root, "public/repos/effect/RimLight.shader"), "utf8");
/** 内置示例：扫描线（依赖 _Time 的片元钩子） */
const scanSrc = readFileSync(resolve(root, "public/repos/effect/ScanLine.shader"), "utf8");
/** 内置模板（无钩子 → 只选分支不叠效果） */
const pbrTemplate = readFileSync(resolve(root, "public/internal/shaders/PBR.shader"), "utf8");
/** 带贴图属性的着色器（验证 2D 属性 → sampler2D + 贴图回填） */
const texShaderSrc = `Shader "assets/shaders/Tex.shader"
{
    Properties
    {
        _MainTex ("Base Color Texture", 2D) = "white" {}
        _Tint ("Tint", Color) = (1, 1, 1, 1)
    }
    Base "PBR"
    Hook "Diffuse"
    {
        float n = texture2D(_MainTex, uv).r;
        diffuseColor.rgb *= _Tint.rgb * (0.5 + n);
    }
}
`;

// —— 桩：导出产物内的文本资产（.mat / .shader / 贴图）——
const files = new Map();
files.set("internal/shaders/PBR.shader", pbrTemplate);
files.set("assets/shaders/Rim.shader", rimSrc);
files.set("assets/shaders/Scan.shader", scanSrc);
files.set("assets/shaders/Tex.shader", texShaderSrc);
files.set(
  "assets/materials/Rim.mat",
  JSON.stringify({
    $type: "material",
    $ver: 1,
    name: "Rim",
    shader: "assets/shaders/Rim.shader",
    props: { _RimColor: 0xff8800, _RimPower: 4 },
    color: "#9aa4b2",
    metalness: 0.1,
    roughness: 0.75,
    opacity: 1,
  }),
);
files.set(
  "assets/materials/Scan.mat",
  JSON.stringify({
    $type: "material",
    $ver: 1,
    name: "Scan",
    shader: "assets/shaders/Scan.shader",
    props: {},
  }),
);
files.set(
  "assets/materials/Tex.mat",
  JSON.stringify({
    $type: "material",
    $ver: 1,
    name: "Tex",
    shader: "assets/shaders/Tex.shader",
    props: { _MainTex: "assets/textures/a.png" },
  }),
);
files.set(
  "assets/materials/Missing.mat",
  JSON.stringify({
    $type: "material",
    $ver: 1,
    name: "Missing",
    shader: "assets/shaders/NotThere.shader",
    props: {},
  }),
);
files.set("assets/textures/a.png", "stub-binary");
// 旧版 .mat（extended 扩展着色器时代）：extension/extensionProps 字段不再参与解析
files.set(
  "assets/materials/Legacy.mat",
  JSON.stringify({
    $type: "material",
    $ver: 1,
    name: "Legacy",
    shader: "internal/shaders/PBR.shader",
    extension: "assets/shaders/Rim.ext.shader",
    extensionProps: { _RimPower: 2 },
  }),
);

const fetched = [];
globalThis.fetch = async (rel) => {
  fetched.push(String(rel));
  const text = files.get(String(rel));
  if (text === undefined) return { ok: false, status: 404, text: async () => "" };
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => JSON.parse(text),
    blob: async () => ({ size: text.length }),
  };
};

// 运行时按 ImageBitmap 解码贴图：Node 无实现，桩一个（仅用于验证 uniform 回填）
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

const { loadMaterialParams } = await import(runtime("material.mjs"));
const { createMesh, tickShaderTime } = await import(runtime("mesh.mjs"));
const { applyMeshTextures } = await import(runtime("textures.mjs"));
const { hasShaderHooks } = await import(runtime("shaderHooks.mjs"));
const THREE = await import(pathToFileURL(resolve(root, "public/engine/core/three.module.min.js")).href);

const node = (id, mat) => ({
  type: "meshNode",
  id,
  geometry: "sphere",
  size: { x: 1, y: 1, z: 1 },
  material: mat,
});

/** GLSL 注入点桩（与 three 内置片元/顶点着色器的 chunk 位置一致） */
const stubShader = () => ({
  vertexShader: "void main() {\n  #include <begin_vertex>\n}\n",
  fragmentShader: [
    "void main() {",
    "  vec4 diffuseColor = vec4(1.0);",
    "  #include <color_fragment>",
    "  vec3 totalEmissiveRadiance = vec3(0.0);",
    "  #include <emissivemap_fragment>",
    "  gl_FragColor = vec4(diffuseColor.rgb + totalEmissiveRadiance, 1.0);",
    "  #include <dithering_fragment>",
    "}",
  ].join("\n"),
  uniforms: {},
});

const rimNode = node("m1", "assets/materials/Rim.mat");
console.log("[1] 运行时材质解析（.mat + .shader → 分支 + 钩子）");
const rimParams = await loadMaterialParams(rimNode);
ok(fetched.includes("assets/materials/Rim.mat"), ".mat 已按引用拉取");
ok(fetched.includes("assets/shaders/Rim.shader"), ".shader 已按引用拉取（分支 + 钩子）");
const rim = rimParams.get("assets/materials/Rim.mat");
ok(rim?.type === "physical", `渲染分支 = physical（实际 ${rim?.type}）`);
ok(rim?.shaderData?.hooks?.length === 1, "钩子数据随材质输出（1 个钩子）");
ok(
  Array.isArray(rim?.shaderData?.properties) && rim.shaderData.properties.length === 3,
  "属性表随材质输出（3 项）",
);
ok(rim?.props?._RimPower === 4, "着色器参数（props）随 .mat 解析");

console.log("[2] 网格构建（内置材质 + Hook 注入）");
const mesh = createMesh(rimNode, { materialParams: rimParams, models: new Map() });
const mat = mesh.material;
ok(mat.isMeshPhysicalMaterial === true, "网格构建内置 PBR 材质（无独立自定义材质分支）");
ok(mat.isShaderMaterial !== true, "不再构建 ShaderMaterial");
ok(hasShaderHooks(mat) === true, "材质已挂载着色器钩子");
// 不同 Hook 集合必须命中不同 program：否则 three 复用同一条 program，
// 两个网格会渲染成同一个效果（曾表现为"溶解 + 顶点波动 都显示溶解"）
{
  const otherNode = node("m1b", "assets/materials/Scan.mat");
  const otherParams = await loadMaterialParams(otherNode);
  const otherMat = createMesh(otherNode, { materialParams: otherParams, models: new Map() }).material;
  ok(
    mat.customProgramCacheKey() !== otherMat.customProgramCacheKey(),
    "不同 Hook 集合的程序缓存 key 不同（program 不复用）",
  );
  const sameNode = node("m1c", "assets/materials/Rim.mat");
  const sameParams = await loadMaterialParams(sameNode);
  const sameMat = createMesh(sameNode, { materialParams: sameParams, models: new Map() }).material;
  ok(
    mat.customProgramCacheKey() === sameMat.customProgramCacheKey(),
    "同一份 Hook 的材质 key 一致（program 仍可复用）",
  );
}
const shader = stubShader();
mat.onBeforeCompile(shader);
ok(
  shader.fragmentShader.includes("uniform vec4 _RimColor;") &&
    shader.fragmentShader.includes("uniform float _RimPower;"),
  "着色器属性自动声明为 uniform",
);
ok(
  shader.fragmentShader.includes("totalEmissiveRadiance +=") &&
    shader.fragmentShader.indexOf("#include <emissivemap_fragment>") <
      shader.fragmentShader.indexOf("totalEmissiveRadiance +="),
  "Emissive 钩子注入到内置着色器的自发光阶段",
);
// 编译前写入的 .mat 参数必须被编译后的着色器继续引用（同一批 uniform 对象）
const table = mat.userData.__tveHookUniforms;
ok(
  shader.uniforms._RimColor === table._RimColor && shader.uniforms._Time === table._Time,
  "编译后的 uniforms 与材质 uniform 表同一批对象（参数不丢）",
);
const expected = new THREE.Color().setHex(0xff8800);
ok(
  Math.abs(table._RimColor.value.x - expected.r) < 1e-6 && table._RimPower.value === 4,
  "颜色/数值参数来自 .mat 的 props",
);

console.log("[3] _Time 推进与扫描线（uv 映射）");
const scanNode = node("m2", "assets/materials/Scan.mat");
const scanParams = await loadMaterialParams(scanNode);
const scanMat = createMesh(scanNode, { materialParams: scanParams, models: new Map() }).material;
const scanShader = stubShader();
scanMat.onBeforeCompile(scanShader);
ok(
  scanShader.fragmentShader.includes("varying vec2 vExtUv;") &&
    scanShader.vertexShader.includes("vExtUv = uv;"),
  "片元钩子自动补 UV varying（声明 + 顶点赋值）",
);
ok(
  /sin\(\(vExtUv\.y \+ _Time/.test(scanShader.fragmentShader),
  "uv 映射为 vExtUv，_Time 进入钩子代码",
);
tickShaderTime(7.25);
ok(scanMat.userData.__tveHookUniforms._Time.value === 7.25, "tickShaderTime 推进 _Time");

console.log("[4] 着色器贴图参数回填（2D → sampler2D）");
const texNode = node("m3", "assets/materials/Tex.mat");
const texParams = await loadMaterialParams(texNode);
const texMesh = createMesh(texNode, { materialParams: texParams, models: new Map() });
const texMat = texMesh.material;
const texShader = stubShader();
texMat.onBeforeCompile(texShader);
ok(
  texShader.fragmentShader.includes("uniform sampler2D _MainTex;"),
  "2D 属性 → sampler2D 声明（与编辑器属性表口径一致）",
);
await applyMeshTextures([{ obj: texMesh, json: texNode }], texParams);
ok(!!texMat.userData.__tveHookUniforms._MainTex.value, "贴图按 props 引用加载并写入 uniform");

console.log("[5] 缺失着色器与旧格式回退");
const missNode = node("m4", "assets/materials/Missing.mat");
const missParams = await loadMaterialParams(missNode);
const missMat = createMesh(missNode, { materialParams: missParams, models: new Map() }).material;
ok(missMat.isMeshPhysicalMaterial === true, "着色器缺失 → 仍是内置 PBR 材质（不中断渲染）");
ok(hasShaderHooks(missMat) === false, "着色器缺失 → 不注入任何片段");

const legacyNode = node("m5", "assets/materials/Legacy.mat");
const legacyParams = await loadMaterialParams(legacyNode);
const legacy = legacyParams.get("assets/materials/Legacy.mat");
ok(legacy?.type === "physical", "旧 .mat（extension 字段）按 shader 字段解析分支");
ok(legacy?.extensionData === undefined, "旧 extension 字段不再进入运行时材质文档");

console.log("[6] WebGPU 路径（Hook → TSL → 节点材质端口）");
{
  const { createNodeMaterialBackend } = await import(
    pathToFileURL(resolve(root, "public/engine/core/nodeMaterialHooks.mjs")).href
  );
  const backend = createNodeMaterialBackend();
  ok(!!backend, "节点材质后端可创建（three.webgpu.min.js 含 THREE.TSL 与节点材质类）");
  if (backend) {
    const kind = rim?.type ?? "physical";
    const NodeClass = backend.classFor(kind);
    const nodeMat = new NodeClass({ color: 0x9aa4b2, metalness: 0.1, roughness: 0.75 });
    ok(backend.matches(kind, nodeMat), "分支判定：节点材质归入对应分支");
    const errors = backend.applyHooks(kind, nodeMat, rim.shaderData, rim.props || {});
    ok(errors.length === 0, `示例 Hook 全部接线（${errors.length ? errors.join("；") : "无告警"}）`);
    ok(!!nodeMat.emissiveNode, "Emissive 端口 → emissiveNode（与 GL 的 totalEmissiveRadiance 对应）");
    const state = nodeMat.userData.__tveNodeHooks;
    ok(!!state?.timeNode, "节点侧 _Time uniform 已建立");
    backend.tickTime(4.25);
    ok(state.timeNode.value === 4.25, "tickTime 推进节点侧 _Time");
    ok(
      state.uniforms._RimPower && state.uniforms._RimPower.value === 4,
      "着色器属性写进节点侧 uniform（.mat 的 props 生效）",
    );

    // 端口不可用项必须显式报告（Fragment 端口 GPU 侧不支持）
    const fragErr = backend.applyHooks(
      "physical",
      new (backend.classFor("physical"))({}),
      {
        base: "PBR",
        include: "",
        properties: [],
        hooks: [{ name: "Fragment", code: "fragColor.rgb *= 0.5;" }],
      },
      {},
    );
    ok(
      fragErr.some((e) => e.includes("Fragment")),
      `Fragment 端口在 GPU 侧显式报告（${fragErr[0] ?? "无"}）`,
    );

    // 运行时转译器与编辑器侧同规则：复合赋值（+=）可翻译
    const { compileHookNode } = await import(
      pathToFileURL(resolve(root, "public/engine/core/glslToTsl.mjs")).href
    );
    const gpuThree = await import(
      pathToFileURL(resolve(root, "public/engine/core/three.webgpu.min.js")).href
    );
    const TSL = gpuThree.TSL;
    let translated = true;
    try {
      compileHookNode({
        code: "float k = _Amount * 0.5;\nemissive += vec3(k);",
        include: "",
        tsl: TSL,
        port: { name: "emissive", seed: TSL.materialEmissive },
        idents: {},
        uniforms: { _Amount: TSL.uniform(2) },
        timeNode: TSL.uniform(0),
      });
    } catch (e) {
      translated = false;
      console.error("    ", e?.message ?? e);
    }
    ok(translated, "运行时转译器支持复合赋值与局部变量再赋值（emissive += …；k = …）");

    // 回归：CGINCLUDE 工具函数（hash/noise）+ Hook 调用工具函数 —— 入口必须选中
    // __tve_hook__ 而不是首个工具函数（此前工具函数被误当入口，形参解析报
    // "未知标识符"，节点材质构建失败渲染成黑）
    const { parseStage } = await import(
      pathToFileURL(resolve(root, "public/engine/core/glslToTsl.mjs")).href
    );
    const toolInclude = `
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
    `;
    const stage = parseStage(
      `${toolInclude}\nvec4 __tve_hook__(vec4 diffuseColor) { float n = noise(uv * _NoiseScale); return diffuseColor; }\n`,
    );
    ok(stage.entry?.name === "__tve_hook__", "合成 Hook 源码的入口 = __tve_hook__（而非首个工具函数）");
    ok(
      stage.tools.some((f) => f.name === "noise") && stage.tools.some((f) => f.name === "hash"),
      "CGINCLUDE 工具函数（hash/noise）留在工具表供 inline 展开",
    );
    let translatedWithTools = true;
    try {
      const node = compileHookNode({
        code: "float n = noise(uv * _NoiseScale);\nif (n < _Threshold) discard;\ndiffuseColor.rgb *= n;",
        include: toolInclude,
        tsl: TSL,
        port: { name: "diffuseColor", seed: TSL.vec4(TSL.materialColor.rgb, TSL.materialOpacity) },
        idents: { uv: TSL.uv() },
        uniforms: { _NoiseScale: TSL.uniform(8), _Threshold: TSL.uniform(0.35) },
        timeNode: TSL.uniform(0),
      });
      translatedWithTools = !!node;
    } catch (e) {
      translatedWithTools = false;
      console.error("    ", e?.message ?? e);
    }
    ok(
      translatedWithTools,
      "调用工具函数的 Hook 走完编译（噪声溶解场景；TSL Fn 惰性求值，构建期错误由入口选择用例把关）",
    );
  }
}

finish();
