// 碰撞体辅助线框冒烟测试：验证共享形状计算（physics/colliderShape.ts）与
// 线框几何构建（helpers/colliderWireframe.ts）的语义正确性（headless，无需 GPU）。
// 跑法同 smoke:physics：
//   npx vite build --ssr scripts/smoke-collider-helper.ts --outDir .tmp-smoke --emptyOutDir
//   node .tmp-smoke/smoke-collider-helper.js

import * as THREE from "three";
import {
  computeColliderLocalBounds,
  computeColliderShapeDesc,
  downsampleHeightfield,
  terrainMeshSigOf,
} from "../../../src/framework/physics/colliderShape";
import { buildColliderWireframe } from "../../../src/framework/engine/modules/helpers/colliderWireframe";
import { ColliderNodeHelper } from "../../../src/framework/engine/modules/helpers/ColliderNodeHelper";
import { Node } from "../../../src/framework/prototype/Node";
import {
  DEFAULT_COLLIDER_SETTINGS,
  parseColliderSettings,
  snapHeightfieldResolution,
  type ColliderSettings,
} from "../../../src/framework/physics/types";
import { approx, createSuite } from "../harness.mjs";

const { check, finish } = createSuite();

function unitBoxObject(): THREE.Object3D {
  const obj = new THREE.Object3D();
  obj.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
  return obj;
}

function settings(patch: Partial<ColliderSettings>): ColliderSettings {
  return { ...DEFAULT_COLLIDER_SETTINGS, ...patch };
}

// ---------- 1. autoSize 包围盒 ----------
{
  const obj = unitBoxObject();
  const desc = computeColliderShapeDesc(settings({ shape: "box", autoSize: true }), obj);
  check(
    "autoSize box 半尺寸 = 0.5",
    approx(desc.halfExtents.x, 0.5) && approx(desc.halfExtents.y, 0.5) && approx(desc.halfExtents.z, 0.5),
    JSON.stringify(desc.halfExtents),
  );
  check("autoSize box 偏移 = 包围盒中心", approx(desc.offset.x, 0) && approx(desc.offset.y, 0) && approx(desc.offset.z, 0));
}

// 偏心子网格：包围盒中心应计入偏移
{
  const obj = new THREE.Object3D();
  const child = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  child.position.set(0, 2, 0);
  obj.add(child);
  const desc = computeColliderShapeDesc(settings({ shape: "box", autoSize: true }), obj);
  check(
    "autoSize 偏心子网格 → 中心计入偏移",
    approx(desc.offset.y, 2) && approx(desc.halfExtents.y, 0.5),
    JSON.stringify({ offset: desc.offset, half: desc.halfExtents }),
  );
  const bounds = computeColliderLocalBounds(obj);
  check("computeColliderLocalBounds 返回中心/半尺寸", !!bounds && approx(bounds.center.y, 2));
}

// ---------- 2. 显式尺寸与世界缩放 ----------
{
  const scaled = unitBoxObject();
  scaled.scale.set(2, 2, 2);
  scaled.updateMatrixWorld(true);
  const desc = computeColliderShapeDesc(
    settings({ shape: "box", autoSize: false, size: { x: 2, y: 4, z: 6 } }),
    scaled,
  );
  check(
    "显式尺寸 box → 半尺寸 (1,2,3)，世界缩放 ×2 → (2,4,6)",
    approx(desc.halfExtents.x, 2) && approx(desc.halfExtents.y, 4) && approx(desc.halfExtents.z, 6),
    JSON.stringify(desc.halfExtents),
  );

  const sphere = computeColliderShapeDesc(
    settings({ shape: "sphere", autoSize: false, size: { x: 2, y: 4, z: 6 } }),
    scaled,
  );
  // 半尺寸 (1,2,3) × 缩放 2 → uniform=2 × max(1,2,3)=3 → 半径 6
  check("sphere 半径 = uniform×max(半尺寸) = 6", approx(sphere.radius, 6), String(sphere.radius));
}

