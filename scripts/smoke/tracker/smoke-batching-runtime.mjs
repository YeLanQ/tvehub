// ---------------------------------------------------------------------------
// 批处理优化「网页运行时」冒烟（Node 直接运行，不经打包）：
// 喂真实 buildSceneTree + optimizeScene 构建链路，验证烘焙副本的世界变换正确——
//   ① 同材质同几何（实例化路径）：变换过的父节点下的网格必须按**世界**矩阵
//     烘进 InstancedMesh（回归：烘焙时场景世界矩阵未刷新，祖先变换全丢，
//     副本烘到错误位置 → 原网格又已隐藏，视觉上整组消失）；
//   ② 同材质不同几何（合并路径）：合并几何的世界包围盒含父链变换；
//   ③ 平铺场景（无父变换）实例矩阵不变；
//   ④ 不同材质各自成组 <2 → 不批处理，原网格保持可见；
//   ⑤ excludeNodeIds（脚本图引用实体）不烘焙；
//   ⑥ 父链可动（祖先被图引用/带脚本/刚体组件/导航代理/动画绑定）→ 子网格
//     不烘焙，父级被驱动移动后子网格同步跟随（回归：只查网格自身可动性，
//     可动父节点下的同材质子网格被烘焙后留在原地不跟随）。
// 运行：pnpm smoke batching-runtime
// ---------------------------------------------------------------------------
import { createSuite, runtimeURL as runtime, coreURL as core } from "../harness.mjs";

const { ok, finish } = createSuite();

const { buildSceneTree } = await import(runtime("nodes.mjs"));
const { optimizeScene } = await import(runtime("batching.mjs"));
const { MAT_DEFAULTS } = await import(runtime("material.mjs"));
const THREE = await import(core("three.module.min.js"));

// 完整材质默认值（MeshStandardMaterial 分支会把每个字段透传给 three，
// 散传字段缺省会在 Node 控制台刷 undefined 参数告警）
const matOf = (color) => ({ ...MAT_DEFAULTS, color });

const meshJson = (id, extra = {}) => ({
  type: "meshNode",
  id,
  name: id,
  source: "primitive",
  geometry: "box",
  size: { x: 1, y: 1, z: 1 },
  material: "mat-a",
  ...extra,
});

function entryOf(built, id) {
  return built.nodes.find((n) => n.json.id === id);
}
function worldPosOf(obj) {
  obj.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
}

