// 组件模式冒烟测试：验证节点组件数据层与引擎同步语义（headless，无需 GPU）：
// - 新组件引用（light / audioSource）解析收敛与序列化往返；
// - 旧场景字节兼容（无 tag / executionOrder=0 不写出）；
// - SceneSynchronizer 灯光组件：挂载建灯光子对象、停用摘除、参数重建；
// - AudioSystem 音源组件绑定/解绑（无 AudioContext 环境安全空转）；
// - 节点克隆保留组件（id 重新生成）与 tag。
// 跑法同 smoke:physics：
//   npx vite build --ssr scripts/smoke-components.ts --outDir .tmp-smoke --emptyOutDir
//   node .tmp-smoke/smoke-components.js

import * as THREE from "three";
import { Node } from "../src/framework/prototype/Node";
import {
  isAudioSourceComponent,
  isLightComponent,
  parseNodeComponents,
} from "../src/framework/prototype/Node";
import {
  DEFAULT_LIGHT_COMPONENT_SETTINGS,
  parseLightComponentSettings,
} from "../src/framework/lighting/types";
import { DEFAULT_AUDIO_SETTINGS } from "../src/framework/audio/types";
import { SceneSynchronizer } from "../src/framework/engine/modules/SceneSynchronizer";
import { AudioSystem } from "../src/framework/audio/AudioSystem";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------- 1. 组件引用解析收敛 ----------
{
  const comps = parseNodeComponents([
    { id: "l1", type: "light", enabled: true, light: { kind: "spot", angle: 120, intensity: -3 } },
    { id: "a1", type: "audioSource", audio: { source: "assets/a.wav", spatial: "3d" } },
    { id: "s1", type: "script", script: "src/x.ts", executionOrder: 5, props: { n: 1 } },
    { id: "s2", script: "src/legacy.ts" }, // 旧数据无 type 字段 → 按 script 收敛
  ]);
  check("解析出 4 个组件", comps.length === 4);
  const light = comps[0];
  check(
    "灯光组件：非法 angle 收敛、强度负值归 0",
    isLightComponent(light) &&
      light.light.kind === "spot" &&
      light.light.angle === 89.9 &&
      light.light.intensity === 0,
    JSON.stringify(light),
  );
  const audio = comps[1];
  check(
    "音源组件：缺失字段回退默认",
    isAudioSourceComponent(audio) &&
      audio.audio.source === "assets/a.wav" &&
      audio.audio.spatial === "3d" &&
      audio.audio.volume === DEFAULT_AUDIO_SETTINGS.volume,
  );
  const script = comps[2];
  check(
    "脚本组件：executionOrder 解析",
    script.type === "script" && script.executionOrder === 5,
  );
  check(
    "旧数据脚本组件：executionOrder 缺省 0",
    comps[3].type === "script" && (comps[3] as { executionOrder: number }).executionOrder === 0,
  );

  // 非法灯光类型回退默认
  const bad = parseLightComponentSettings({ kind: "laser" });
  check("非法灯光类型回退 point", bad.kind === DEFAULT_LIGHT_COMPONENT_SETTINGS.kind);
}

// ---------- 2. 序列化往返 + 旧场景字节兼容 ----------
{
  const node = new Node({ name: "N" });
  node.tag = "enemy";
  node.components.push(
    {
      id: "l1",
      type: "light",
      enabled: true,
      light: parseLightComponentSettings({ kind: "directional", castShadow: true }),
    },
    { id: "s1", type: "script", script: "src/x.ts", enabled: true, executionOrder: 0, props: {} },
  );
  const json = node.toJSON() as Record<string, unknown>;
  check("tag 非空写出", json.tag === "enemy");
  const comps = json.components as Record<string, unknown>[];
  check("executionOrder=0 不写出（旧文件字节兼容）", !("executionOrder" in comps[1]));

  const back = Node.fromJSON(JSON.parse(JSON.stringify(json)) as never);
  check("往返保留 tag", back.tag === "enemy");
  check(
    "往返保留灯光组件设置",
    back.components.length === 2 &&
      isLightComponent(back.components[0]) &&
      back.components[0].light.kind === "directional" &&
      back.components[0].light.castShadow === true,
  );
  check(
    "往返脚本 executionOrder 恢复为 0",
    (back.components[1] as { executionOrder: number }).executionOrder === 0,
  );

  // 无 tag/组件的节点：不写新字段（与旧版本字节一致）
  const plain = new Node().toJSON() as Record<string, unknown>;
  check("无 tag/组件时不写 tag/components 键", !("tag" in plain) && !("components" in plain));
}

