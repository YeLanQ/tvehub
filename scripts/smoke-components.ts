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
  isScriptComponent,
  parseAnimClipBinding,
  parseNodeComponents,
} from "../src/framework/prototype/Node";
import { serializePrefabTree, instantiatePrefabTree } from "../src/framework/prototype/prefab";
import { createDefaultRegistry } from "../src/framework/prototype/PrototypeRegistry";
import { MeshNode } from "../src/framework/prototype/nodes/MeshNode";
import {
  DEFAULT_LIGHT_COMPONENT_SETTINGS,
  parseLightComponentSettings,
} from "../src/framework/lighting/types";
import {
  DEFAULT_TANGENT_WEIGHT,
  TANGENT_WEIGHT_MIN,
  clearTangents,
  ensureManualTangents,
  evaluateClip,
  evaluateCurve,
  isAutoTangent,
  keySlope,
  keyWeight,
  parseAnimationClip,
  removeKeyAt,
  sampleSmoothSegment,
  tangentWeightBase,
  upsertKey,
} from "../src/framework/animation/clip";
// @ts-ignore 播放器镜像（mjs 无类型声明）：校验与 framework clip.ts 同语义
import { __test } from "../public/engine/runtime/animclip.mjs";
import { DEFAULT_AUDIO_SETTINGS, parseAudioSettings } from "../src/framework/audio/types";
import { parseColliderSettings, parseRigidBodySettings } from "../src/framework/physics/types";
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

// ---------- 6. Prefab 序列化/实例化（嵌套子树 + id 重映射） ----------
{
  const registry = createDefaultRegistry();
  const root = new Node({ name: "root", tag: "spawner" });
  const box = new MeshNode({ name: "box" });
  box.source = "primitive";
  box.geometry = "box";
  box.components.push(
    {
      id: "pl1",
      type: "light",
      enabled: true,
      light: parseLightComponentSettings({ kind: "point", intensity: 4 }),
    },
    { id: "ps1", type: "script", script: "src/x.ts", enabled: true, executionOrder: 3, props: {} },
  );
  const leaf = new Node({ name: "leaf" });
  root.childIds.push(box.id, leaf.id);
  box.parentId = root.id;
  leaf.parentId = root.id;
  const childrenOf = (id: string): Node[] =>
    [box, leaf].filter((n) => n.parentId === id);

  const doc = serializePrefabTree(root, childrenOf) as Record<string, unknown>;
  const comps = ((doc.children as Record<string, unknown>[])[0].components ??
    []) as Record<string, unknown>[];
  check(
    "序列化：嵌套 children + 剥掉组件 id 与 prefab 引用",
    Array.isArray(doc.children) &&
      (doc.children as unknown[]).length === 2 &&
      !("id" in comps[0]) &&
      !("prefab" in doc),
  );

  const { root: instRoot, nodes: instNodes } = instantiatePrefabTree(doc, {
    fromJSON: (json) => registry.createFromJSON(json),
  });
  check(
    "实例化：全部节点 id 重生成（含根）",
    instNodes.length === 3 &&
      instRoot.id !== root.id &&
      instNodes.every((n) => n.id !== root.id && n.id !== box.id && n.id !== leaf.id),
  );
  const instBox = instRoot.childIds
    .map((id) => instNodes.find((n) => n.id === id))
    .find((n) => n instanceof MeshNode);
  check(
    "实例化：层级/类型重建，组件 id 重生成且字段保真",
    !!instBox &&
      instBox.parentId === instRoot.id &&
      instBox.components.length === 2 &&
      isLightComponent(instBox.components[0]) &&
      instBox.components[0].id !== "pl1" &&
      instBox.components[0].light.intensity === 4 &&
      isScriptComponent(instBox.components[1]) &&
      (instBox.components[1] as { executionOrder: number }).executionOrder === 3,
  );

  // 序列化 → 实例化 → 再序列化：形状稳定（id 除外）
  const doc2 = serializePrefabTree(instRoot, (id) =>
    instNodes.filter((n) => n.parentId === id),
  );
  const strip = (d: Record<string, unknown>): unknown => ({
    type: d.type,
    name: d.name,
    tag: d.tag ?? "",
    children: Array.isArray(d.children) ? (d.children as Record<string, unknown>[]).map(strip) : [],
  });
  check(
    "再序列化结构一致（忽略 id）",
    JSON.stringify(strip(doc)) === JSON.stringify(strip(doc2 as Record<string, unknown>)),
  );

  // 提交实例文档（forAsset:false）：保留 prefab 来源引用与组件 id（回灌不清空）
  const srcNode = new Node({ name: "r2" });
  srcNode.prefab = "assets/prefabs/Self.prefab";
  srcNode.components.push({
    id: "s9",
    type: "script",
    script: "src/y.ts",
    enabled: true,
    executionOrder: 0,
    props: {},
  });
  const docInst = serializePrefabTree(srcNode, () => [], { forAsset: false }) as Record<
    string,
    unknown
  >;
  const instComps = docInst.components as Record<string, unknown>[];
  check(
    "提交文档（forAsset:false）保留 prefab 引用与组件 id",
    docInst.prefab === "assets/prefabs/Self.prefab" && instComps[0].id === "s9",
  );
}

