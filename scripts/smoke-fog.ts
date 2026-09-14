// 雾系统冒烟测试（headless，无需 GPU）。语义参考 three.js 官网 fog 示例：
// scene.fog = new THREE.Fog(color, near, far)（线性）/ new THREE.FogExp2(color, density)（指数）；
// 高度雾 = exp2 距离衰减 + 海拔衰减（three 无内置类，framework/fog/heightFog.ts 注入）。
// 覆盖五段：
// ① 数据层：默认值 / parse 收敛（缺失、非法、越界、颜色钳制）/ 深拷贝 / 签名 / 三种类型；
// ② 节点层：注册表登记、工厂产出（linear/exp2/height）、序列化往返、旧场景兼容、clone 深拷贝；
// ③ 雾构建语义：THREE.Fog / THREE.FogExp2 构建 + scene.fog 热替换；
// ④ 高度雾注入：chunk patch 幂等、原公式保留、ShaderLib 全模板共享同一 uniform 对象
//    （cloneUniforms 按引用复制普通对象——"写一次全材质生效"机制的直接验证）；
// ⑤ 菜单与契约：「雾」分组三类型映射、播放器/运行时接线。
// 跑法：npm run smoke:fog
//   （vite build --ssr scripts/smoke-fog.ts --outDir .tmp-smoke --emptyOutDir && node .tmp-smoke/smoke-fog.js）

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FogNode } from "../src/framework/prototype/nodes/FogNode";
import { createDefaultRegistry } from "../src/framework/prototype/PrototypeRegistry";
import { createNodeFactory } from "../src/framework/factory/NodeFactory";
import { addNodeArgs, addNodeMenuItems, collectAddMenuTypes } from "../src/app/lib/node-menu";
import {
  DEFAULT_FOG_SETTINGS,
  FOG_KINDS,
  FOG_LIMITS,
  cloneFogSettings,
  fogKindLabel,
  fogSettingsSig,
  parseFogSettings,
} from "../src/framework/fog/types";
import {
  ensureHeightFogChunk,
  setHeightFogParams,
  setHeightFogStrength,
} from "../src/framework/fog/heightFog";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ===========================================================================
console.log("[1] 数据层：默认值 / parse 收敛 / 深拷贝 / 签名 / 三种类型");
{
  const d = DEFAULT_FOG_SETTINGS;
  check("默认设置齐全（6 字段）", Object.keys(d).length === 6);
  check("雾类型全集 linear/exp2/height", FOG_KINDS.length === 3 && FOG_KINDS.includes("height"));

  // 缺失字段 → 全默认
  const empty = parseFogSettings(undefined);
  check("parse(undefined) 回退默认", JSON.stringify(empty) === JSON.stringify(d));
  // 非法类型 → 默认
  const junk = parseFogSettings({ color: "x", near: null, density: NaN, heightY: "y" });
  check("非法类型回退默认",
    junk.color === d.color && junk.near === d.near && junk.density === d.density && junk.heightY === d.heightY);
  // 越界 → 钳制
  const clamped = parseFogSettings({ near: -5, far: 999999, density: 42, heightY: -99999, heightFalloff: 0 });
  check("越界钳制",
    clamped.near === FOG_LIMITS.near.min &&
    clamped.far === FOG_LIMITS.far.max &&
    clamped.density === FOG_LIMITS.density.max &&
    clamped.heightY === FOG_LIMITS.heightY.min &&
    clamped.heightFalloff === FOG_LIMITS.heightFalloff.min);
  // 颜色钳制
  const color = parseFogSettings({ color: 0x12345678 });
  const negColor = parseFogSettings({ color: -3 });
  check("颜色收敛到 0..0xffffff", color.color === 0xffffff && negColor.color === 0);

  // 深拷贝：改副本不影响源
  const src = parseFogSettings({ near: 10, far: 200, heightY: 5 });
  const copy = cloneFogSettings(src);
  copy.near = 3;
  copy.heightY = 9;
  check("clone 深拷贝", src.near === 10 && copy.near === 3 && src.heightY === 5 && copy.heightY === 9);

  // 签名：任何字段变化都改变签名
  const base = parseFogSettings({});
  const sigs = new Set<string>([fogSettingsSig(base)]);
  const variants = [
    { ...base, color: 0x112233 },
    { ...base, near: base.near + 1 },
    { ...base, far: base.far + 1 },
    { ...base, density: base.density + 0.01 },
    { ...base, heightY: base.heightY + 1 },
    { ...base, heightFalloff: base.heightFalloff + 1 },
  ];
  let allDiffer = true;
  for (const v of variants) {
    const s = fogSettingsSig(v);
    if (sigs.has(s)) allDiffer = false;
    sigs.add(s);
  }
  check("签名随字段变化（含高度字段）", allDiffer);

  check("类型显示名", fogKindLabel("linear") === "Linear Fog" &&
    fogKindLabel("exp2") === "Exponential Fog" && fogKindLabel("height") === "Height Fog");
}

