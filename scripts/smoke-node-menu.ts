// 层级「添加节点」菜单冒烟测试（headless）：逐项核对**菜单项 → node.add 参数 → 实际节点类型**
// 三段链条是否一致。历史 bug：菜单里加了新项但类型串没进映射表，落到默认分支被静默
// 建成空组 —— 这里就是为它设的回归网。
// 跑法：npm run smoke:node-menu
//   （vite build --ssr scripts/smoke-node-menu.ts --outDir .tmp-smoke --emptyOutDir && node .tmp-smoke/smoke-node-menu.js）

import { addNodeArgs, addNodeMenuItems, collectAddMenuTypes } from "../src/app/lib/node-menu";
import { geometryRegistry } from "../src/framework/mesh";
import { createDefaultRegistry } from "../src/framework/prototype/PrototypeRegistry";
import { NodeFactory } from "../src/framework/factory/NodeFactory";
import type { LightKind } from "../src/framework/prototype/nodes/LightNode";
import type { SkyboxKind } from "../src/framework/prototype/nodes/SkyboxNode";
import type { FogKind } from "../src/framework/fog/types";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const registry = createDefaultRegistry();
const factory = new NodeFactory(registry);

// 菜单数据源：几何基元用真实注册表；脚本节点用桩（headless 无脚本 store）
const menu = addNodeMenuItems({
  geometry: geometryRegistry.list().map((g) => ({ key: g.key, label: g.label })),
  scripts: [{ rel: "src/scripts/Demo.ts", name: "Demo" }],
});
const types = collectAddMenuTypes(menu);

/** node.add 参数 → 应得的原型类型键（校验"菜单类型串 → 注册表类型"闭环） */
function expectedTypeKey(kind: string, subtype?: string): string | null {
  switch (kind) {
    case "group":
      return "node";
    case "mesh":
      return "meshNode";
    case "camera":
      return "cameraNode";
    case "skybox":
      return "skyboxNode";
    case "fog":
      return "fogNode";
    case "audio":
      return "audioNode";
    case "particle":
      return "particleSystemNode";
    case "ui": {
      const cap = (subtype ?? "canvas")[0].toUpperCase() + (subtype ?? "canvas").slice(1);
      return `ui${cap}Node`; // canvas → uiCanvasNode / text → uiTextNode / image → uiImageNode / button → uiButtonNode
    }
    case "light":
      return `${subtype}LightNode`; // point → pointLightNode / directional → directionalLightNode …
    default:
      return null; // script 之类不带原型键（以基础节点 + 脚本组件实现）
  }
}

console.log("[1] 菜单项定义");
check("菜单非空", types.length > 0, `${types.length} 项`);
check("菜单不含已移除的阴影节点入口", !types.includes("shadow"), types.join(", "));
check("含网格/灯光/天空盒/雾/相机/空组/音源/粒子入口", ["mesh:", "light:", "skybox:", "fog:", "camera", "group", "audio", "particle"].every((p) => types.some((t) => (p.endsWith(":") ? t.startsWith(p) : t === p))));
check("雾组含三类型", ["fog:linear", "fog:exp2", "fog:height"].every((t) => types.includes(t)), types.join(", "));
check("含 UI（Canvas-Widget）入口", ["ui:canvas", "ui:text", "ui:image", "ui:button", "ui:layout"].every((t) => types.includes(t)), types.join(", "));
check("脚本节点分组只在有脚本时出现", types.some((t) => t.startsWith("script:")));

console.log("[2] 每个菜单项都能映射成 node.add 参数");
for (const type of types) {
  const args = addNodeArgs(type, "parent-1");
  check(
    `${type} → 非空参数（kind=${args?.kind ?? "null"}）`,
    !!args && args.kind !== "",
    JSON.stringify(args),
  );
  if (!args) continue;
  const want = expectedTypeKey(args.kind, args.subtype);
  if (want) {
    check(`  ${type} → 注册表类型 ${want}`, registry.has(want), `注册表未登记 ${want}`);
  }
}