// capsule/cylinder：半径/柱半高乘世界缩放（与建体实现一致，线框自然吻合）
{
  const plain = unitBoxObject();
  const capsule = computeColliderShapeDesc(
    settings({ shape: "capsule", autoSize: false, size: { x: 2, y: 6, z: 2 } }),
    plain,
  );
  // half=(1,3,1) → radius=max(1,1)=1，halfHeight=3
  check(
    "capsule 半径 1 / 柱半高 3",
    approx(capsule.radius, 1) && approx(capsule.halfHeight, 3),
    JSON.stringify({ radius: capsule.radius, halfHeight: capsule.halfHeight }),
  );

  const cylinder = computeColliderShapeDesc(
    settings({ shape: "cylinder", autoSize: false, size: { x: 2, y: 4, z: 2 } }),
    plain,
  );
  check(
    "cylinder 半径 1 / 柱半高 2",
    approx(cylinder.radius, 1) && approx(cylinder.halfHeight, 2),
    JSON.stringify({ radius: cylinder.radius, halfHeight: cylinder.halfHeight }),
  );
}

// ---------- 3. 线框几何 ----------
{
  const boxGeom = buildColliderWireframe({
    shape: "box",
    halfExtents: { x: 1, y: 2, z: 3 },
    radius: 1,
    halfHeight: 1,
    points: [],
    offset: { x: 0, y: 0, z: 0 },
    friction: 0,
    restitution: 0,
    isSensor: false,
  });
  check("box 线框 = 12 棱 24 端点", boxGeom.getAttribute("position").count === 24);

  const sphereGeom = buildColliderWireframe({
    shape: "sphere",
    halfExtents: { x: 1, y: 1, z: 1 },
    radius: 1,
    halfHeight: 1,
    points: [],
    offset: { x: 0, y: 0, z: 0 },
    friction: 0,
    restitution: 0,
    isSensor: false,
  });
  check("sphere 线框非空", sphereGeom.getAttribute("position").count > 0);
  // 半径 1 的球：线框最大模长应为 1
  const arr = sphereGeom.getAttribute("position").array as Float32Array;
  let maxLen = 0;
  for (let i = 0; i < arr.length; i += 3) {
    maxLen = Math.max(maxLen, Math.hypot(arr[i], arr[i + 1], arr[i + 2]));
  }
  check("sphere 线框半径正确", approx(maxLen, 1, 1e-4), String(maxLen));

  const capsuleGeom = buildColliderWireframe({
    shape: "capsule",
    halfExtents: { x: 1, y: 1, z: 1 },
    radius: 0.5,
    halfHeight: 0.5,
    points: [],
    offset: { x: 0, y: 0, z: 0 },
    friction: 0,
    restitution: 0,
    isSensor: false,
  });
  check("capsule 线框非空", capsuleGeom.getAttribute("position").count > 0);

  const cylGeom = buildColliderWireframe({
    shape: "cylinder",
    halfExtents: { x: 1, y: 1, z: 1 },
    radius: 0.5,
    halfHeight: 2,
    points: [],
    offset: { x: 0, y: 0, z: 0 },
    friction: 0,
    restitution: 0,
    isSensor: false,
  });
  check("cylinder 线框非空", cylGeom.getAttribute("position").count > 0);

  // convex：四面体采样点 → 凸包棱
  const tetra: number[] = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, 0.5, 1];
  const convexGeom = buildColliderWireframe({
    shape: "convex",
    halfExtents: { x: 1, y: 1, z: 1 },
    radius: 1,
    halfHeight: 1,
    points: tetra,
    offset: { x: 0, y: 0, z: 0 },
    friction: 0,
    restitution: 0,
    isSensor: false,
  });
  check("convex（四面体）线框非空", convexGeom.getAttribute("position").count > 0);

  // convex：空采样点 → 单位盒兜底
  const convexFallback = buildColliderWireframe({
    shape: "convex",
    halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
    radius: 1,
    halfHeight: 1,
    points: [],
    offset: { x: 0, y: 0, z: 0 },
    friction: 0,
    restitution: 0,
    isSensor: false,
  });
  check("convex 空点兜底线框非空", convexFallback.getAttribute("position").count > 0);

  // autoSize + convex：从真实网格采样顶点 → 凸包线框
  const sphereMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8));
  const desc = computeColliderShapeDesc(
    settings({ shape: "convex", autoSize: true }),
    sphereMesh,
  );
  check("autoSize convex 采样点 ≤ 64×3", desc.points.length > 0 && desc.points.length <= 64 * 3, String(desc.points.length));
  const convexFromMesh = buildColliderWireframe(desc);
  check("convex（网格采样）线框非空", convexFromMesh.getAttribute("position").count > 0);
}