// ---------- 7. 关键帧动画剪辑求值（插值 / 回绕 / 关键帧操作） ----------
{
  const clip = parseAnimationClip({
    name: "Spin",
    duration: 2,
    loops: true,
    curves: [
      {
        prop: "rotation.y",
        keys: [
          { t: 0, v: 0, i: "linear" },
          { t: 1, v: 90, i: "linear" },
          { t: 2, v: 0, i: "linear" },
        ],
      },
      {
        prop: "position.y",
        keys: [
          { t: 0, v: 1, i: "smooth" },
          { t: 1, v: 3, i: "smooth" },
        ],
      },
      { prop: "visible.x", keys: [{ t: 0, v: 0 }] }, // 非法通道剔除
    ],
  });
  // 通道已泛化：prop 为任意非空字符串（不再白名单限制），未知键同样保留
  check(
    "解析：通道保留（含未知键，向前兼容）",
    clip.curves.length === 3 && clip.duration === 2 && clip.loops === true,
  );
  const rot = clip.curves.find((c) => c.prop === "rotation.y");
  check(
    "线性插值：区间内取中点、区间外钳端点",
    evaluateCurve(rot as never, 0.5) === 45 &&
      evaluateCurve(rot as never, -1) === 0 &&
      evaluateCurve(rot as never, 9) === 0,
  );
  const pos = clip.curves.find((c) => c.prop === "position.y");
  const mid = evaluateCurve(pos as never, 0.5) as number;
  check(
    "平滑插值：中点过两值中点、单调段内不出界",
    Math.abs(mid - 2) < 1e-6 && (evaluateCurve(pos as never, 0.25) as number) > 1,
  );

  // 回绕：loop 取模 / once 钳制
  const once = parseAnimationClip({
    duration: 2,
    loops: false,
    curves: [{ prop: "scale.x", keys: [{ t: 0, v: 1, i: "linear" }, { t: 2, v: 5, i: "linear" }] }],
  });
  const vLooped = evaluateClip(clip, 2.5).get("rotation.y");
  const vOnce = evaluateClip(once, 9).get("scale.x");
  check(
    "回绕：循环取模、单次钳末值",
    vOnce === 5 && vLooped === evaluateClip(clip, 0.5).get("rotation.y"),
  );

  // 关键帧操作：upsert 同帧覆盖、删除
  const curve = clip.curves[0];
  upsertKey(curve, 0.5, 33);
  check("upsert 新帧插入", curve.keys.some((k) => Math.abs(k.t - 0.5) <= 1e-4 && k.v === 33));
  upsertKey(curve, 0.5, 44);
  check("upsert 同帧覆盖不重复", curve.keys.filter((k) => Math.abs(k.t - 0.5) <= 1e-4).length === 1 && curve.keys.find((k) => Math.abs(k.t - 0.5) <= 1e-4)?.v === 44);
  check("removeKeyAt 删除", removeKeyAt(curve, 0.5) && !curve.keys.some((k) => Math.abs(k.t - 0.5) <= 1e-4));

  // —— 贝塞尔切线：解析收敛 / 手动态求值 / 自动态回归 / 固化 / 对称 ——
  const bz = parseAnimationClip({
    duration: 1,
    loops: false,
    curves: [
      {
        prop: "position.x",
        keys: [
          { t: 0, v: 0, i: "smooth", to: 2, ti: "bad" },
          { t: 1, v: 1, i: "smooth", ti: -2, to: 5000000, tm: true },
          { t: 1.5, v: 1, i: "smooth", tm: "yes" },
        ],
      },
    ],
  }).curves[0];
  check(
    "切线解析：合法保留、非法剔除、斜率钳制、tm 仅认 true",
    bz.keys[0].to === 2 && bz.keys[0].ti === undefined && bz.keys[1].ti === -2 &&
      bz.keys[1].to === 1000000 && bz.keys[1].tm === true && bz.keys[2].tm === undefined,
  );
  // 0.5 ∈ [0,1]（span=1）：h10=0.125、h11=-0.125 → 0.125×to(2) + 0.5×1 + (−0.125)×ti(−2) = 1
  check(
    "手动切线求值与手算 Hermite 一致",
    Math.abs((evaluateCurve(bz, 0.5) as number) - 1) < 1e-9,
  );
  // 自动态与旧 Catmull-Rom 行为回归一致（两帧对称段中点 = 值中点）
  const bz2 = {
    prop: "position.x",
    keys: [
      { t: 0, v: 0, i: "smooth" as const },
      { t: 1, v: 1, i: "smooth" as const },
    ],
  };
  check(
    "自动态求值回归：与纯 Catmull-Rom 相同（中点=值中点）",
    Math.abs((evaluateCurve(bz2 as never, 0.5) as number) - 0.5) < 1e-9 &&
      isAutoTangent(bz2.keys[0]) &&
      keySlope(bz2.keys, 0, "to") === 1 &&
      keySlope(bz2.keys, 0, "ti") === 1,
  );
  ensureManualTangents(bz2.keys, 0);
  check(
    "固化自动切线：求值不变 + 两侧相等 + tm 联动",
    !isAutoTangent(bz2.keys[0]) && bz2.keys[0].ti === 1 && bz2.keys[0].to === 1 && bz2.keys[0].tm === true &&
      Math.abs((evaluateCurve(bz2 as never, 0.5) as number) - 0.5) < 1e-9,
  );
  clearTangents(bz2.keys[0]);
  check("clearTangents 恢复自动", isAutoTangent(bz2.keys[0]) && bz2.keys[0].tm === undefined);

  // —— 切线手柄权重（wi/wo）：解析钳制 / 生效值 / 基准段 + 参数化 Bézier 形变 ——
  const wtc = parseAnimationClip({
    duration: 2,
    loops: false,
    curves: [
      {
        prop: "position.x",
        keys: [
          { t: 0, v: 0, i: "smooth", to: 1, wo: 0.4 },
          { t: 1, v: 1, i: "smooth", ti: 2, wi: 9, wo: -1 },
          { t: 1.5, v: 1, i: "smooth", wi: "x" },
        ],
      },
    ],
  }).curves[0];
  check(
    "权重解析：合法钳制保留、非法剔除（旧文件缺省 undefined 零改动兼容）",
    wtc.keys[0].wo === 0.4 && wtc.keys[0].wi === undefined &&
      wtc.keys[1].wi === 1.5 && wtc.keys[1].wo === 0.01 && wtc.keys[2].wi === undefined,
  );
  check(
    "keyWeight 缺省 1/3 与钳制生效",
    keyWeight(wtc.keys, 0, "ti") === DEFAULT_TANGENT_WEIGHT && keyWeight(wtc.keys, 0, "to") === 0.4 &&
      keyWeight(wtc.keys, 1, "ti") === 1.5 && keyWeight(wtc.keys, 1, "to") === TANGENT_WEIGHT_MIN,
    `ti0=${keyWeight(wtc.keys, 0, "ti")} to0=${keyWeight(wtc.keys, 0, "to")} ti1=${keyWeight(wtc.keys, 1, "ti")} to1=${keyWeight(wtc.keys, 1, "to")}`,
  );
  check(
    "tangentWeightBase：own 段跨 / 缺侧借邻段 / 单帧回退",
    tangentWeightBase(wtc.keys, 0, "to", 1) === 1 && tangentWeightBase(wtc.keys, 2, "to", 1) === 0.5 &&
      tangentWeightBase([{ t: 0, v: 0, i: "smooth" }], 0, "ti", 0.75) === 0.75,
  );
  // 权重恒等于缺省（±ε 绕过快路径）时参数化 Bézier 与 Hermite 同曲线（形状回归）
  const idn = {
    prop: "p",
    keys: [
      { t: 0, v: 0, i: "smooth" as const, to: 3 },
      { t: 1, v: 2, i: "smooth" as const, ti: -1 },
    ],
  };
  let idMax = 0;
  for (let s = 1; s < 20; s++) {
    const t = s / 20;
    idMax = Math.max(
      idMax,
      Math.abs(
        sampleSmoothSegment(idn.keys, 0, t) -
          sampleSmoothSegment(
            [
              { ...idn.keys[0], wo: DEFAULT_TANGENT_WEIGHT + 1e-9 },
              { ...idn.keys[1], wi: DEFAULT_TANGENT_WEIGHT + 1e-9 },
            ],
            0,
            t,
          ),
      ),
    );
  }
  check("权重≈1/3 时参数化 Bézier 与 Hermite 同曲线", idMax < 1e-6, `maxΔ=${idMax}`);
  // 手算：段 [0,1] 0→1、两端斜率 0、w1=w2=0.5 → X(u)=u³-1.5u²+1.5u（u=τ）
  // → t=0.5 处 u=0.5 → Y(u)=3u²-2u³=0.5；拉偏 w1=0.9 → X=2.2u³-3.9u²+2.7u
  // → X(u)=0.5 解 u≈0.282 → Y(u)=3u²-2u³ ≈ 0.193（形状随权重真实改变）
  const shp = {
    prop: "p",
    keys: [
      { t: 0, v: 0, i: "smooth" as const, to: 0, wo: 0.5 },
      { t: 1, v: 1, i: "smooth" as const, ti: 0, wi: 0.5 },
    ],
  };
  const vSym = evaluateCurve(shp, 0.5);
  shp.keys[0].wo = 0.9;
  const vBias = evaluateCurve(shp, 0.5);
  check(
    "权重真实形变 smooth 段（手算对照）",
    Math.abs((vSym as number) - 0.5) < 1e-6 && Math.abs((vBias as number) - 0.193) < 0.01,
    `vSym=${vSym} vBias=${vBias}`,
  );
  // 两侧权重都 >2/3 → 时间坐标非单调（S 形回勾）：求值不抛错、端点仍精确
  const loop = {
    prop: "p",
    keys: [
      { t: 0, v: 0, i: "smooth" as const, to: 1, wo: 1.5 },
      { t: 1, v: 1, i: "smooth" as const, ti: 1, wi: 1.5 },
    ],
  };
  let loopMax = 0;
  for (let s = 1; s < 20; s++) {
    const v = sampleSmoothSegment(loop.keys, 0, s / 20);
    if (Number.isFinite(v)) loopMax = Math.max(loopMax, Math.min(v, 1 - v));
  }
  check(
    "非单调回勾段：求值有限且端点精确",
    loopMax > 0 && sampleSmoothSegment(loop.keys, 0, 0) === 0 &&
      Math.abs(sampleSmoothSegment(loop.keys, 0, 1) - 1) < 1e-9,
    `loopMax=${loopMax} e0=${sampleSmoothSegment(loop.keys, 0, 0)} e1=${sampleSmoothSegment(loop.keys, 0, 1)}`,
  );
  // 播放器镜像同语义：parseClip/sampleClip 黑盒对照（含权重与钳制值）
  {
    const mirrorDoc = JSON.parse(JSON.stringify(wtc));
    const mc = __test.parseClip(mirrorDoc);
    const out = new Map<string, number>();
    let mMax = 0;
    for (let s = 0; s <= 40; s++) {
      const t = (s / 40) * 2;
      __test.sampleClip(mc, t, out);
      const mine = evaluateClip(parseAnimationClip(mirrorDoc), t).get("position.x");
      if (mine !== undefined) mMax = Math.max(mMax, Math.abs((out.get("position.x") ?? NaN) - mine));
    }
    check("播放器镜像与框架求值逐点一致（含权重/钳制）", mMax < 1e-12, `maxΔ=${mMax}`);
  }
}