console.log("[3] 参数细节");
{
  check("未知类型串 shadow → null（节点已移除，不静默兜底）", addNodeArgs("shadow", "p1") === null);
  const mesh = addNodeArgs("mesh:cone", "p1");
  check("mesh:cone → kind=mesh + subtype=cone", mesh?.kind === "mesh" && mesh?.subtype === "cone");
  const light = addNodeArgs("light:spot", "p1");
  check("light:spot → kind=light + subtype=spot", light?.kind === "light" && light?.subtype === "spot");
  const sky = addNodeArgs("skybox:cube", "p1");
  check("skybox:cube → kind=skybox + subtype=cube", sky?.kind === "skybox" && sky?.subtype === "cube");
  const fog = addNodeArgs("fog:exp2", "p1");
  check("fog:exp2 → kind=fog + subtype=exp2", fog?.kind === "fog" && fog?.subtype === "exp2");
  const fogH = addNodeArgs("fog:height", "p1");
  check("fog:height → kind=fog + subtype=height", fogH?.kind === "fog" && fogH?.subtype === "height");
  const script = addNodeArgs("script:src/scripts/Demo.ts", "p1");
  check(
    "script:… → kind=script + rel 完整（含路径分隔符）",
    script?.kind === "script" && script?.subtype === "src/scripts/Demo.ts",
    script?.subtype,
  );
  check("group → kind=group", addNodeArgs("group", "p1")?.kind === "group");
  check("显式命名透传（去空白）", addNodeArgs("camera", "p1", "  主相机 ")?.name === "主相机");
  check("无名时不带 name 字段", addNodeArgs("camera", "p1")?.name === undefined);
  check(
    "未知类型串 → null（调用方提示，不静默建成空组）",
    addNodeArgs("shader", "p1") === null && addNodeArgs("", "p1") === null,
  );
}

console.log("[4] 工厂真能造出对应类型（菜单 → 命令 → 节点类型闭环）");
{
  const cases: Array<{ type: string; make: (args: ReturnType<typeof addNodeArgs>) => { typeKey: string } }> = [
    { type: "group", make: () => factory.create("node") },
    { type: "mesh:box", make: (a) => factory.createMesh(String(a?.subtype)) },
    { type: "light:point", make: (a) => factory.createLight(a?.subtype as LightKind) },
    { type: "light:directional", make: (a) => factory.createLight(a?.subtype as LightKind) },
    { type: "light:spot", make: (a) => factory.createLight(a?.subtype as LightKind) },
    { type: "light:ambient", make: (a) => factory.createLight(a?.subtype as LightKind) },
    { type: "camera", make: () => factory.createCamera() },
    { type: "skybox:procedural", make: (a) => factory.createSkybox(a?.subtype as SkyboxKind) },
    { type: "skybox:cube", make: (a) => factory.createSkybox(a?.subtype as SkyboxKind) },
    { type: "fog:linear", make: (a) => factory.createFog(a?.subtype as FogKind) },
    { type: "fog:exp2", make: (a) => factory.createFog(a?.subtype as FogKind) },
    { type: "fog:height", make: (a) => factory.createFog(a?.subtype as FogKind) },
    { type: "audio", make: () => factory.createAudio() },
    { type: "particle", make: () => factory.createParticleSystem() },
    { type: "ui:canvas", make: () => factory.createUICanvas() },
    { type: "ui:text", make: () => factory.createUIText() },
    { type: "ui:image", make: () => factory.createUIImage() },
    { type: "ui:button", make: () => factory.createUIButton() },
    { type: "ui:layout", make: () => factory.createUILayout() },
  ];
  for (const c of cases) {
    const args = addNodeArgs(c.type, "p1");
    const node = c.make(args);
    const want = expectedTypeKey(String(args?.kind), args?.subtype);
    check(
      `${c.type} → 工厂产出 ${want}`,
      node.typeKey === want,
      `实际 ${node.typeKey}`,
    );
  }
}

console.log(failed === 0 ? "\n添加节点菜单冒烟：全部通过" : `\n添加节点菜单冒烟：${failed} 项失败`);
if (failed > 0) process.exitCode = 1;
