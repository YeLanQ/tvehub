// ---------------------------------------------------------------------------
// 着色器冒烟测试（Node 运行；vite --ssr 打包）：
// .shader = 效果着色器资产（Properties + Base + CGINCLUDE + Hook），是自定义着色
// 效果的唯一载体。本测试覆盖编辑器侧：
//   - 三个内置模板（PBR/Unlit/卡通）的解析（Base 与请求分支一致、模板默认无参数无钩子）；
//   - 内置示例着色器的解析（钩子 + 属性表）；
//   - 分支 × 钩子校验（Unlit 不支持 Normal/Emissive，片元钩子不能用 viewDir/normal）；
//   - 属性表 → 面板参数分组/默认值；
//   - **同一份 Hook 的两条落地路径**：
//     WebGL → onBeforeCompile 注入 GLSL（钩子落到正确 #include 位置 + 变量映射 + uniform）；
//     WebGPU → 翻译为 TSL 接到节点槽位（positionNode/colorNode/emissiveNode/normalNode）；
//   - uniform 表：编译前写入的值被编译后的着色器继续引用；_Time 两条路径都推进；
//   - 不支持项显式报告（Fragment 端口 GPU 侧不生效、受控子集外语法转译失败）。
// 运行：npm run smoke:shader
// ---------------------------------------------------------------------------
import * as THREE from "three";
import { readFileSync, readdirSync } from "node:fs";
import {
  applyShaderHooks,
  hookDataOf,
  hookMaterialCount,
  hasShaderHooks,
  shaderParamGroups,
  shaderPropDefaults,
  tickAllHookTime,
  type ShaderHookData,
} from "../src/framework/material/shaderHooks";
import { materialTypeRegistry, DEFAULT_MATERIAL_TYPE } from "../src/framework/material/factory";
import {
  loadNodeMaterialBackend,
  nodeHookMaterialCount,
  setNodeMaterialBackend,
  tickAllNodeHookTime,
} from "../src/framework/material/nodeMaterialBackend";
import type { ShaderDoc, ShaderPropertyDef } from "../src/framework/material";
import { parseShader, shaderKind } from "../public/engine/runtime/shader.mjs";

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

/** 内置模板（与后端 serialize_shader_file 产物一致） */
function template(kind: string): { text: string; rel: string } {
  const stem = kind === "unlit" ? "Unlit" : kind === "toon" ? "Toon" : "PBR";
  const rel = `internal/shaders/${stem}.shader`;
  return { text: readFileSync(`public/${rel}`, "utf8"), rel };
}

/** 内置示例效果着色器（全部读盘；示例被改坏时在此拦住） */
function exampleFiles(): { file: string; text: string }[] {
  const dir = "public/repos/effect";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".shader"))
    .sort()
    .map((file) => ({ file, text: readFileSync(`${dir}/${file}`, "utf8") }));
}

/** 解析结果 → 编辑器侧钩子数据 */
function dataOf(text: string): ShaderHookData {
  const p = parseShader(text);
  return { base: p.base, include: p.include, hooks: p.hooks, properties: p.properties };
}

/** 无钩子的着色器文档（如内置模板） */
function plainDoc(): ShaderDoc {
  return {
    name: "PBR",
    kind: "physical",
    source: "",
    base: "PBR",
    include: "",
    hooks: [],
    properties: [],
    error: null,
  };
}

/** 桩内建着色器（GLSL 只保留注入点标记，便于断言注入位置） */
function stubBuiltinShader(): {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, THREE.IUniform>;
} {
  return {
    vertexShader: [
      "void main() {",
      "  #include <begin_vertex>",
      "  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);",
      "}",
    ].join("\n"),
    fragmentShader: [
      "void main() {",
      "  vec4 diffuseColor = vec4(1.0);",
      "  #include <color_fragment>",
      "  vec3 totalEmissiveRadiance = vec3(0.0);",
      "  #include <emissivemap_fragment>",
      "  #include <normal_fragment_maps>",
      "  gl_FragColor = vec4(diffuseColor.rgb + totalEmissiveRadiance, 1.0);",
      "  #include <dithering_fragment>",
      "}",
    ].join("\n"),
    uniforms: {} as Record<string, THREE.IUniform>,
  };
}

