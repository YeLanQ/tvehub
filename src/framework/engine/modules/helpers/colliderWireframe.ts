// ---------------------------------------------------------------------------
// 碰撞体线框几何构建（编辑器辅助显示）。
//
// 输入是与物理建体完全一致的 ColliderShapeDesc（世界单位，见 physics/colliderShape.ts），
// 输出供 LineSegments 使用的线段几何（position 为成对端点）。几何以形状原点为中心，
// desc.offset 由 ColliderNodeHelper 挂到子对象位置上，保证与物理体偏移一致。
//
// 各形状画法（干净结构线，不画三角剖分对角线）：
// - box     → 12 条棱
// - sphere  → 3 条纬线（赤道 ±45°）+ 4 条经线大圆
// - capsule → 上下柱面交接圆 + 半球 45° 纬线 + 柱面竖直轮廓线 + 半球经线弧
// - cylinder→ 上下底圆 + 8 条竖直轮廓线
// - convex  → 采样点凸包的棱（ConvexGeometry + EdgesGeometry；退化时点集包围盒兜底）
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import type { ColliderShapeDesc } from "../../../physics/backend/types";

const CIRCLE_SEGMENTS = 24;

/** 由碰撞形状描述生成线框几何（以形状局部原点为中心） */
export function buildColliderWireframe(desc: ColliderShapeDesc): THREE.BufferGeometry {
  switch (desc.shape) {
    case "sphere":
      return buildSphereWireframe(desc.radius);
    case "capsule":
      return buildCapsuleWireframe(desc.radius, desc.halfHeight);
    case "cylinder":
      return buildCylinderWireframe(desc.radius, desc.halfHeight);
    case "convex":
      return buildConvexWireframe(desc.points, desc.halfExtents);
    case "box":
    default:
      return buildBoxWireframe(desc.halfExtents);
  }
}

/** box：8 顶点 12 棱 */
function buildBoxWireframe(h: ColliderShapeDesc["halfExtents"]): THREE.BufferGeometry {
  const c = [
    [-h.x, -h.y, -h.z], [h.x, -h.y, -h.z], [h.x, h.y, -h.z], [-h.x, h.y, -h.z],
    [-h.x, -h.y, h.z], [h.x, -h.y, h.z], [h.x, h.y, h.z], [-h.x, h.y, h.z],
  ];
  const edges = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const pos: number[] = [];
  for (const [a, b] of edges) pos.push(...c[a], ...c[b]);
  return segmentsGeometry(pos);
}

/** sphere：纬线（XZ 圆环）+ 经线大圆（过两极、绕 Y 轴均布） */
function buildSphereWireframe(r: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const lat = Math.SQRT1_2; // ±45° 纬度：sin45 = cos45
  pushCircleXZ(pos, r * lat, r * lat);
  pushCircleXZ(pos, -r * lat, r * lat);
  pushCircleXZ(pos, 0, r);
  for (let i = 0; i < 4; i++) pushMeridianCircle(pos, (i / 4) * Math.PI * 2, r);
  return segmentsGeometry(pos);
}

/** capsule：柱段半高 halfHeight + 半球半径 radius */
function buildCapsuleWireframe(r: number, halfHeight: number): THREE.BufferGeometry {
  const pos: number[] = [];
  // 柱面与半球交接圆
  pushCircleXZ(pos, halfHeight, r);
  pushCircleXZ(pos, -halfHeight, r);
  // 半球 45° 纬线
  pushCircleXZ(pos, halfHeight + r * Math.SQRT1_2, r * Math.SQRT1_2);
  pushCircleXZ(pos, -(halfHeight + r * Math.SQRT1_2), r * Math.SQRT1_2);
  // 柱面竖直轮廓线（仅柱段）
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    pos.push(x, -halfHeight, z, x, halfHeight, z);
  }
  // 半球经线弧（4 条，勾勒球盖弧形而非圆锥）
  for (let i = 0; i < 4; i++) {
    const azimuth = (i / 4) * Math.PI * 2;
    pushHemisphereMeridian(pos, azimuth, r, halfHeight, 1);
    pushHemisphereMeridian(pos, azimuth, r, -halfHeight, -1);
  }
  return segmentsGeometry(pos);
}

