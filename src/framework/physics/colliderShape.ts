// ---------------------------------------------------------------------------
// 碰撞形状计算（物理系统建体与编辑器辅助线框共用的唯一权威实现）。
//
// - computeColliderShapeDesc：由碰撞体设置 + 节点场景对象推导 ColliderShapeDesc
//   （半尺寸/半径/偏移均为世界单位；物理体不支持缩放变换，对象世界缩放烘进形状）；
// - PhysicsSystem 建体与 ColliderNodeHelper 画线框都走这里，保证所见即所碰。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import type { Vec3 } from "../prototype/types";
import type { ColliderShapeDesc } from "./backend/types";
import type { ColliderSettings } from "./types";

/** autoSize 时对象局部空间包围盒 + convex 顶点采样结果 */
export interface ColliderLocalBounds {
  center: Vec3;
  half: Vec3;
  points: number[];
}

/** 对象局部空间包围盒 + convex 顶点采样（遍历子网格；含子变换、不含对象自身缩放） */
export function computeColliderLocalBounds(obj: THREE.Object3D): ColliderLocalBounds | null {
  obj.updateWorldMatrix(true, true);
  const box = new THREE.Box3().makeEmpty();
  const objInv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const childMat = new THREE.Matrix4();
  const sampleMat = new THREE.Matrix4();
  const meshPoints: (THREE.BufferAttribute | THREE.InterleavedBufferAttribute)[] = [];
  let firstSeen = false;
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!(mesh as THREE.Mesh).isMesh || !mesh.geometry) return;
    childMat.copy(mesh.matrixWorld).premultiply(objInv);
    const geo = mesh.geometry;
    geo.computeBoundingBox();
    if (geo.boundingBox) {
      const b = geo.boundingBox.clone().applyMatrix4(childMat);
      box.union(b);
    }
    if (!firstSeen) {
      firstSeen = true;
      const pos = geo.getAttribute("position");
      if (pos) {
        meshPoints.push(pos);
        sampleMat.copy(mesh.matrixWorld).premultiply(objInv);
      }
    }
  });
  if (box.isEmpty()) return null;
  const min = box.min;
  const max = box.max;
  const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
  const half = {
    x: Math.max(0.05, (max.x - min.x) / 2),
    y: Math.max(0.05, (max.y - min.y) / 2),
    z: Math.max(0.05, (max.z - min.z) / 2),
  };
  // convex 顶点：首个网格的顶点属性均匀采样（≤64 点），经子变换到对象局部空间
  const points: number[] = [];
  const pos = meshPoints[0];
  if (pos) {
    const count = pos.count;
    const step = Math.max(1, Math.floor(count / 64));
    const v = new THREE.Vector3();
    for (let i = 0; i < count && points.length < 64 * 3; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(sampleMat);
      points.push(v.x, v.y, v.z);
    }
  }
  return { center, half, points };
}

/** 由碰撞体设置 + 对象包围盒生成碰撞形状描述（世界单位；世界缩放烘进形状） */
export function computeColliderShapeDesc(
  settings: ColliderSettings,
  obj: THREE.Object3D,
): ColliderShapeDesc {
  const s = settings;
  let half = { x: 0.5, y: 0.5, z: 0.5 };
  let center = { x: 0, y: 0, z: 0 };
  let points: number[] = [];
  if (s.autoSize) {
    const bounds = computeColliderLocalBounds(obj);
    if (bounds) {
      half = bounds.half;
      center = bounds.center;
      points = bounds.points;
    }
  } else {
    // 显式尺寸（全尺寸 → 半尺寸；sphere 直径取 x；capsule/cylinder 直径取 x、柱段高取 y）
    half = {
      x: Math.max(0.05, s.size.x / 2),
      y: Math.max(0.05, s.size.y / 2),
      z: Math.max(0.05, s.size.z / 2),
    };
    // convex 需要网格顶点采样（非 autoSize 时也采样，仅用于凸包形状）
    if (s.shape === "convex") {
      const bounds = computeColliderLocalBounds(obj);
      if (bounds) points = bounds.points;
    }
  }
  // 对象世界缩放烘进形状（物理体不支持缩放变换）
  const scale = obj.getWorldScale(new THREE.Vector3());
  const sx = Math.abs(scale.x) || 1;
  const sy = Math.abs(scale.y) || 1;
  const sz = Math.abs(scale.z) || 1;
  const uniform = (sx + sy + sz) / 3;
  const desc: ColliderShapeDesc = {
    shape: s.shape,
    halfExtents: { x: Math.max(0.001, half.x * sx), y: Math.max(0.001, half.y * sy), z: Math.max(0.001, half.z * sz) },
    radius: Math.max(0.001, Math.max(half.x * sx, half.z * sz, s.shape === "sphere" ? half.y * sy : 0.001)),
    halfHeight: 0.5,
    points: [],
    offset: {
      x: s.offset.x + (s.autoSize ? center.x : 0),
      y: s.offset.y + (s.autoSize ? center.y : 0),
      z: s.offset.z + (s.autoSize ? center.z : 0),
    },
    friction: s.friction,
    restitution: s.restitution,
    isSensor: s.isSensor,
  };
  switch (s.shape) {
    case "sphere":
      desc.radius = Math.max(0.001, uniform * Math.max(half.x, half.y, half.z));
      break;
    case "capsule": {
      desc.radius = Math.max(0.001, Math.max(half.x * sx, half.z * sz));
      desc.halfHeight = Math.max(0.001, half.y * sy);
      break;
    }
    case "cylinder": {
      desc.radius = Math.max(0.001, Math.max(half.x * sx, half.z * sz));
      desc.halfHeight = Math.max(0.001, half.y * sy);
      break;
    }
    case "convex": {
      // 顶点采样已按对象局部空间收集：乘世界缩放后传入
      if (points.length) {
        const scaled: number[] = new Array(points.length);
        for (let i = 0; i + 2 < points.length; i += 3) {
          scaled[i] = points[i] * sx;
          scaled[i + 1] = points[i + 1] * sy;
          scaled[i + 2] = points[i + 2] * sz;
        }
        desc.points = scaled;
      }
      break;
    }
    case "box":
    default:
      break;
  }
  return desc;
}
