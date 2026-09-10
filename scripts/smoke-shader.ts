// ---------------------------------------------------------------------------
// 自定义着色器冒烟测试（Node 运行；vite --ssr 打包）：
// 覆盖 运行时源码解析/程序组装（public/engine/runtime/shaderlab.mjs，与后端
// src-tauri/src/scene/shader.rs 同规则）/ 编辑器侧 uniform 装配与占位回退 /
// 时间 uniform 推进 / 面板参数分组构造。
// 运行：npm run smoke:shader
// ---------------------------------------------------------------------------
import * as THREE from "three";
import { readFileSync } from "node:fs";
import {
  applyCustomProgram,
  buildCustomUniforms,
  customParamGroups,
  customPropDefaults,
  customPropValue,
  registerCustomMaterial,
  tickShaderTime,
  TIME_UNIFORM,
} from "../src/framework/material/customShader";
import { materialTypeRegistry } from "../src/framework/material/factory";
import {
  CUSTOM_SHADER_KIND,
  DEFAULT_MATERIAL_PARAMS,
  type CustomShaderProgram,
  type MaterialParams,
  type ShaderPropertyDef,
} from "../src/framework/material";
// 运行时解析器（导出产物内同款；纯函数无依赖）
import {
  isCustomShader,
  parseCustomShader,
} from "../public/engine/runtime/shaderlab.mjs";

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

function props(over: Partial<MaterialParams> = {}): MaterialParams {
  return { ...DEFAULT_MATERIAL_PARAMS, props: {}, ...over };
}