async function main(): Promise<void> {
  // —— 1. 内置模板：Base 与分支一致、默认无参数无钩子 ——
  console.log("[1] 内置着色器模板（PBR / Unlit / 卡通）");
  for (const [kind, base] of [
    ["physical", "PBR"],
    ["unlit", "Unlit"],
    ["toon", "Toon"],
  ] as const) {
    const { text } = template(kind);
    const parsed = parseShader(text);
    ok(parsed.error === null, `${kind} 模板可解析（${parsed.error ?? "无错误"}）`);
    ok(parsed.base === base, `${kind} 模板 Base = ${base}（实际 ${parsed.base}）`);
    ok(
      parsed.properties.length === 0 && parsed.hooks.length === 0,
      `${kind} 模板默认不含实际属性/钩子（示例都在注释里）`,
    );
    ok(shaderKind(text) === kind, `${kind} 模板的渲染分支解析 = ${kind}`);
  }

  // —— 2. 示例着色器：Base + Hook + 属性 ——
  console.log("[2] 内置示例效果着色器（public/repos/effect/*.shader）");
  const examples = exampleFiles();
  ok(examples.length >= 4, `示例数量 ≥ 4（实际 ${examples.length}）`);
  for (const { file, text } of examples) {
    const parsed = parseShader(text);
    ok(
      parsed.error === null && parsed.hooks.length > 0 && parsed.properties.length > 0,
      `${file} 可解析（Base ${parsed.base} · ${parsed.hooks.length} 钩子 / ${parsed.properties.length} 属性）`,
    );
  }

  // —— 3. 分支 × 钩子校验 ——
  console.log("[3] 分支 × 钩子校验（与 three 内置着色器的注入点一致）");
  const emissiveOnUnlit =
    'Shader "x"\n{\n    Base "Unlit"\n    Hook "Emissive" { emissive += vec3(1.0); }\n}\n';
  ok(
    (parseShader(emissiveOnUnlit).error ?? "").includes("不适用于 Unlit 分支"),
    "Unlit 上写 Emissive 钩子 → 报错（Unlit 无自发光阶段）",
  );
  const viewDirOnUnlit =
    'Shader "x"\n{\n    Base "Unlit"\n    Hook "Diffuse" { diffuseColor.rgb *= 0.5 + dot(normal, viewDir); }\n}\n';
  ok(
    (parseShader(viewDirOnUnlit).error ?? "").includes("viewDir / normal"),
    "Unlit 片元钩子用 viewDir/normal → 报错（片元阶段无 vViewPosition）",
  );
  const vertexOnUnlit =
    'Shader "x"\n{\n    Base "Unlit"\n    Hook "Vertex" { position += normal * 0.1; }\n}\n';
  ok(parseShader(vertexOnUnlit).error === null, "Unlit 顶点钩子可用（顶点阶段有 normal 属性）");
  const noBase = 'Shader "x"\n{\n    Hook "Fragment" { fragColor.rgb *= 0.5; }\n}\n';
  ok(
    (parseShader(noBase).error ?? "").includes("未声明 Base"),
    "缺 Base → 报错（材质仍回退按默认分支渲染）",
  );
  ok(shaderKind(noBase) === null, "缺 Base 时不解析出渲染分支（调用方回退默认）");

  // —— 4. 属性表 → 分组/默认值 ——
  console.log("[4] 属性表 → 面板参数分组与默认值");
  const rim = examples.find((e) => e.file.startsWith("RimLight"))!;
  const rimData = dataOf(rim.text);
  const rimProps = rimData.properties as ShaderPropertyDef[];
  ok(rimData.hooks[0].name === "Emissive", "边缘光示例钩子为 Emissive");
  const groups = shaderParamGroups(rimProps);
  ok(groups.length === 1 && groups[0].defs.length === rimProps.length, "属性 → 单个参数分组");
  ok(
    groups[0].defs[0].key === rimProps[0].key && groups[0].defs[0].kind === "color",
    "颜色属性 → color 控件",
  );
  const defaults = shaderPropDefaults(rimProps);
  ok(
    typeof defaults._RimColor === "number" && defaults._RimPower === 3,
    "默认值来自 Properties 声明（颜色 hex / 数值）",
  );

  // —— 5. 钩子注入（onBeforeCompile 字符串替换 + 变量映射 + uniform） ——
  console.log("[5] 钩子注入内置材质");
  ok(
    materialTypeRegistry.get("physical") !== null &&
      materialTypeRegistry.get("unlit") !== null &&
      materialTypeRegistry.get("toon") !== null,
    "PBR / Unlit / 卡通 三个渲染分支都已注册（效果统一走这三个出口）",
  );
  ok(materialTypeRegistry.get(DEFAULT_MATERIAL_TYPE) !== null, "默认分支可解析");

  const mat = new THREE.MeshPhysicalMaterial();
  applyShaderHooks(mat, rimData, { _RimColor: 0xff8800, _RimPower: 4 });
  ok(hasShaderHooks(mat), "材质标记为已挂钩子");
  ok(hookMaterialCount() > 0, "材质登记进 _Time 推进表");
  const shader = stubBuiltinShader();
  mat.onBeforeCompile(shader as never);
  ok(
    shader.fragmentShader.includes("totalEmissiveRadiance +="),
    "emissive 变量映射为 totalEmissiveRadiance",
  );
  ok(
    shader.fragmentShader.indexOf("#include <emissivemap_fragment>") <
      shader.fragmentShader.indexOf("totalEmissiveRadiance +="),
    "注入位置在 emissivemap_fragment 之后",
  );
  ok(
    shader.fragmentShader.includes("uniform vec4 _RimColor;") &&
      shader.fragmentShader.includes("uniform float _RimPower;") &&
      shader.fragmentShader.includes("uniform float _Time;"),
    "属性与 _Time 的 uniform 声明随注入补齐",
  );
  // uniform 表：编译前写入的值必须被编译后的着色器继续引用（参数不丢）
  const table = mat.userData.__tveHookUniforms as Record<string, THREE.IUniform>;
  ok(
    shader.uniforms._RimColor === table._RimColor && shader.uniforms._Time === table._Time,
    "编译后的 shader.uniforms 与材质 uniform 表是同一批对象（编译前赋值不丢）",
  );
  const expected = new THREE.Color().setHex(0xff8800);
  ok(
    Math.abs((table._RimColor.value as THREE.Vector4).x - expected.r) < 1e-6,
    "颜色参数 → 线性 vec4（与 PBR 管线一致）",
  );
  ok(table._RimPower.value === 4, "数值参数取 .mat 的 props 值");

  // —— 6. UV varying / Vertex 钩子 / 清除与失败回退 ——
  console.log("[6] UV varying、Vertex 钩子与清除/失败回退");
  const wave = examples.find((e) => e.file.startsWith("VertexWave"))!;
  const vertMat = new THREE.MeshPhysicalMaterial();
  applyShaderHooks(vertMat, dataOf(wave.text), {});
  const vertShader = stubBuiltinShader();
  vertMat.onBeforeCompile(vertShader as never);
  ok(
    vertShader.vertexShader.includes("transformed +="),
    "Vertex 钩子：position 映射为 transformed 并注入 begin_vertex 之后",
  );
  ok(!vertShader.fragmentShader.includes("vExtUv"), "仅顶点钩子时不注入片元用 UV varying");

  const scanMat = new THREE.MeshPhysicalMaterial();
  applyShaderHooks(scanMat, dataOf(examples.find((e) => e.file.startsWith("ScanLine"))!.text), {});
  const scanShader = stubBuiltinShader();
  scanMat.onBeforeCompile(scanShader as never);
  ok(
    scanShader.fragmentShader.includes("varying vec2 vExtUv;") &&
      scanShader.vertexShader.includes("vExtUv = uv;"),
    "片元钩子自动补 UV varying（声明 + 顶点赋值）",
  );
  ok(
    /sin\(\(vExtUv\.y \+ _Time/.test(scanShader.fragmentShader),
    "uv 映射为 vExtUv，_Time 可用于时间动画",
  );

  tickAllHookTime(12.5);
  const timeUniform = (mat.userData.__tveHookUniforms as Record<string, THREE.IUniform>)._Time;
  ok(timeUniform.value === 12.5, "tickAllHookTime 推进 _Time（秒）");

  const plainData = hookDataOf(plainDoc());
  ok(plainData !== null && plainData.hooks.length === 0, "无钩子的着色器也构成钩子数据（不注入）");
  const clearedMat = new THREE.MeshPhysicalMaterial();
  applyShaderHooks(clearedMat, dataOf(rim.text), {});
  applyShaderHooks(clearedMat, plainData, {});
  ok(!hasShaderHooks(clearedMat), "切到无 Hook 的着色器 → 清除注入标记");

  const badData = hookDataOf({
    ...plainDoc(),
    hooks: [{ name: "Emissive", code: "emissive += vec3(1.0);" }],
    error: "未知钩子名",
  } as ShaderDoc);
  ok(badData === null, "解析失败的着色器 → 钩子数据为 null（不注入，仍按 Base 分支渲染）");

  // —— 7. WebGPU 路径：同一份 Hook 翻译为 TSL 接节点槽位 ——
  console.log("[7] WebGPU 路径（Hook → TSL → 节点材质端口）");
  const backend = await loadNodeMaterialBackend();
  if (!backend) {
    ok(false, "节点材质后端可加载（three/webgpu + three/tsl）");
  } else {
    setNodeMaterialBackend(backend);
    ok(true, "节点材质后端已加载");

    // 各示例 × 各自 Base 分支：钩子应全部接线成功（除显式不支持的端口）
    for (const { file, text } of examples) {
      const data = dataOf(text);
      const kind = shaderKind(text) ?? "physical";
      const mat = backend.create(kind);
      const errors = backend.applyHooks(kind, mat, data, {});
      ok(
        errors.length === 0,
        `${file}（${kind}）钩子全部接线（${errors.length ? errors.join("；") : "无告警"}）`,
      );
      // 端口落到对应槽位：位置/基色/自发光/法线
      const m = mat as unknown as Record<string, unknown>;
      const hookNames = data.hooks.map((h) => h.name);
      if (hookNames.includes("Vertex")) ok(!!m.positionNode, `${file} Vertex → positionNode`);
      if (hookNames.includes("Diffuse")) ok(!!m.colorNode, `${file} Diffuse → colorNode`);
      if (hookNames.includes("Emissive")) ok(!!m.emissiveNode, `${file} Emissive → emissiveNode`);
      if (hookNames.includes("Normal")) ok(!!m.normalNode, `${file} Normal → normalNode`);
    }

    // 分支配方参数写入节点材质（节点材质自带经典属性）
    const physMat = backend.create("physical") as unknown as Record<string, unknown>;
    ok(
      backend.matches("physical", physMat as unknown as THREE.Material) &&
        !backend.matches("unlit", physMat as unknown as THREE.Material),
      "节点材质按分支判定（physical ≠ unlit）",
    );
    ok(
      "metalness" in physMat && "clearcoat" in physMat,
      "PBR 节点材质带经典分支配方属性（metalness/clearcoat）",
    );
    const unlitMat = backend.create("unlit") as unknown as Record<string, unknown>;
    ok("color" in unlitMat && !("clearcoat" in unlitMat), "Unlit 节点材质只带基础色/贴图属性");

    // 明确不支持项：Fragment 端口（GL 独有）与受控子集外语法必须被报告，而不是静默
    const fragErrors = backend.applyHooks(
      "physical",
      backend.create("physical"),
      dataOf('Shader "x"\n{\n    Base "PBR"\n    Hook "Fragment" { fragColor.rgb *= 0.5; }\n}\n'),
      {},
    );
    ok(
      fragErrors.some((e) => e.includes("Fragment") && e.includes("不支持")),
      `Fragment 端口在 GPU 侧显式报告不支持（${fragErrors[0] ?? "无"}）`,
    );
    // 受控子集外语法（for 循环）→ 转译失败上报，材质仍按分支渲染
    const loopErrors = backend.applyHooks(
      "physical",
      backend.create("physical"),
      dataOf(
        'Shader "x"\n{\n    Base "PBR"\n    Hook "Emissive" { for (int i = 0; i < 3; i++) { emissive += vec3(0.1); } }\n}\n',
      ),
      {},
    );
    ok(
      loopErrors.some((e) => e.includes("转译为 TSL 失败")),
      `受控子集外语法上报转译失败（${loopErrors[0] ?? "无"}）`,
    );

    // _Time 在节点路径同样被推进
    const timeMat = backend.create("physical");
    backend.applyHooks("physical", timeMat, dataOf(rim.text), { _RimPower: 2 });
    tickAllNodeHookTime(3.5);
    const nodeState = (timeMat.userData as Record<string, unknown>).__tveNodeHooks as {
      timeNode: { value: number };
      uniforms: Record<string, { value: number }>;
    };
    ok(nodeState.timeNode.value === 3.5, "tickAllNodeHookTime 推进节点侧 _Time");
    ok(
      nodeState.uniforms._RimPower.value === 2,
      "着色器属性写进节点侧 uniform（.mat 的 props 生效）",
    );
    ok(nodeHookMaterialCount() > 0, "节点 Hook 材质登记在册（_Time 推进表）");

    // 回归：装回经典后端，GL 路径不受影响
    setNodeMaterialBackend(null);
    ok(nodeHookMaterialCount() === 0, "卸载节点后端后清空在册表");
  }

  // —— 8. 回归：同一着色器多个 Hook 各自独立作用域 ——
  // 曾经的缺陷：两个片元 Hook 直接平铺注入，viewDir 前言与用户局部变量（如 n）
  // 落在同一作用域 → GLSL 'redefinition' 编译失败（program not valid）。
  console.log("[8] 多 Hook 作用域隔离（redefinition 回归）");
  {
    const dissolve = dataOf(examples.find((e) => e.file.startsWith("DissolveExt"))!.text);
    ok(dissolve.hooks.length >= 2, `溶解示例含多个 Hook（实际 ${dissolve.hooks.length}）`);
    const multiMat = new THREE.MeshPhysicalMaterial();
    applyShaderHooks(multiMat, dissolve, {});
    const multiShader = stubBuiltinShader();
    multiMat.onBeforeCompile(multiShader as never);
    const blockWrapped = (multiShader.fragmentShader.match(/\{\nvec3 viewDir/g) ?? []).length;
    ok(
      blockWrapped === dissolve.hooks.length,
      `每个片元 Hook 各在自己的块作用域（${blockWrapped}/${dissolve.hooks.length} 处带块包裹的 viewDir 前言）`,
    );
    const nDecls = (multiShader.fragmentShader.match(/float n = noise/g) ?? []).length;
    ok(nDecls === 2, `两个 Hook 各自的局部变量 n 都保留（实际 ${nDecls} 处）`);
    // 同名局部变量必须落在不同块里：第一处 Hook 体闭合后，第二处才出现
    const first = multiShader.fragmentShader.indexOf("float n = noise");
    const second = multiShader.fragmentShader.indexOf("float n = noise", first + 1);
    const between = multiShader.fragmentShader.slice(first, second);
    ok(between.includes("}"), "两个 Hook 的局部变量被块边界隔开（不再同作用域重定义）");
    // CGINCLUDE 里的工具函数仍留在全局作用域（函数不能定义在块内）
    const fnAt = multiShader.fragmentShader.indexOf("float hash(vec2 p)");
    const mainAt = multiShader.fragmentShader.indexOf("void main()");
    ok(
      fnAt >= 0 && mainAt >= 0 && fnAt < mainAt,
      "CGINCLUDE 工具函数保持在全局作用域（未被块包裹）",
    );
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