// ===========================================================================
console.log("[2] 节点层：注册 / 工厂 / 序列化往返 / 旧场景兼容 / clone");
{
  const registry = createDefaultRegistry();
  check("注册表登记 fogNode", registry.has("fogNode"));
  const factory = createNodeFactory(registry);

  const linear = factory.createFog("linear");
  check("工厂产出 FogNode（linear）", linear instanceof FogNode && linear.typeKey === "fogNode");
  check("线性雾默认名", linear.name === "Linear Fog" && linear.fogKind === "linear");
  const exp2 = factory.createFog("exp2");
  check("指数雾默认名", exp2.name === "Exponential Fog" && exp2.fogKind === "exp2");
  const height = factory.createFog("height");
  check("高度雾默认名", height.name === "Height Fog" && height.fogKind === "height");

  // 序列化往返（高度雾全字段）
  height.fog = parseFogSettings({ color: 0x223344, density: 0.05, heightY: -10, heightFalloff: 35 });
  const json = height.toJSON() as Record<string, unknown>;
  check("序列化含 fogKind/fog", json.fogKind === "height" && typeof json.fog === "object");
  const restored = registry.createFromJSON(JSON.parse(JSON.stringify(json)) as Record<string, unknown>) as FogNode;
  check("createFromJSON 产出 FogNode", restored instanceof FogNode);
  check("高度雾设置往返一致", JSON.stringify(restored.fog) === JSON.stringify(height.fog));
  check("fogKind 往返一致", restored.fogKind === "height");

  // 旧场景兼容：无 fogKind/fog 字段
  const legacy = registry.createFromJSON({ type: "fogNode", id: "fogNode_legacy", name: "Old" });
  check("旧场景无 fog 字段回默认", legacy instanceof FogNode &&
    JSON.stringify(legacy.fog) === JSON.stringify(DEFAULT_FOG_SETTINGS));
  check("旧场景无 fogKind 回 linear", legacy.fogKind === "linear");
  // 非法 fogKind 回退 linear
  const junkKind = registry.createFromJSON({ type: "fogNode", id: "fogNode_junk", fogKind: "bogus" });
  check("非法 fogKind 回退 linear", junkKind instanceof FogNode && junkKind.fogKind === "linear");

  // clone
  const cloned = height.clone();
  check("clone 类型与设置", cloned instanceof FogNode && cloned.fogKind === "height" && cloned.fog.heightY === -10);
  cloned.fog.heightY = 99;
  check("clone 设置深拷贝", height.fog.heightY === -10);
}

// ===========================================================================
console.log("[3] 雾构建语义：THREE.Fog / THREE.FogExp2（与官网 fog 示例同构）");
{
  // 线性雾：scene.fog = new THREE.Fog(color, near, far)
  const linear = parseFogSettings({ color: 0xcccccc, near: 10, far: 100 });
  const fog = new THREE.Fog(linear.color, linear.near, linear.far);
  check("THREE.Fog 类型", fog.isFog === true);
  check("线性雾参数一致", fog.color.getHex() === 0xcccccc && fog.near === 10 && fog.far === 100);

  // 指数雾：scene.fog = new THREE.FogExp2(color, density)
  const exp2 = parseFogSettings({ color: 0xefd1b5, density: 0.0025 });
  const fogExp = new THREE.FogExp2(exp2.color, exp2.density);
  check("THREE.FogExp2 类型", fogExp.isFogExp2 === true);
  check("指数雾参数一致", fogExp.color.getHex() === 0xefd1b5 && fogExp.density === 0.0025);

  // 清雾：scene.fog = null
  const scene = new THREE.Scene();
  scene.fog = fog;
  scene.fog = null;
  check("scene.fog 可置空（无雾节点时清雾）", scene.fog === null);
}