// ---------- 4. ColliderNodeHelper 集成 ----------
{
  const ctx = { getAspect: () => 1, getEditorDistanceTo: () => 10 };
  const obj = new THREE.Object3D();
  obj.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
  obj.position.set(1, 2, 3);
  obj.rotation.y = Math.PI / 2;
  obj.scale.set(2, 2, 2);
  obj.updateMatrixWorld(true);

  const node = new Node({ name: "box" });
  node.components.push({
    id: "col-1",
    type: "collider",
    enabled: true,
    collider: settings({ shape: "box", autoSize: false, size: { x: 2, y: 2, z: 2 } }),
  });

  const helper = new ColliderNodeHelper();
  helper.sync(node, obj, ctx as never);
  const first = helper.object.children[0] as THREE.LineSegments | undefined;
  check("helper 为启用碰撞体创建 LineSegments", !!first && first.isLineSegments);
  check("线段挂偏移位置（显式尺寸 → 0）", !!first && first.position.lengthSq() < 1e-9);

  // 位姿贴合：位置/旋转跟随世界变换，但缩放恒为单位（形状已烘焙世界缩放）
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  helper.object.matrix.decompose(pos, quat, scl);
  check(
    "helper 矩阵贴合世界位置 (1,2,3)",
    approx(pos.x, 1) && approx(pos.y, 2) && approx(pos.z, 3),
    JSON.stringify(pos.toArray()),
  );
  check(
    "helper 矩阵贴合世界旋转（绕 Y 90°）",
    approx(Math.abs(quat.y), Math.SQRT1_2, 1e-4) && approx(quat.w, Math.SQRT1_2, 1e-4),
    JSON.stringify(quat.toArray()),
  );
  check(
    "helper 矩阵缩放恒为单位（对象缩放 2 不二次放大）",
    approx(scl.x, 1) && approx(scl.y, 1) && approx(scl.z, 1),
    JSON.stringify(scl.toArray()),
  );

  // 组件禁用 → 隐藏
  (node.components[0] as { enabled: boolean }).enabled = false;
  helper.sync(node, obj, ctx as never);
  check("组件禁用 → 线框隐藏", helper.object.visible === false && helper.object.children.length === 0);

  // 重新启用 + 改形状 → 重建（box → sphere）
  const comp = node.components[0] as { enabled: boolean; collider: ColliderSettings };
  comp.enabled = true;
  comp.collider.shape = "sphere";
  helper.sync(node, obj, ctx as never);
  check("改形状 → 线框重建", helper.object.visible === true && helper.object.children.length === 1);

  helper.dispose();
  check("dispose 释放全部子对象", helper.object.children.length === 0);
}

