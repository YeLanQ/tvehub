// ---------------------------------------------------------------------------
// Mesh/动画系统冒烟测试（Node 运行；vite --ssr 打包）：
// 覆盖 几何工厂 / MeshNode 序列化 / 动画图解析 / GLB 模型加载 / 动画系统运行时。
// 运行：npm run smoke:mesh
// ---------------------------------------------------------------------------
import * as THREE from "three";
import { geometryRegistry, buildGeometry, ModelManager } from "../src/framework/mesh";
import { NodeFactory } from "../src/framework/factory/NodeFactory";
import { createDefaultRegistry } from "../src/framework/prototype/PrototypeRegistry";
import { MeshNode } from "../src/framework/prototype/nodes/MeshNode";
import {
  AnimationSystem,
  evalCondition,
  parseAnimGraph,
  parseClipSettings,
  type AnimGraph,
} from "../src/framework/animation";

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

async function main(): Promise<void> {

// —— 1. 几何工厂 ——
console.log("[1] geometryRegistry");
ok(geometryRegistry.list().length === 7, "注册 7 种基元");
for (const def of geometryRegistry.list()) {
  const g = buildGeometry(def.key, { x: 1, y: 2, z: 3 });
  ok(!!g.getAttribute("position"), `build(${def.key}) 产出几何`);
}
ok(buildGeometry("unknown-kind", { x: 1, y: 1, z: 1 }).type === "BoxGeometry", "未注册类型回退 box");

// —— 2. MeshNode 序列化（新字段 + 旧场景兼容）——
console.log("[2] MeshNode 序列化");
const graph: AnimGraph = {
  entry: "Idle",
  states: [
    { name: "Idle", clip: "idle", speed: 1, loop: "loop" },
    { name: "Run", clip: "run", speed: 2, loop: "loop" },
  ],
  transitions: [
    { id: "t1", from: "Idle", to: "Run", duration: 0.3, exitTime: 0.5, conditions: [{ param: "go", op: "==", value: 1 }] },
  ],
  params: { go: 0 },
};
const meshNode = new MeshNode({
  name: "Role",
  source: "model",
  model: "assets/models/role.glb",
  material: "",
  anim: { autoplay: true, clip: "idle", speed: 1.5, loop: "pingpong" },
  animGraph: graph,
});
const json = JSON.parse(JSON.stringify(meshNode.toJSON())) as Record<string, unknown>;
const restored = MeshNode.fromJSON(json as Record<string, unknown>);
ok(restored.source === "model", "source 序列化往返");
ok(restored.model === "assets/models/role.glb", "model 引用往返");
ok(restored.anim.speed === 1.5 && restored.anim.loop === "pingpong", "anim 设置往返");
ok(
  restored.animGraph != null &&
    restored.animGraph.transitions.length === 1 &&
    restored.animGraph.transitions[0].conditions[0].param === "go",
  "动画图往返",
);
const legacy = MeshNode.fromJSON({ type: "meshNode", name: "旧场景", geometry: "sphere", material: "internal/materials/Default.mat" });
ok(legacy.source === "primitive" && legacy.animGraph === null && legacy.anim.autoplay === true, "旧场景数据兼容（无新字段）");

// —— 3. 工厂 ——
console.log("[3] NodeFactory");
const factory = new NodeFactory(createDefaultRegistry());
const modelNode = factory.createModel("assets/models/Hero.glb");
ok(modelNode.source === "model" && modelNode.name === "Hero", "createModel：来源/默认命名");
const primNode = factory.createMesh("cone");
ok(primNode.geometry === "cone" && primNode.name === "Cone", "createMesh：注册表默认命名");

// —— 4. 动画图解析 ——
console.log("[4] parseAnimGraph");
ok(parseAnimGraph(null) === null && parseAnimGraph({ states: [] }) === null, "空数据 → null");
const parsed = parseAnimGraph({
  entry: "Nope",
  states: [{ name: "A", clip: "a" }, { name: "B", clip: "b" }, { name: "A", clip: "dup" }],
  transitions: [{ from: "A", to: "Missing", duration: -1 }, { from: "A", to: "B", duration: 0.4 }],
});
ok(parsed !== null && parsed.entry === "A", "入口非法回退首状态");
ok(parsed !== null && parsed.states.length === 2, "重名状态去重");
ok(parsed !== null && parsed.transitions.length === 1 && parsed.transitions[0].duration === 0.4, "无效过渡剔除 + 参数收敛");
ok(parseClipSettings({ speed: -3, loop: "xxx" }).speed === 0, "剪辑设置收敛（负速度/非法循环）");
ok(evalCondition(1, { param: "go", op: "==", value: 1 }) && !evalCondition(true, { param: "go", op: "==", value: 0 }), "条件求值（数值/布尔）");

// —— 5. 模型加载（最小 GLB：单节点 + 单旋转动画剪辑）——
console.log("[5] ModelManager + GLB");
const glb = buildMinimalAnimatedGlb();
const glbBuffer = glb.slice().buffer as ArrayBuffer;
const models = new ModelManager();
models.setAccess({
  readBinary: async (rel) => (rel === "assets/models/role.glb" ? glbBuffer : null),
  urlFor: () => null,
});
await models.preload(["assets/models/role.glb"]);
ok(models.has("assets/models/role.glb"), "GLB 解析就绪");
const meta = models.metaFor("assets/models/role.glb");
ok(meta !== null && meta.clips.length === 1 && !meta.hasSkeleton, "剪辑清单（1 个，无骨骼）");
ok(
  meta !== null && meta.materials.length === 1 && meta.materials[0].name === "Body" && meta.materials[0].type === "PBR",
  "内嵌材质清单（名称 + 类型标签）",
);
const instA = models.instantiate("assets/models/role.glb");
const instB = models.instantiate("assets/models/role.glb");
ok(instA !== null && instB !== null && instA.uuid !== instB.uuid, "实例化产出独立克隆");
const bad = await models.preload(["assets/models/broken.xyz"]).then(() => models.errorFor("assets/models/broken.xyz"));
ok(bad !== null && bad.includes("不支持的模型格式"), "未知格式记为错误（不抛出）");

// —— 6. 动画系统运行时（单剪辑 + 动画图状态机）——
console.log("[6] AnimationSystem");
const arm = new THREE.Object3D();
arm.name = "Arm";
const root = new THREE.Object3D();
root.add(arm);
// 手工剪辑：0-1s 旋转 Arm
const times = new Float32Array([0, 1]);
const quat = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0]);
const clip = new THREE.AnimationClip("swing", 1, [
  new THREE.QuaternionKeyframeTrack("Arm.quaternion", times, quat),
]);
const clip2 = new THREE.AnimationClip("spin", 2, [
  new THREE.QuaternionKeyframeTrack("Arm.quaternion", new Float32Array([0, 2]), new Float32Array([0, 0, 0, 1, 0, 1, 0, 0])),
]);

