// ---------------------------------------------------------------------------
// 自定义着色器「网页运行时」端到端冒烟（Node 直接运行，不经打包）：
// 用 fetch 桩把导出产物内的 .mat / .shader 文本喂给 public/engine/runtime 的
// 解析与网格构建链路，验证 custom 材质真的构建为 ShaderMaterial（uniforms /
// 渲染状态 / _Time 推进 / 贴图属性回填 / 程序缺失占位回退）。
// 运行：npm run smoke:shader-runtime
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const root = resolve(import.meta.dirname, "..");
const runtime = (rel) => pathToFileURL(resolve(root, "public/engine/runtime", rel)).href;

// —— 桩：导出产物内的文本资产（.mat / .shader / 贴图）——
const files = new Map();
const shaderText = readFileSync(resolve(root, "public/internal/shaders/Custom.shader"), "utf8");
files.set("assets/shaders/Glow.shader", shaderText);
files.set(
  "assets/shaders/Broken.shader",
  `Shader "assets/shaders/Broken"
{
    SubShader
    {
        CGINCLUDE
        ENDCG
        CGPROGRAM
        void vert() { gl_Position = vec4(position, 1.0); }
        ENDCG
    }
}`,
);
files.set(
  "assets/materials/Glow.mat",
  JSON.stringify({
    $type: "material",
    $ver: 1,
    name: "Glow",
    shader: "assets/shaders/Glow.shader",
    props: { _Color: 0xff8800, _Speed: 2.5 },
    color: "#9aa4b2",
    metalness: 0.1,
    roughness: 0.75,
    opacity: 1,
  }),
);
files.set(
  "assets/materials/Broken.mat",
  JSON.stringify({
    $type: "material",
    $ver: 1,
    name: "Broken",
    shader: "assets/shaders/Broken.shader",
    props: {},
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
const THREE = await import(pathToFileURL(resolve(root, "public/engine/core/three.module.min.js")).href);

const sceneRoot = {
  type: "meshNode",
  id: "m1",
  geometry: "sphere",
  size: { x: 1, y: 1, z: 1 },
  material: "assets/materials/Glow.mat",
};

console.log("[1] 运行时材质解析（.mat + .shader → 程序/属性）");
const materialParams = await loadMaterialParams(sceneRoot);
ok(fetched.includes("assets/materials/Glow.mat"), ".mat 已按引用拉取");
ok(fetched.includes("assets/shaders/Glow.shader"), ".shader 已按引用拉取（二次解析）");
const glow = materialParams.get("assets/materials/Glow.mat");
ok(glow?.type === "custom", `渲染分支 = custom（实际 ${glow?.type}）`);
ok(!!glow?.program, "组装后的顶点/片元程序随材质输出");
ok(Array.isArray(glow?.properties) && glow.properties.length === 3, "属性表随材质输出（3 项）");
ok(glow?.props?._Speed === 2.5, "props 随 .mat 解析");

console.log("[2] 网格构建（custom → ShaderMaterial）");
const mesh = createMesh(sceneRoot, { materialParams, models: new Map() });
const mat = mesh.material;
ok(mat.isShaderMaterial === true, "网格材质为 ShaderMaterial");
ok(mat.vertexShader === glow.program.vertex, "顶点程序来自组装结果");
ok(mat.fragmentShader.includes("gl_FragColor = frag();"), "片元程序含入口包装");
const color = mat.uniforms._Color.value;
const expected = new THREE.Color().setHex(0xff8800);
ok(
  Array.isArray(color) && Math.abs(color[0] - expected.r) < 1e-6 && color[3] === 1,
  "颜色属性 → vec4（sRGB hex 转线性）",
);
ok(mat.uniforms._Speed.value === 2.5, "数值属性 → .mat props 值");
ok(mat.uniforms._Time?.value === 0, "内置 _Time uniform 存在");
ok(mat.side === THREE.FrontSide && mat.transparent === false && mat.depthWrite === true, "缺省渲染状态");
tickShaderTime(7.25);
ok(mat.uniforms._Time.value === 7.25, "tickShaderTime 推进 _Time");

console.log("[3] 程序缺失/组装失败 → 占位程序（渲染不中断）");
const brokenNode = { type: "meshNode", id: "m2", material: "assets/materials/Broken.mat" };
const brokenParams = await loadMaterialParams(brokenNode);
const brokenMat = createMesh(brokenNode, {
  materialParams: brokenParams,
  models: new Map(),
}).material;
ok(brokenMat.isShaderMaterial === true, "组装失败仍构建 ShaderMaterial");
ok(brokenMat.vertexShader.includes("vPlaceholderUv"), "回退占位顶点程序");
ok(brokenMat.fragmentShader.includes("gl_FragColor"), "回退占位片元程序");

const missingNode = { type: "meshNode", id: "m3", material: "assets/materials/Missing.mat" };
const missingParams = await loadMaterialParams(missingNode);
const missingMat = createMesh(missingNode, {
  materialParams: missingParams,
  models: new Map(),
}).material;
// 着色器引用缺失：分支解析回退 PBR（与编辑器 resolve_shader_kind 的缺失回退一致）
ok(missingMat.isMeshPhysicalMaterial === true, "着色器缺失 → 回退 PBR（不中断渲染）");

console.log("[4] 贴图属性回填");
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
  "assets/shaders/Tex.shader",
  `Shader "assets/shaders/Tex"
{
    Properties
    {
        _MainTex ("Base Color Texture", 2D) = "white" {}
    }
    SubShader
    {
        CGINCLUDE
        varying vec2 vUv;
        ENDCG
        CGPROGRAM
        void vert() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        ENDCG
        CGPROGRAM
        vec4 frag() { return texture2D(_MainTex, vUv); }
        ENDCG
    }
}`,
);
files.set("assets/textures/a.png", "stub-binary");
const texScene = { type: "meshNode", id: "m4", material: "assets/materials/Tex.mat" };
const texParams = await loadMaterialParams(texScene);
const texMesh = createMesh(texScene, { materialParams: texParams, models: new Map() });
ok(texMesh.material.fragmentShader.includes("uniform sampler2D _MainTex;"), "贴图属性自动声明 sampler2D");
ok(
  Array.isArray(texMesh.material.userData.customProperties) &&
    texMesh.material.userData.customProperties.length === 1,
  "贴图属性表随材质携带（供 textures.mjs 回填）",
);
await applyMeshTextures([{ obj: texMesh, json: texScene }], texParams);
ok(!!texMesh.material.uniforms._MainTex.value, "贴图资产按 props 引用加载并写入 uniform");

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