function main(): void {
  // —— 1. 运行时解析：内置自定义着色器模板 ——
  console.log("[1] shaderlab 解析（internal/shaders/Custom.shader）");
  const template = readFileSync("public/internal/shaders/Custom.shader", "utf8");
  ok(isCustomShader(template), "CGINCLUDE/双 CGPROGRAM 块判为自定义着色器");
  const parsed = parseCustomShader(template, "internal/shaders/Custom.shader");
  ok(parsed.error === null, "模板可组装（无错误）");
  ok(parsed.properties.length === 3, `属性解析 3 项（实际 ${parsed.properties.length}）`);
  const byKey = new Map(parsed.properties.map((p) => [p.key, p]));
  ok(byKey.get("_Color")?.kind === "color" && byKey.get("_Color")?.default === 0xffffff, "Color 属性类型与默认值");
  ok(
    byKey.get("_Speed")?.kind === "range" &&
      byKey.get("_Speed")?.min === 0 &&
      byKey.get("_Speed")?.max === 4,
    "Range 属性上下界",
  );
  const program = parsed.program!;
  ok(program.vertex.includes("void main() { vert(); }"), "顶点入口包装");
  ok(program.fragment.includes("gl_FragColor = frag();"), "片元入口包装（vec4）");
  ok(program.fragment.includes("uniform float _Time;"), "片元引用 _Time → 自动声明");
  ok(program.fragment.includes("uniform vec4 _Color;"), "属性 uniform 自动声明");
  ok(!program.vertex.includes("uniform "), "未被顶点引用的 uniform 不声明");
  ok(
    program.transparent === false && program.depthWrite === true && program.side === "front",
    "缺省渲染状态（不透明/写深度/剔除背面）",
  );

  // 内置分支模板不得误判
  for (const name of ["PBR", "Unlit", "Toon", "SkyBox", "SkyProcedural"]) {
    const t = readFileSync(`public/internal/shaders/${name}.shader`, "utf8");
    ok(!isCustomShader(t), `${name}.shader 不判为自定义着色器`);
  }

  // —— 2. 运行时解析：渲染状态与错误分支 ——
  console.log("[2] shaderlab 渲染状态与错误分支");
  const glow = `Shader "assets/shaders/Glow"
{
    Properties { _Glow ("Glow", Range(0, 5)) = 2 }
    SubShader
    {
        Tags { "RenderType"="Transparent" "ZWrite"="Off" "Cull"="Off" }
        CGINCLUDE
        varying vec2 vUv;
        ENDCG
        CGPROGRAM
        #pragma vertex vert
        void vert() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        ENDCG
        CGPROGRAM
        #pragma fragment frag
        void frag() { gl_FragColor = vec4(vUv, _Glow, 1.0); }
        ENDCG
    }
}`;
  const glowParsed = parseCustomShader(glow, "assets/shaders/Glow.shader");
  ok(glowParsed.error === null, "单行 Properties + 标签写法可组装");
  ok(glowParsed.properties.length === 1 && glowParsed.properties[0].kind === "range", "单行 Properties 解析");
  ok(glowParsed.program!.transparent === true, "Queue/RenderType=Transparent → 半透明");
  ok(glowParsed.program!.depthWrite === false, "ZWrite Off → 关闭深度写入");
  ok(glowParsed.program!.side === "double", "Cull Off → 双面");
  ok(glowParsed.program!.fragment.includes("frag();"), "void 片元入口直接调用");
  ok(
    glowParsed.program!.fragment.includes("#include <tonemapping_fragment>") &&
      glowParsed.program!.fragment.includes("#include <colorspace_fragment>"),
    "包装注入输出阶段（色调映射 + 色彩空间，与内置材质一致）",
  );

  const bad = `Shader "assets/shaders/Bad"
{
    SubShader
    {
        CGINCLUDE
        ENDCG
        CGPROGRAM
        void vert() { gl_Position = vec4(position, 1.0); }
        ENDCG
    }
}`;
  const badParsed = parseCustomShader(bad, "assets/shaders/Bad.shader");
  ok(badParsed.program === null && !!badParsed.error, "缺片元块 → 报错（不组装）");

  // —— 3. 编辑器侧：uniform 装配 ——
  console.log("[3] 编辑器 uniform 装配");
  const properties = parsed.properties as ShaderPropertyDef[];
  const params = props({
    props: { _Color: 0xff8800, _Speed: 2.5 },
  });
  const uniforms = buildCustomUniforms(properties, params);
  const colorUniform = uniforms._Color.value as number[];
  const expected = new THREE.Color().setHex(0xff8800);
  ok(
    Array.isArray(colorUniform) &&
      Math.abs((colorUniform[0] ?? 0) - expected.r) < 1e-6 &&
      Math.abs((colorUniform[1] ?? 0) - expected.g) < 1e-6 &&
      colorUniform[3] === 1,
    "颜色属性 → vec4（sRGB hex 转线性）",
  );
  ok(uniforms._Speed.value === 2.5, "数值属性 → 面板值");
  ok(uniforms[TIME_UNIFORM].value === 0, "内置 _Time uniform 初值 0");
  const defaults = customPropDefaults(properties);
  ok(defaults._Color === 0xffffff && defaults._Speed === 1, "属性默认值（props 缺失回退）");
  ok(customPropValue(properties[0], {}) === 0xffffff, "缺值回退属性默认");
  const groups = customParamGroups(properties);
  ok(
    groups.length === 1 && groups[0].defs.length === 3,
    "面板参数分组由属性表构造（1 组 3 项）",
  );
  ok(
    groups[0].defs[2].key === "_Speed" && groups[0].defs[2].max === 4,
    "分组项携带属性键与上界",
  );

  // —— 4. 编辑器侧：程序装配 / 占位回退 / 时间推进 ——
  console.log("[4] 材质程序装配与时间推进");
  const def = materialTypeRegistry.get(CUSTOM_SHADER_KIND);
  ok(!!def && def.label === "Custom", "注册表包含 custom 类型");
  const mat = def!.create() as THREE.ShaderMaterial;
  ok(def!.matches(mat), "custom 类型 matches = ShaderMaterial");
  const fullProgram: CustomShaderProgram = {
    vertex: program.vertex,
    fragment: program.fragment,
    state: { transparent: program.transparent, depthWrite: program.depthWrite, side: program.side },
  };
  def!.apply(mat, params, undefined, { program: fullProgram, properties });
  ok(mat.vertexShader === fullProgram.vertex && mat.fragmentShader === fullProgram.fragment, "程序写入 ShaderMaterial");
  ok(mat.side === THREE.FrontSide && mat.depthWrite === true && mat.transparent === false, "渲染状态写入");

  // 渲染状态变化（同签名以外）→ 重新编译标记
  const glowProgram: CustomShaderProgram = {
    vertex: fullProgram.vertex,
    fragment: fullProgram.fragment,
    state: { transparent: true, depthWrite: false, side: "double" },
  };
  const versionBefore = mat.version;
  applyCustomProgram(mat, glowProgram);
  ok(
    mat.transparent === true && mat.depthWrite === false && mat.side === THREE.DoubleSide,
    "半透明/双面状态切换",
  );
  // three 的 needsUpdate 无 getter（赋 true 只递增 version），按 version 判断重建标记
  ok(mat.version > versionBefore, "程序变化置 needsUpdate（version 递增）");

  // 程序缺失 → 占位程序（洋红棋盘），渲染不中断
  const placeholderMat = new THREE.ShaderMaterial();
  applyCustomProgram(placeholderMat, null);
  ok(
    placeholderMat.vertexShader.includes("main") && placeholderMat.fragmentShader.includes("gl_FragColor"),
    "程序缺失 → 占位程序仍可渲染",
  );

  // _Time 推进（dispose 后出册）
  registerCustomMaterial(mat);
  tickShaderTime(12.5);
  ok(mat.uniforms[TIME_UNIFORM].value === 12.5, "tickShaderTime 推进 _Time");
  mat.dispose();
  tickShaderTime(99);
  ok(mat.uniforms[TIME_UNIFORM].value === 12.5, "材质释放后不再推进");

  // —— 5. 参数编辑往返（props 深拷贝隔离） ——
  console.log("[5] props 编辑与深拷贝");
  const edited = { ...params, props: { ...params.props, _Speed: 3 } };
  ok(params.props._Speed === 2.5, "编辑后原参数对象不受影响（面板镜像独立）");
  ok(edited.props._Speed === 3, "编辑值写入 props");

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main();
