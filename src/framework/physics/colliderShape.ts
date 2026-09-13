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
import { snapHeightfieldResolution, type ColliderSettings } from "./types";

/** autoSize 时对象局部空间包围盒 + convex 顶点采样结果 */
export interface ColliderLocalBounds {
  center: Vec3;
  half: Vec3;
  points: number[];
}

/** heightfield 兜底告警去重（非地形节点选高度场形状只报一次） */
let heightfieldFallbackWarned = false;

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

/**
 * 对象子树中地形网格的内容签名（SceneSynchronizer.refreshTerrain 写入 userData）。
 * 高度场碰撞的重建签名必须含它：地形参数变化只重建网格不改节点缩放，
 * 缺它则 sig 不变、碰撞体陈旧。非地形对象返回空串。
 */
export function terrainMeshSigOf(obj: THREE.Object3D): string {
  let sig = "";
  obj.traverse((child) => {
    if (sig) return;
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const s = (mesh.userData as { terrainSig?: unknown }).terrainSig;
    if (typeof s === "string") sig = s;
  });
  return sig;
}

/** 对象子树中首个携带地形高度缓存的网格（SceneSynchronizer.refreshTerrain 写入 userData） */
function findTerrainHeights(
  obj: THREE.Object3D,
): { heights: Float32Array; gridN: number; size: number } | null {
  let hit: { heights: Float32Array; gridN: number; size: number } | null = null;
  obj.traverse((child) => {
    if (hit) return;
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const ud = mesh.userData as {
      terrainHeights?: unknown;
      terrainGridSize?: unknown;
      terrainSize?: unknown;
    };
    if (
      ud.terrainHeights instanceof Float32Array &&
      typeof ud.terrainGridSize === "number" &&
      ud.terrainGridSize >= 2 &&
      typeof ud.terrainSize === "number" &&
      ud.terrainSize > 0
    ) {
      hit = { heights: ud.terrainHeights, gridN: ud.terrainGridSize, size: ud.terrainSize };
    }
  });
  return hit;
}

/**
 * 高度网格下采样（碰撞 LOD）：最近邻取点 —— 输出每个采样都是源网格的真实烘焙
 * 高度（不做插值/平滑），碰撞面在这些点上与视觉网格严格一致。
 * src 行主序 [iz*srcN + ix]（x 随列、z 随行），输出同 orientation。
 */
export function downsampleHeightfield(
  src: Float32Array,
  srcN: number,
  samples: number,
  scaleY: number,
): Float32Array {
  const out = new Float32Array(samples * samples);
  const last = srcN - 1;
  for (let iz = 0; iz < samples; iz++) {
    const sz = Math.round((iz * last) / (samples - 1));
    for (let ix = 0; ix < samples; ix++) {
      const sx = Math.round((ix * last) / (samples - 1));
      out[iz * samples + ix] = src[sz * srcN + sx] * scaleY;
    }
  }
  return out;
}

/** 由碰撞体设置 + 对象包围盒生成碰撞形状描述（世界单位；世界缩放烘进形状） */
export function computeColliderShapeDesc(
  settings: ColliderSettings,
  obj: THREE.Object3D,
): ColliderShapeDesc {
  const s = settings;
  // 高度场：数据来自地形网格缓存（非包围盒路径），跳过 bounds 采样省一遍遍历
  if (s.shape !== "heightfield") {
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
      heights: null,
      samples: 0,
      terrainSizeX: 0,
      terrainSizeZ: 0,
      minHeight: 0,
      maxHeight: 0,
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

  // —— heightfield：从地形网格缓存下采样 ——
  const scale = obj.getWorldScale(new THREE.Vector3());
  const sx = Math.abs(scale.x) || 1;
  const sy = Math.abs(scale.y) || 1;
  const sz = Math.abs(scale.z) || 1;
  const desc: ColliderShapeDesc = {
    shape: "heightfield",
    halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
    radius: 0.5,
    halfHeight: 0.5,
    points: [],
    heights: null,
    samples: 0,
    terrainSizeX: 0,
    terrainSizeZ: 0,
    minHeight: 0,
    maxHeight: 0,
    // 网格本身以节点原点为中心铺开，autoSize 语义下中心即原点；offset 仍显式生效
    offset: { x: s.offset.x, y: s.offset.y, z: s.offset.z },
    friction: s.friction,
    restitution: s.restitution,
    isSensor: s.isSensor,
  };
  const terrain = findTerrainHeights(obj);
  if (!terrain) {
    // 非地形节点（或地形尚未烘焙）选了高度场形状：回退单位盒，可见地告警一次
    if (!heightfieldFallbackWarned) {
      heightfieldFallbackWarned = true;
      console.warn("[physics] heightfield 碰撞体找不到地形高度数据（仅 terrainNode 可用），已回退单位盒");
    }
    return desc;
  }
  const samples = snapHeightfieldResolution(s.resolution);
  const heights = downsampleHeightfield(terrain.heights, terrain.gridN, samples, sy);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (h < min) min = h;
    if (h > max) max = h;
  }
  desc.heights = heights;
  desc.samples = samples;
  desc.terrainSizeX = Math.max(0.001, terrain.size * sx);
  desc.terrainSizeZ = Math.max(0.001, terrain.size * sz);
  desc.minHeight = min;
  desc.maxHeight = max;
  return desc;
}
