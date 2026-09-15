// ---------------------------------------------------------------------------
// 网格高度场光栅化（framework 层）：把任意网格三角形自上而下光栅化为规则高度
// 网格，输出与 NavHeightField 同构（heights 为绝对世界 Y；NaN = 该处无表面）。
//
// 用途：导航区域的采样源不限于地形——任意 MeshNode（基元/模型）都可作为可行走
// 面。语义为 2.5D：每格取最高表面（多面重叠时顶层优先，不支持悬挑下层行走）。
//
// 性能设计：一遍前向光栅化（逐三角形填充其 XZ 投影覆盖的网格点，O(三角形数 ×
// 平均覆盖格数)），比逐格 Raycast（每格 ~9 次射线 × 全部三角形）快几个量级，
// 无需 BVH。细于网格间距的三角形可能漏采（间隙格判为不可行走），网格间距由
// 调用方按 cellSize 取半，精度足以覆盖常规平台/坡道场景。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { sampleHeightField, type NavHeightField } from "./bake";

/** 光栅化网格边长上限（内存与烘焙耗时护栏；超过时间距自动放大） */
export const NAV_MESH_FIELD_MAX_GRID = 1024;

/** 光栅化网格边长下限（保证至少 2×2 采样点） */
const MIN_GRID_N = 2;

/** XZ 平面矩形范围（世界系） */
export interface MeshFieldBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** 光栅化产物（与 NavHeightField 同构：originY 恒 0，heights 为绝对世界 Y） */
export interface RasterizedHeightField {
  heights: Float32Array;
  gridN: number;
  size: number;
  originX: number;
  originZ: number;
}

/** 网格点采样时的重心坐标包含容差（共享边/对角线上的点允许微小负值） */
const BARY_EPS = -1e-6;

/** 投影面积退化阈值（近垂直面/墙：XZ 投影近零面积，不是可行走面） */
const MIN_PROJECTED_AREA2 = 1e-9;

/**
 * 自上而下光栅化对象列表中的网格三角形为高度场（同格更高者胜）。
 *
 * - bounds 取并集后扩展为正方形网格（NavHeightField 为方格约定），网格点间距
 *   ≈ spacing（超过 NAV_MESH_FIELD_MAX_GRID 时自动放大）；
 * - 三角形变换到世界系后按 XZ 投影重心插值 Y，写入覆盖的网格点（取 max）；
 * - 不可见网格、蒙皮网格（姿态相关）与无 position 属性的网格跳过；
 * - heights 初始为 NaN：未被任何三角形覆盖的网格点 = 无表面（采样返回 null）。
 */
export function rasterizeMeshesToHeightField(
  objects: THREE.Object3D[],
  bounds: MeshFieldBounds,
  spacing: number,
): RasterizedHeightField | null {
  const side = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  if (!(side > 0) || !(spacing > 0)) return null;
  const gridN = Math.max(MIN_GRID_N, Math.min(NAV_MESH_FIELD_MAX_GRID, Math.ceil(side / spacing) + 1));
  const size = side;
  const originX = (bounds.minX + bounds.maxX) / 2;
  const originZ = (bounds.minZ + bounds.maxZ) / 2;
  const left = originX - size / 2;
  const top = originZ - size / 2;
  const step = size / (gridN - 1);
  const heights = new Float32Array(gridN * gridN).fill(NaN);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  for (const root of objects) {
    root.updateMatrixWorld(true);
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || mesh.visible === false) return;
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
      const geom = mesh.geometry as THREE.BufferGeometry | undefined;
      const pos = geom?.attributes?.position;
      if (!geom || !pos) return;
      const index = geom.index;
      const triCount = index ? index.count / 3 : pos.count / 3;
      const m = mesh.matrixWorld;
      for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(m);
        b.fromBufferAttribute(pos, i1).applyMatrix4(m);
        c.fromBufferAttribute(pos, i2).applyMatrix4(m);
        rasterizeTriangle(heights, gridN, step, left, top, a, b, c);
      }
    });
  }
  return { heights, gridN, size, originX, originZ };
}

/** 单三角形：XZ 投影覆盖的网格点做重心插值写 Y（更高者胜；近垂直面跳过） */
function rasterizeTriangle(
  heights: Float32Array,
  gridN: number,
  step: number,
  left: number,
  top: number,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
): void {
  const area2 = (c.x - a.x) * (b.z - a.z) - (b.x - a.x) * (c.z - a.z);
  if (Math.abs(area2) < MIN_PROJECTED_AREA2) return;
  const minX = Math.min(a.x, b.x, c.x);
  const maxX = Math.max(a.x, b.x, c.x);
  const minZ = Math.min(a.z, b.z, c.z);
  const maxZ = Math.max(a.z, b.z, c.z);
  const i0 = Math.max(0, Math.ceil((minX - left) / step));
  const i1 = Math.min(gridN - 1, Math.floor((maxX - left) / step));
  const j0 = Math.max(0, Math.ceil((minZ - top) / step));
  const j1 = Math.min(gridN - 1, Math.floor((maxZ - top) / step));
  if (i1 < i0 || j1 < j0) return;
  for (let j = j0; j <= j1; j++) {
    const pz = top + j * step;
    const row = j * gridN;
    for (let i = i0; i <= i1; i++) {
      const px = left + i * step;
      // 重心坐标（XZ 平面，area2 = (bz-az)(cx-ax)-(bx-ax)(cz-az)）：
      // u/v/w 分别为 b/c/a 的权重，点在三角形内 ⇔ 三权重均 ≥ 0（含容差）
      const u = ((pz - a.z) * (c.x - a.x) - (px - a.x) * (c.z - a.z)) / area2;
      if (u < BARY_EPS) continue;
      const v = ((px - a.x) * (b.z - a.z) - (pz - a.z) * (b.x - a.x)) / area2;
      if (v < BARY_EPS) continue;
      const w = 1 - u - v;
      if (w < BARY_EPS) continue;
      const y = w * a.y + u * b.y + v * c.y;
      const idx = row + i;
      const cur = heights[idx];
      if (Number.isNaN(cur) || y > cur) heights[idx] = y;
    }
  }
}

/**
 * 合并地形高度场到光栅化产物网格（2.5D 语义：每格取所有源的最高面）。
 * 就地写入 merged.heights：无任何源覆盖的格保持 NaN（采样返回 null = 不可行走）。
 */
export function mergeHeightFields(
  merged: RasterizedHeightField,
  terrainFields: NavHeightField[],
): Float32Array {
  const { heights, gridN, size, originX, originZ } = merged;
  if (terrainFields.length === 0) return heights;
  const half = size / 2;
  for (let j = 0; j < gridN; j++) {
    const z = originZ - half + (j * size) / (gridN - 1);
    for (let i = 0; i < gridN; i++) {
      const x = originX - half + (i * size) / (gridN - 1);
      let top = NaN;
      for (const tf of terrainFields) {
        const y = sampleHeightField(tf, x, z);
        if (y !== null && (Number.isNaN(top) || y > top)) top = y;
      }
      const idx = j * gridN + i;
      const cur = heights[idx];
      if (Number.isNaN(cur)) {
        if (!Number.isNaN(top)) heights[idx] = top;
      } else if (!Number.isNaN(top) && top > cur) {
        heights[idx] = top;
      }
    }
  }
  return heights;
}