/** cylinder：上下底圆 + 竖直轮廓线 */
function buildCylinderWireframe(r: number, halfHeight: number): THREE.BufferGeometry {
  const pos: number[] = [];
  pushCircleXZ(pos, halfHeight, r);
  pushCircleXZ(pos, -halfHeight, r);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    pos.push(x, -halfHeight, z, x, halfHeight, z);
  }
  return segmentsGeometry(pos);
}

/** convex：采样点凸包的棱；采样点不足或凸包退化时回退点集包围盒 */
function buildConvexWireframe(
  points: number[],
  fallbackHalf: ColliderShapeDesc["halfExtents"],
): THREE.BufferGeometry {
  if (points.length >= 12) {
    const verts: THREE.Vector3[] = [];
    for (let i = 0; i + 2 < points.length; i += 3) {
      verts.push(new THREE.Vector3(points[i], points[i + 1], points[i + 2]));
    }
    try {
      const hull = new ConvexGeometry(verts);
      const edges = new THREE.EdgesGeometry(hull, 1);
      hull.dispose();
      return edges;
    } catch {
      // 共面/共线等退化点集 → 包围盒兜底
    }
  }
  if (points.length >= 3) {
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i + 2 < points.length; i += 3) {
      min.min(new THREE.Vector3(points[i], points[i + 1], points[i + 2]));
      max.max(new THREE.Vector3(points[i], points[i + 1], points[i + 2]));
    }
    return buildBoundsWireframe(min, max);
  }
  // 完全没有采样点（无网格/空对象）：按半尺寸单位盒兜底
  return buildBoxWireframe(fallbackHalf);
}

/** 包围盒线框（min/max 角点，中心可为任意点） */
function buildBoundsWireframe(min: THREE.Vector3, max: THREE.Vector3): THREE.BufferGeometry {
  const c = [
    [min.x, min.y, min.z], [max.x, min.y, min.z], [max.x, max.y, min.z], [min.x, max.y, min.z],
    [min.x, min.y, max.z], [max.x, min.y, max.z], [max.x, max.y, max.z], [min.x, max.y, max.z],
  ];
  const edges = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const pos: number[] = [];
  for (const [a, b] of edges) pos.push(...c[a], ...c[b]);
  return segmentsGeometry(pos);
}

/** XZ 平面圆环（纬线），中心在 Y 轴上高度 cy 处 */
function pushCircleXZ(pos: number[], cy: number, r: number): void {
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    const b = ((i + 1) / CIRCLE_SEGMENTS) * Math.PI * 2;
    pos.push(Math.cos(a) * r, cy, Math.sin(a) * r, Math.cos(b) * r, cy, Math.sin(b) * r);
  }
}

/** 过两极的经线大圆：由方位角 azimuth 确定圆所在平面（含 Y 轴） */
function pushMeridianCircle(pos: number[], azimuth: number, r: number): void {
  const dx = Math.cos(azimuth);
  const dz = Math.sin(azimuth);
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    const b = ((i + 1) / CIRCLE_SEGMENTS) * Math.PI * 2;
    pos.push(
      Math.cos(a) * dx * r, Math.sin(a) * r, Math.cos(a) * dz * r,
      Math.cos(b) * dx * r, Math.sin(b) * r, Math.cos(b) * dz * r,
    );
  }
}

/** 半球经线弧：从赤道（交接圆）到极点，弧形勾勒球盖；baseY=基准高度，dir=+1上/-1下 */
function pushHemisphereMeridian(pos: number[], azimuth: number, r: number, baseY: number, dir: number): void {
  const dx = Math.cos(azimuth);
  const dz = Math.sin(azimuth);
  const half = CIRCLE_SEGMENTS / 2;
  for (let i = 0; i < half; i++) {
    const a = (i / half) * Math.PI * 0.5;
    const b = ((i + 1) / half) * Math.PI * 0.5;
    const ra = Math.cos(a) * r;
    const rb = Math.cos(b) * r;
    pos.push(
      ra * dx, baseY + Math.sin(a) * r * dir, ra * dz,
      rb * dx, baseY + Math.sin(b) * r * dir, rb * dz,
    );
  }
}

/** 成对端点数组 → LineSegments 几何 */function segmentsGeometry(pos: number[]): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  geom.computeBoundingSphere();
  return geom;
}