// ---------- 8. 组件序列化金样本（键顺序 + 删键约定，字节兼容守卫） ----------
{
  const node = new Node({ name: "golden" });
  node.components.push(
    { id: "c-script", type: "script", script: "src/g.ts", enabled: true, executionOrder: 2, props: { n: 1 } },
    { id: "c-script0", type: "script", script: "src/g0.ts", enabled: true, executionOrder: 0, props: {} },
    { id: "c-rb", type: "rigidBody", enabled: false, rigidBody: parseRigidBodySettings({}) },
    { id: "c-col", type: "collider", enabled: true, collider: parseColliderSettings({}) },
    { id: "c-light", type: "light", enabled: true, light: parseLightComponentSettings({}) },
    { id: "c-audio", type: "audioSource", enabled: true, audio: parseAudioSettings({}) },
    { id: "c-clip", type: "animationClip", enabled: true, clip: parseAnimClipBinding({}) },
  );
  const comps = (node.toJSON() as Record<string, unknown>).components as Record<
    string,
    unknown
  >[];
  // 键顺序即序列化字节顺序（Rust 侧 JsonMap 透传写入，前端键序落盘）
  const keys = (c: Record<string, unknown>) => JSON.stringify(Object.keys(c));
  check(
    "script 键序（executionOrder≠0 保留）",
    keys(comps[0]) === '["id","type","script","enabled","executionOrder","props"]',
    keys(comps[0]),
  );
  check(
    "script 键序（executionOrder=0 删键）",
    keys(comps[1]) === '["id","type","script","enabled","props"]',
    keys(comps[1]),
  );
  check("rigidBody 键序", keys(comps[2]) === '["id","type","enabled","rigidBody"]', keys(comps[2]));
  check("collider 键序", keys(comps[3]) === '["id","type","enabled","collider"]', keys(comps[3]));
  check("light 键序", keys(comps[4]) === '["id","type","enabled","light"]', keys(comps[4]));
  check("audioSource 键序", keys(comps[5]) === '["id","type","enabled","audio"]', keys(comps[5]));
  check("animationClip 键序", keys(comps[6]) === '["id","type","enabled","clip"]', keys(comps[6]));
  check("enabled=false 保留写出", (comps[2] as { enabled: boolean }).enabled === false);
  // 未登记类型剔除；旧数据无 type 字段按 script 收敛（语义不变）
  const mixed = parseNodeComponents([
    { id: "x1", type: "bogus" },
    { id: "x2", type: "script", script: "src/ok.ts" },
  ]);
  check("解析剔除未登记类型", mixed.length === 1 && mixed[0].type === "script");
}

if (failed) {
  console.error(`\n${failed} 项断言失败`);
  process.exit(1);
} else {
  console.log("\n全部断言通过");
}
