// 雾系统冒烟测试（headless，无需 GPU）。语义参考 three.js 官网 fog 示例：
// scene.fog = new THREE.Fog(color, near, far)（线性）/ new THREE.FogExp2(color, density)（指数）。
// 覆盖五段：
// ① 数据层：默认值 / parse 收敛（缺失、非法、越界、颜色钳制）/ 深拷贝 / 签名；
// ② 节点层：注册表登记、工厂产出（linear/exp2）、序列化往返、旧场景兼容（无 fog 字段）、
//    clone 深拷贝；
// ③ 雾构建语义：按 parse 后设置构建 THREE.Fog / THREE.FogExp2（与官网示例同构）；
// ④ 菜单映射：node-menu「雾」分组（fog:linear / fog:exp2 → kind fog）→ 注册表；
// ⑤ 契约：tve.d.ts / tve.mjs / node-types.mjs（SDK FogNode）、runtime/fog.mjs /
//    nodes.mjs / player.mjs（运行时接线）、node-menu / nodeCommands（命令接线）。
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
console.log("[1] 数据层：默认值 / parse 收敛 / 深拷贝 / 签名");
{
  const d = DEFAULT_FOG_SETTINGS;
  check("默认设置齐全（4 字段）", Object.keys(d).length === 4);
  check("雾类型全集 linear/exp2", FOG_KINDS.length === 2 && FOG_KINDS.includes("linear") && FOG_KINDS.includes("exp2"));

  // 缺失字段 → 全默认
  const empty = parseFogSettings(undefined);
  check("parse(undefined) 回退默认", JSON.stringify(empty) === JSON.stringify(d));
  // 非法类型 → 默认
  const junk = parseFogSettings({ color: "x", near: null, density: NaN });
  check("非法类型回退默认", junk.color === d.color && junk.near === d.near && junk.density === d.density);
  // 越界 → 钳制
  const clamped = parseFogSettings({ near: -5, far: 999999, density: 42 });
  check("越界钳制",
    clamped.near === FOG_LIMITS.near.min &&
    clamped.far === FOG_LIMITS.far.max &&
    clamped.density === FOG_LIMITS.density.max);
  // 颜色钳制
  const color = parseFogSettings({ color: 0x12345678 });
  check("颜色收敛到 0..0xffffff", color.color === 0xffffff);
  const negColor = parseFogSettings({ color: -3 });
  check("负色收敛到 0", negColor.color === 0);

  // 深拷贝：改副本不影响源
  const src = parseFogSettings({ near: 10, far: 200 });
  const copy = cloneFogSettings(src);
  copy.near = 3;
  check("clone 深拷贝", src.near === 10 && copy.near === 3);

  // 签名：任何字段变化都改变签名
  const base = parseFogSettings({});
  const sigs = new Set<string>([fogSettingsSig(base)]);
  const variants = [
    { ...base, color: 0x112233 },
    { ...base, near: base.near + 1 },
    { ...base, far: base.far + 1 },
    { ...base, density: base.density + 0.01 },
  ];
  let allDiffer = true;
  for (const v of variants) {
    const s = fogSettingsSig(v);
    if (sigs.has(s)) allDiffer = false;
    sigs.add(s);
  }
  check("签名随字段变化", allDiffer);

  check("类型显示名", fogKindLabel("linear") === "Linear Fog" && fogKindLabel("exp2") === "Exponential Fog");
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

  // 序列化往返
  linear.fog = parseFogSettings({ color: 0x223344, near: 5, far: 60, density: 0.5 });
  const json = linear.toJSON() as Record<string, unknown>;
  check("序列化含 fogKind/fog", json.fogKind === "linear" && typeof json.fog === "object");
  const restored = registry.createFromJSON(JSON.parse(JSON.stringify(json)) as Record<string, unknown>) as FogNode;
  check("createFromJSON 产出 FogNode", restored instanceof FogNode);
  check("雾设置往返一致", JSON.stringify(restored.fog) === JSON.stringify(linear.fog));
  check("fogKind 往返一致", restored.fogKind === "linear");

  // 旧场景兼容：无 fogKind/fog 字段
  const legacy = registry.createFromJSON({ type: "fogNode", id: "fogNode_legacy", name: "Old" });
  check("旧场景无 fog 字段回默认", legacy instanceof FogNode &&
    JSON.stringify(legacy.fog) === JSON.stringify(DEFAULT_FOG_SETTINGS));
  check("旧场景无 fogKind 回 linear", legacy.fogKind === "linear");

  // clone
  const cloned = linear.clone();
  check("clone 类型与设置", cloned instanceof FogNode && cloned.fogKind === "linear" && cloned.fog.color === 0x223344);
  cloned.fog.near = 99;
  check("clone 设置深拷贝", linear.fog.near === 5);
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
console.log("[4] 菜单映射：「雾」分组（fog:linear / fog:exp2）");
{
  const items = addNodeMenuItems({ geometry: [], scripts: [] });
  const args = addNodeArgs("fog:linear", "root");
  check("node-menu fog:linear → kind fog + subtype linear", args !== null && args.kind === "fog" && args.subtype === "linear");
  const args2 = addNodeArgs("fog:exp2", "root");
  check("node-menu fog:exp2 → kind fog + subtype exp2", args2 !== null && args2.kind === "fog" && args2.subtype === "exp2");
  check("菜单类型串全部可映射", collectAddMenuTypes(items).every((t) => addNodeArgs(t, "root") !== null));
}

// ===========================================================================
console.log("[5] 契约：SDK / 运行时接线 / 菜单与命令");
{
  const dts = readFileSync(resolve(process.cwd(), "src/framework/scripting/tve.d.ts"), "utf8");
  const tveMjs = readFileSync(resolve(process.cwd(), "public/engine/core/tve.mjs"), "utf8");
  const nodeTypes = readFileSync(resolve(process.cwd(), "public/engine/core/tve/node-types.mjs"), "utf8");
  const runtimeFog = readFileSync(resolve(process.cwd(), "public/engine/runtime/fog.mjs"), "utf8");
  const nodesSrc = readFileSync(resolve(process.cwd(), "public/engine/runtime/nodes.mjs"), "utf8");
  const player = readFileSync(resolve(process.cwd(), "public/web-preview/player.mjs"), "utf8");
  const nodeMenu = readFileSync(resolve(process.cwd(), "src/app/lib/node-menu.ts"), "utf8");
  const nodeCommands = readFileSync(resolve(process.cwd(), "src/app/commands/nodeCommands.ts"), "utf8");
  const engineSrc = readFileSync(resolve(process.cwd(), "src/framework/engine/EditorEngine.ts"), "utf8");

  check("tve.d.ts 声明 FogNode 类", /export\s+class\s+FogNode\s+extends\s+Entity/.test(dts));
  check("tve.d.ts EntityKind 含 fogNode", /"fogNode"/.test(dts));
  check("tve.mjs 再导出 FogNode/fogNode", /FogNode/.test(tveMjs) && /FogNode\s+as\s+fogNode/.test(tveMjs));
  check("node-types.mjs KIND_CLASSES 映射 fogNode", /fogNode:\s*FogNode/.test(nodeTypes));

  check("runtime/fog.mjs 提供 findFogNode/applyFogFromNode", /export\s+function\s+findFogNode/.test(runtimeFog) && /export\s+function\s+applyFogFromNode/.test(runtimeFog));
  check("runtime/fog.mjs 构建 Fog/FogExp2", /new\s+THREE\.Fog\(/.test(runtimeFog) && /new\s+THREE\.FogExp2\(/.test(runtimeFog));
  check("player.mjs 接入 findFogNode/applyFogFromNode", /findFogNode/.test(player) && /applyFogFromNode\(scene,\s*fog\)/.test(player));
  check("nodes.mjs 注明 fogNode 语义", /fogNode/.test(nodesSrc));
  check("EditorEngine 有 applyFogFromGraph 与 FogExp2", /applyFogFromGraph/.test(engineSrc) && /new\s+THREE\.FogExp2\(/.test(engineSrc));

  check("node-menu 含「雾」分组与 fog: 前缀映射", nodeMenu.includes("label: \"雾\"") && /startsWith\("fog:"\)/.test(nodeMenu));
  check("node.add 命令含 fog 分支", /case\s+"fog":/.test(nodeCommands) && /addFog\(/.test(nodeCommands));
}

// ===========================================================================
process.exitCode = failed > 0 ? 1 : 0;
if (failed > 0) console.error(`\n${failed} 项失败`);
else console.log("\n全部通过");