console.log("[1] 实例化路径：变换过的父节点下同材质网格按世界矩阵烘焙");
{
  const scene = new THREE.Scene();
  const sceneJson = {
    type: "node",
    id: "root",
    children: [
      {
        type: "node",
        id: "group",
        transform: { position: { x: 100, y: 20, z: -50 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        children: [
          meshJson("a", { transform: { position: { x: 5, y: 0, z: 0 } } }),
          meshJson("b", { transform: { position: { x: -5, y: 0, z: 0 } } }),
        ],
      },
    ],
  };
  const built = buildSceneTree(sceneJson, scene, {
    materialParams: new Map([["mat-a", matOf(0xff0000)]]),
    models: new Map(),
  });
  const meshes = built.nodes.filter((n) => n.json.type === "meshNode");
  optimizeScene(scene, meshes, [], { nodes: built.nodes });

  const a = entryOf(built, "a").obj;
  const b = entryOf(built, "b").obj;
  const inst = scene.children.find((c) => c.name === "__batchedInstances");
  ok(!!inst && !a.visible && !b.visible, "同材质成组 → InstancedMesh 替代、原网格隐藏");

  // 期望世界位置：父旋转 y=90° 把 ±x 映到 ∓z
  const expA = worldPosOf(a);
  const expB = worldPosOf(b);
  const m = new THREE.Matrix4();
  inst.getMatrixAt(0, m);
  const p0 = new THREE.Vector3().setFromMatrixPosition(m);
  inst.getMatrixAt(1, m);
  const p1 = new THREE.Vector3().setFromMatrixPosition(m);
  const near = (p, q) => p.distanceTo(q) < 1e-4;
  ok(
    (near(p0, expA) && near(p1, expB)) || (near(p0, expB) && near(p1, expA)),
    `实例矩阵 = 完整世界变换（期望 ${expA.toArray().map((v) => v.toFixed(1))} / ${expB.toArray().map((v) => v.toFixed(1))}）`,
  );
}

console.log("[2] 合并路径：同材质不同几何的世界包围盒含父链变换");
{
  const scene = new THREE.Scene();
  const sceneJson = {
    type: "node",
    id: "root",
    children: [
      {
        type: "node",
        id: "group",
        transform: { position: { x: 100, y: 20, z: -50 } },
        children: [
          meshJson("a", { geometry: "box", transform: { position: { x: 5, y: 0, z: 0 } } }),
          meshJson("b", { geometry: "sphere", size: { x: 2, y: 2, z: 2 }, transform: { position: { x: -5, y: 0, z: 0 } } }),
        ],
      },
    ],
  };
  const built = buildSceneTree(sceneJson, scene, {
    materialParams: new Map([["mat-a", matOf(0x00ff00)]]),
    models: new Map(),
  });
  const meshes = built.nodes.filter((n) => n.json.type === "meshNode");
  optimizeScene(scene, meshes, [], { nodes: built.nodes });

  const merged = scene.children.find((c) => c.name === "__batchedMerge");
  ok(!!merged, "同材质不同几何 → mergeGeometries 合并");
  if (merged) {
    // 世界空间回归检查：合并几何应落在 group 偏移附近（x≈100，z≈-50）
    merged.geometry.computeBoundingBox();
    const bb = merged.geometry.boundingBox;
    ok(
      bb.min.x > 90 && bb.max.x > 100 && bb.min.z < -40 && bb.max.z < -40 + 12,
      `合并几何为世界空间（x∈[${bb.min.x.toFixed(1)},${bb.max.x.toFixed(1)}] z∈[${bb.min.z.toFixed(1)},${bb.max.z.toFixed(1)}]，期望以 (100,-50) 为中心）`,
    );
  }
}

console.log("[3] 平铺场景（无父变换）实例矩阵不变");
{
  const scene = new THREE.Scene();
  const sceneJson = {
    type: "node",
    id: "root",
    children: [
      meshJson("a", { transform: { position: { x: 5, y: 0, z: 0 } } }),
      meshJson("b", { transform: { position: { x: -5, y: 0, z: 0 } } }),
    ],
  };
  const built = buildSceneTree(sceneJson, scene, {
    materialParams: new Map([["mat-a", matOf(0xff0000)]]),
    models: new Map(),
  });
  const meshes = built.nodes.filter((n) => n.json.type === "meshNode");
  optimizeScene(scene, meshes, [], { nodes: built.nodes });
  const inst = scene.children.find((c) => c.name === "__batchedInstances");
  const m = new THREE.Matrix4();
  const ps = [];
  for (let i = 0; i < inst.count; i++) {
    inst.getMatrixAt(i, m);
    ps.push(new THREE.Vector3().setFromMatrixPosition(m));
  }
  ok(
    inst.count === 2 && ps.some((p) => p.x === 5) && ps.some((p) => p.x === -5),
    "平铺场景实例位置 (±5,0,0) 保持",
  );
}

console.log("[4] 不同材质各自成组 <2 → 不批处理");
{
  const scene = new THREE.Scene();
  const sceneJson = {
    type: "node",
    id: "root",
    children: [meshJson("a", { material: "mat-a" }), meshJson("b", { material: "mat-b" })],
  };
  const built = buildSceneTree(sceneJson, scene, {
    materialParams: new Map([
      ["mat-a", matOf(0xff0000)],
      ["mat-b", matOf(0x0000ff)],
    ]),
    models: new Map(),
  });
  const meshes = built.nodes.filter((n) => n.json.type === "meshNode");
  optimizeScene(scene, meshes, [], { nodes: built.nodes });
  const a = entryOf(built, "a").obj;
  const b = entryOf(built, "b").obj;
  ok(
    a.visible && b.visible && !scene.children.some((c) => c.name.startsWith("__batched")),
    "材质不同不成组，原网格保持可见",
  );
}

console.log("[5] excludeNodeIds（脚本图引用实体）不烘焙");
{
  const scene = new THREE.Scene();
  const sceneJson = {
    type: "node",
    id: "root",
    children: [meshJson("a"), meshJson("b"), meshJson("c")],
  };
  const built = buildSceneTree(sceneJson, scene, {
    materialParams: new Map([["mat-a", matOf(0xff0000)]]),
    models: new Map(),
  });
  const meshes = built.nodes.filter((n) => n.json.type === "meshNode");
  optimizeScene(scene, meshes, [], { excludeNodeIds: ["a"], nodes: built.nodes });
  const a = entryOf(built, "a").obj;
  ok(a.visible, "被引用实体不烘焙、保持可见");
  const baked = scene.children.find((c) => c.name === "__batchedInstances");
  ok(!!baked && baked.count === 2, "其余同材质网格照常实例化");
}

console.log("[6] 图引用父节点 → 子网格不烘焙，父级移动时同步跟随");
{
  const scene = new THREE.Scene();
  const sceneJson = {
    type: "node",
    id: "root",
    children: [
      {
        type: "node",
        id: "carrier",
        children: [meshJson("a"), meshJson("b"), meshJson("c")],
      },
    ],
  };
  const built = buildSceneTree(sceneJson, scene, {
    materialParams: new Map([["mat-a", matOf(0xff0000)]]),
    models: new Map(),
  });
  const meshes = built.nodes.filter((n) => n.json.type === "meshNode");
  optimizeScene(scene, meshes, [], {
    excludeNodeIds: ["carrier"], // 父节点被脚本图引用（会被图驱动移动）
    nodes: built.nodes,
  });
  const a = entryOf(built, "a").obj;
  const b = entryOf(built, "b").obj;
  ok(
    a.visible && b.visible && !scene.children.some((c) => c.name.startsWith("__batched")),
    "可动父节点下的子网格全部不烘焙、保持可见",
  );
  // 回归症状本体：父级被驱动移动后，子网格必须跟着走（留在原地 = 被烘焙了）
  const carrier = entryOf(built, "carrier").obj;
  carrier.position.set(50, 10, -20);
  carrier.updateMatrixWorld(true);
  const wp = worldPosOf(a);
  ok(
    wp.x === 50 && wp.y === 10 && wp.z === -20,
    `父级移动后子网格世界位置跟随（got ${wp.toArray().map((v) => v.toFixed(0))}）`,
  );
}

console.log("[7] 祖先带 script/rigidBody 组件或导航代理/动画绑定 → 子网格不烘焙");
{
  const mk = (extra) => ({
    type: "node",
    id: "root",
    children: [{ type: "node", id: "carrier", ...extra, children: [meshJson("a"), meshJson("b")] }],
  });
  const cases = [
    ["script 组件", mk({ components: [{ id: "s1", type: "script", enabled: true }] }), {}],
    ["rigidBody 组件", mk({ components: [{ id: "r1", type: "rigidBody", enabled: true }] }), {}],
    ["navAgentNode", mk({ type: "navAgentNode" }), {}],
    ["动画绑定", mk({}), { clips: [{ nodeId: "carrier" }] }],
  ];
  for (const [label, sceneJson, extraOpts] of cases) {
    const scene = new THREE.Scene();
    const built = buildSceneTree(sceneJson, scene, {
      materialParams: new Map([["mat-a", matOf(0xff0000)]]),
      models: new Map(),
    });
    const meshes = built.nodes.filter((n) => n.json.type === "meshNode");
    optimizeScene(scene, meshes, extraOpts.clips ?? [], { nodes: built.nodes });
    const a = entryOf(built, "a").obj;
    ok(
      a.visible && !scene.children.some((c) => c.name.startsWith("__batched")),
      `${label}祖先 → 子网格不烘焙`,
    );
  }
}

finish();