// ===========================================================================
console.log("[4] 高度雾注入：chunk patch / ShaderLib 共享 uniform（headless 真 three）");
{
  ensureHeightFogChunk();
  ensureHeightFogChunk(); // 幂等：重复调用无副作用

  check("fog_fragment 已含高度衰减", /uFogHeight/.test(THREE.ShaderChunk.fog_fragment) &&
    /fogHeightAtten/.test(THREE.ShaderChunk.fog_fragment));
  check("内置线性/指数公式原样保留", THREE.ShaderChunk.fog_fragment.includes(
    "float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );") &&
    THREE.ShaderChunk.fog_fragment.includes("float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );"));
  check("fog_vertex 补世界 Y varying", /vFogWorldY = \( modelMatrix \* vec4\( position, 1\.0 \) \)\.y;/.test(THREE.ShaderChunk.fog_vertex));
  check("fog_pars_fragment 声明 uFogHeight", /uniform vec3 uFogHeight;/.test(THREE.ShaderChunk.fog_pars_fragment));

  // 共享 uniform：全部含雾模板引用同一对象，clone 后仍按引用穿透（核心机制）
  const names = ["basic", "lambert", "phong", "standard", "physical", "toon", "matcap", "points", "dashed", "sprite"];
  let allInjected = true;
  for (const n of names) {
    const lib = (THREE.ShaderLib as unknown as Record<string, { uniforms: Record<string, unknown> }>)[n];
    if (!lib?.uniforms?.["uFogHeight"]) allInjected = false;
  }
  check("ShaderLib 全部含雾模板已注入 uFogHeight", allInjected, names.join(","));

  const cloneA = THREE.UniformsUtils.clone(
    (THREE.ShaderLib as unknown as Record<string, { uniforms: Record<string, unknown> }>).basic.uniforms,
  );
  const cloneB = THREE.UniformsUtils.clone(
    (THREE.ShaderLib as unknown as Record<string, { uniforms: Record<string, unknown> }>).physical.uniforms,
  );
  check("模板克隆后共享同一参数对象（引用相等）",
    (cloneA.uFogHeight as { value: object }).value === (cloneB.uFogHeight as { value: object }).value);

  // 写一次 → 全部生效
  setHeightFogParams(12, 45, 1);
  const a = (cloneA.uFogHeight as { value: { x: number; y: number; z: number } }).value;
  check("setHeightFogParams 写一次全材质可见", a.x === 12 && a.y === 45 && a.z === 1);
  setHeightFogStrength(0);
  check("setHeightFogStrength 归零", a.z === 0);
}

// ===========================================================================
console.log("[5] 菜单映射与契约：「雾」分组三类型 / 播放器接线");
{
  const items = addNodeMenuItems({ geometry: [], scripts: [] });
  check("node-menu fog:linear → kind fog", (() => {
    const a = addNodeArgs("fog:linear", "root");
    return !!a && a.kind === "fog" && a.subtype === "linear";
  })());
  check("node-menu fog:exp2 → kind fog", (() => {
    const a = addNodeArgs("fog:exp2", "root");
    return !!a && a.kind === "fog" && a.subtype === "exp2";
  })());
  check("node-menu fog:height → kind fog", (() => {
    const a = addNodeArgs("fog:height", "root");
    return !!a && a.kind === "fog" && a.subtype === "height";
  })());
  check("菜单类型串全部可映射", collectAddMenuTypes(items).every((t) => addNodeArgs(t, "root") !== null));

  const runtimeFog = readFileSync(resolve(process.cwd(), "public/engine/runtime/fog.mjs"), "utf8");
  const runtimeHeight = readFileSync(resolve(process.cwd(), "public/engine/runtime/heightFog.mjs"), "utf8");
  const player = readFileSync(resolve(process.cwd(), "public/web-preview/player.mjs"), "utf8");
  const nodeCommands = readFileSync(resolve(process.cwd(), "src/app/commands/nodeCommands.ts"), "utf8");
  const engineSrc = readFileSync(resolve(process.cwd(), "src/framework/engine/EditorEngine.ts"), "utf8");

  check("runtime/fog.mjs 收敛 heightY/heightFalloff", /heightY/.test(runtimeFog) && /heightFalloff/.test(runtimeFog));
  check("runtime/heightFog.mjs 提供 chunk patch 与 WebGPU 节点", /ensureHeightFogChunk/.test(runtimeHeight) &&
    /applyHeightFogNodeWebGPU/.test(runtimeHeight) && /scene\.fogNode/.test(runtimeHeight));
  check("player.mjs 先于 buildSceneTree 安装 chunk patch",
    player.indexOf("ensureHeightFogChunk()") >= 0 &&
    player.indexOf("ensureHeightFogChunk()") < player.indexOf("buildSceneTree(rootJson"));
  check("player.mjs WebGPU 下传入 TSL 命名空间", /webgpuTsl/.test(player) && /three\.webgpu\.min\.js/.test(player));
  check("node.add 命令 fog 分支仍接线", /case\s+"fog":/.test(nodeCommands) && /addFog\(/.test(nodeCommands));
  // 历史坑：命令层曾自持 FOG_KINDS 本地副本，新增 height 后未同步 → 新建高度雾
  // 被 asSubtype 静默回退成线性雾。这里锁死「命令层必须引单一事实源」。
  check("nodeCommands 的 FOG_KINDS 引自 fog/types（无本地副本）",
    /FOG_KINDS[^;\n]*from\s+"[^"]*\/fog\/types"/.test(nodeCommands) && !/const FOG_KINDS/.test(nodeCommands));
  check("EditorEngine 高度雾分支与 patch 安装",
    /fogKind === "height"/.test(engineSrc) && /ensureHeightFogChunk\(\)/.test(engineSrc) &&
    /applyHeightFogWebGPU/.test(engineSrc));
}

// ===========================================================================
process.exitCode = failed > 0 ? 1 : 0;
if (failed > 0) console.error(`\n${failed} 项失败`);
else console.log("\n全部通过");