// ---------- 5. heightfield（高度场：下采样 / 缩放烘焙 / 回退 / 线框有界 / 签名） ----------
{
  // resolution 吸附：非法值回默认 128，任意值吸附到合法档位
  check("resolution 缺省 128", parseColliderSettings({}).resolution === 128);
  check("resolution 吸附 300→256 / 100→128 / 50→64",
    snapHeightfieldResolution(300) === 256 && snapHeightfieldResolution(100) === 128 && snapHeightfieldResolution(50) === 64);

  // 带地形缓存的伪地形对象（两平台 x<0 高 1 / x≥0 高 3）
  const s = 64;
  const heights = new Float32Array(s * s);
  for (let iz = 0; iz < s; iz++) {
    for (let ix = 0; ix < s; ix++) heights[iz * s + ix] = ix < s / 2 ? 1 : 3;
  }
  const terrainObj = new THREE.Object3D();
  const terrainMesh = new THREE.Mesh(new THREE.BoxGeometry(10, 1, 10));
  terrainMesh.userData.terrainSig = "sig-1";
  terrainMesh.userData.terrainHeights = heights;
  terrainMesh.userData.terrainGridSize = s;
  terrainMesh.userData.terrainSize = 10;
  terrainObj.add(terrainMesh);

  const desc = computeColliderShapeDesc(settings({ shape: "heightfield", resolution: 64 }), terrainObj);
  check("heightfield desc 采样数/边长", desc.samples === 64 && desc.terrainSizeX === 10 && desc.terrainSizeZ === 10);
  check("heightfield desc min/max", desc.minHeight === 1 && desc.maxHeight === 3);
  check("heightfield desc 保留平台值（下采样取真实烘焙点）",
    !!desc.heights && desc.heights[0] === 1 && desc.heights[desc.heights.length - 1] === 3);

  // 世界缩放烘焙：Y 缩放乘进高度，XZ 缩放乘进边长
  const scaled = new THREE.Object3D();
  const scaledMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  scaledMesh.userData.terrainHeights = heights;
  scaledMesh.userData.terrainGridSize = s;
  scaledMesh.userData.terrainSize = 10;
  scaled.add(scaledMesh);
  scaled.scale.set(2, 2, 2);
  scaled.updateMatrixWorld(true);
  const scaledDesc = computeColliderShapeDesc(settings({ shape: "heightfield", resolution: 64 }), scaled);
  check("heightfield 缩放烘焙（Y×2 → 高度 2..6；XZ×2 → 边长 20）",
    !!scaledDesc.heights && scaledDesc.minHeight === 2 && scaledDesc.maxHeight === 6 &&
    scaledDesc.terrainSizeX === 20 && scaledDesc.terrainSizeZ === 20);

  // 非地形节点：heights 为 null（后端/线框各自回退盒形），告警只发一次
  const plainDesc = computeColliderShapeDesc(settings({ shape: "heightfield" }), unitBoxObject());
  check("非地形节点 heightfield → desc.heights 为 null（后端回退盒形）", plainDesc.heights === null);

  // 线框：顶点数有界（每轴 ≤ ~33 条剖面线 × 2 方向），高度取样正确
  const hfGeom = buildColliderWireframe(desc);
  check("heightfield 线框非空且有界（≤ 10000 端点）",
    hfGeom.getAttribute("position").count > 0 && hfGeom.getAttribute("position").count <= 10000,
    String(hfGeom.getAttribute("position").count));
  const nullGeom = buildColliderWireframe(plainDesc);
  check("heightfield 无数据 → 线框回退盒形（24 端点）", nullGeom.getAttribute("position").count === 24);

  // downsampleHeightfield：源 3×3 → 目标 5×5，角点保持源值
  const src = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const ds = downsampleHeightfield(src, 3, 5, 1);
  check("downsample 角点保持源值", ds[0] === 0 && ds[4] === 2 && ds[20] === 6 && ds[24] === 8);
  const dsScaled = downsampleHeightfield(src, 3, 5, 2);
  check("downsample scaleY 烘焙", dsScaled[24] === 16);

  // 签名：地形网格内容签名参与重建判定
  check("terrainMeshSigOf 读取地形签名", terrainMeshSigOf(terrainObj) === "sig-1");
  check("terrainMeshSigOf 无地形为空串", terrainMeshSigOf(unitBoxObject()) === "");
}

finish();