const animation = new AnimationSystem();
const fakeNode = {
  id: "mesh_test",
  anim: { autoplay: true, clip: "swing", speed: 1, loop: "loop" as const },
  animGraph: null,
};
animation.syncNode(fakeNode, root, [clip, clip2]);
animation.update(0.1);
let st = animation.stateFor("mesh_test");
ok(st !== null && st.mode === "clip" && st.clip === "swing" && st.playing, "单剪辑自动播放");
const q0 = arm.quaternion.z;
animation.update(0.45);
ok(Math.abs(arm.quaternion.z - q0) > 1e-4, "mixer 推进骨骼/节点旋转");
animation.pause("mesh_test");
ok(animation.stateFor("mesh_test")?.playing === false, "暂停");
animation.play("mesh_test");
ok(animation.stateFor("mesh_test")?.playing === true, "恢复播放");
animation.stop("mesh_test");
ok(animation.stateFor("mesh_test")?.clip === null, "停止复位");

// 动画图：Idle --(go==1, exitTime>=0.5)--> Run
const graphNode = {
  id: "mesh_graph",
  anim: { autoplay: true, clip: "", speed: 1, loop: "loop" as const },
  animGraph: {
    entry: "Idle",
    states: [
      { name: "Idle", clip: "swing", speed: 1, loop: "loop" as const },
      { name: "Run", clip: "spin", speed: 1, loop: "loop" as const },
    ],
    transitions: [
      { id: "t1", from: "Idle", to: "Run", duration: 0.1, exitTime: 0.4, conditions: [{ param: "go", op: "==", value: 1 }] },
    ],
    params: { go: 0 },
  },
};
animation.syncNode(graphNode, root, [clip, clip2]);
animation.update(0.2);
ok(animation.stateFor("mesh_graph")?.graphState === "Idle", "图：入口状态 Idle");
animation.setParam("mesh_graph", "go", 1); // 条件满足但未到退出时间
animation.update(0.1);
ok(animation.stateFor("mesh_graph")?.graphState === "Idle", "图：exitTime 未到不过渡");
animation.update(0.3); // 超过 0.4 归一化进度
ok(animation.stateFor("mesh_graph")?.graphState === "Run", "图：条件 + exitTime → 过渡 Run");
animation.forceState("mesh_graph", "Idle");
ok(animation.stateFor("mesh_graph")?.graphState === "Idle", "图：手动切状态");
// 节点图数据未变（签名一致）→ 重放 syncNode 不重置运行时
animation.setParam("mesh_graph", "go", 0);
animation.syncNode(graphNode, root, [clip, clip2]);
ok(animation.stateFor("mesh_graph")?.graphState === "Idle", "同实例重绑保留图状态");

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// 构造最小 GLB（二进制）：单节点 Arm + 三角形网格（PBR 材质 Body）+ rotation 动画
// ---------------------------------------------------------------------------
function buildMinimalAnimatedGlb(): Uint8Array {
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Arm", mesh: 0, rotation: [0, 0, 0, 1] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 2 }, material: 0 }] }],
    materials: [{ name: "Body", pbrMetallicRoughness: { baseColorFactor: [0.8, 0.2, 0.2, 1] } }],
    animations: [
      {
        channels: [{ sampler: 0, target: { node: 0, path: "rotation" } }],
        samplers: [{ input: 0, output: 1, interpolation: "LINEAR" }],
      },
    ],
    accessors: [
      { componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [1], bufferView: 0, byteOffset: 0 },
      { componentType: 5126, count: 2, type: "VEC4", bufferView: 0, byteOffset: 8 },
      { componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0], bufferView: 0, byteOffset: 40 },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 76 }],
    buffers: [{ byteLength: 76 }],
  };
  const bin = new Float32Array([
    0, 1, // input: t=0, t=1
    0, 0, 0, 1, // output[0]: identity
    0, 0, 1, 0, // output[1]: 180° around Z
    0, 0, 0, // POSITION[0]
    1, 0, 0, // POSITION[1]
    0.5, 1, 0, // POSITION[2]
  ]);
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const binBytes = new Uint8Array(bin.buffer);
  const pad4 = (n: number): number => (4 - (n % 4)) % 4;
  const jsonPad = pad4(jsonBytes.length);
  const binPad = pad4(binBytes.length);
  const jsonLen = jsonBytes.length + jsonPad;
  const binLen = binBytes.length + binPad;
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint32(o, 0x46546c67, true); o += 4; // magic "glTF"
  dv.setUint32(o, 2, true); o += 4; // version
  dv.setUint32(o, total, true); o += 4;
  dv.setUint32(o, jsonLen, true); o += 4;
  dv.setUint32(o, 0x4e4f534a, true); o += 4; // "JSON"
  out.set(jsonBytes, o); o += jsonBytes.length;
  for (let i = 0; i < jsonPad; i++) out[o++] = 0x20; // space padding
  dv.setUint32(o, binLen, true); o += 4;
  dv.setUint32(o, 0x004e4942, true); o += 4; // "BIN"
  out.set(binBytes, o); o += binBytes.length;
  return out;
}