// ---------- 3. SceneSynchronizer 灯光组件同步 ----------
{
  const scene = new THREE.Scene();
  const sync = new SceneSynchronizer(scene, { paramsFor: () => ({}) as never });
  const graph = {
    all: () => [node],
    get: (id: string) => (id === node.id ? node : undefined),
  } as never;
  const node = new Node({ name: "host" });

  sync.rebuildAll(graph);
  const obj = sync.getObjectMap().get(node.id)!;
  check("无灯光组件 → 无 __compLight 子对象", !obj.children.some((c) => c.name === "__compLight"));

  node.components.push({
    id: "l1",
    type: "light",
    enabled: true,
    light: parseLightComponentSettings({ kind: "point", intensity: 3 }),
  });
  sync.onGraphChange({ kind: "properties", nodeId: node.id }, graph);
  let wrapper = obj.children.find((c) => c.name === "__compLight");
  const lightInWrapper = wrapper?.children.find((c) => (c as THREE.Light).isLight) as
    | THREE.PointLight
    | undefined;
  check(
    "挂灯光组件 → __compLight 子组 + PointLight(强度 3)",
    !!wrapper && !!lightInWrapper && lightInWrapper.intensity === 3,
  );

  // 类型切换 point → directional：重建并带目标点
  (node.components[0] as { light: { kind: string } }).light.kind = "directional";
  sync.onGraphChange({ kind: "properties", nodeId: node.id }, graph);
  wrapper = obj.children.find((c) => c.name === "__compLight");
  const dl = wrapper?.children.find((c) => (c as THREE.Light).isDirectionalLight) as
    | THREE.DirectionalLight
    | undefined;
  check(
    "切平行光 → 重建 DirectionalLight + 目标点随节点",
    !!dl && dl.target === (wrapper?.children.find((c) => c !== dl && !(c as { isSprite?: boolean }).isSprite) as THREE.Object3D),
  );

  // 停用 → 摘除
  (node.components[0] as { enabled: boolean }).enabled = false;
  sync.onGraphChange({ kind: "properties", nodeId: node.id }, graph);
  check("停用灯光组件 → 子组摘除", !obj.children.some((c) => c.name === "__compLight"));

  sync.dispose();
}

// ---------- 4. AudioSystem 音源组件绑定（以组件 id 为键） ----------
{
  const audio = new AudioSystem();
  const obj = new THREE.Object3D();
  // 无 AudioContext 环境：syncNode 安全空转（不建 emitter，不抛错）
  audio.syncNode({ id: "comp-a", audio: { ...DEFAULT_AUDIO_SETTINGS, source: "" } }, obj);
  check("音源组件绑定登记（按组件 id）", audio.isBound("comp-a"));
  audio.unbind("comp-a");
  check("按组件 id 解绑", !audio.isBound("comp-a"));
  audio.dispose();
}

// ---------- 5. 节点克隆保留组件与 tag（id 重新生成） ----------
{
  const node = new Node({ name: "src", tag: "t" });
  node.components.push({
    id: "l1",
    type: "light",
    enabled: true,
    light: parseLightComponentSettings({}),
  });
  const c = node.clone();
  check(
    "克隆保留 tag 与灯光组件，组件 id 重新生成",
    c.tag === "t" &&
      c.components.length === 1 &&
      isLightComponent(c.components[0]) &&
      c.components[0].id !== "l1",
  );
}

if (failed) {
  console.error(`\n${failed} 项断言失败`);
  process.exit(1);
} else {
  console.log("\n全部断言通过");
}
