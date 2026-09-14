// ---------------------------------------------------------------------------
// 导航烘焙（framework 层）：可行走网格 + SDF 有符号距离场。
//
// 烘焙输入是"高度采样函数 + 静态障碍 AABB 列表"（由编辑器 NavSystem 从场景
// 收集：地形高度场 + 静态碰撞体投影），输出是一张规则网格：
// - heights：每格地形高度（世界系 Y，供代理贴地与路径高程）；
// - walkable：地形坡度/高差 + 障碍 + 代理半径净空综合判定；
// - sdf：有符号距离场（世界单位；正 = 到最近障碍物的距离，负 = 障碍内部）。
//
// 性能设计：SDF 在烘焙期用 Felzenszwalb O(n) 欧氏距离变换一次算好，运行期
// 碰撞/净空查询全部退化为双线性查表 O(1)——把"实时几何求交"换成"烘焙期
// 预计算 + 实时查表"。可视化（可行走叠加/SDF 热力图）同样只消费烘焙产物。
// ---------------------------------------------------------------------------

import type { NavAreaSettings } from "./types";

/** 地形高度场输入（与 SceneSynchronizer 写入 userData 的 terrainHeights 约定一致） */
export interface NavHeightField {
  /** 高度网格（行主序 N×N，网格覆盖 [origin±size/2]，中心为地形节点原点） */
  heights: Float32Array;
  /** 网格边长（N = segments+1） */
  gridN: number;
  /** 地表边长（世界单位） */
  size: number;
  /** 地形节点原点世界坐标（XZ；高度为绝对世界系 Y） */
  originX: number;
  originZ: number;
  /** 地形节点世界 Y（高度数组存的是相对地表的高度，绝对 Y = relY + originY） */
  originY: number;
}

/** 静态障碍（世界系 XZ 投影 AABB；Y 范围用于低矮/高架障碍的粗过滤） */
export interface NavObstacle {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** 障碍底部世界 Y（底部高于格高的高架障碍不阻挡地面） */
  minY: number;
  /** 障碍顶部世界 Y */
  maxY: number;
}

/** 一次导航烘焙结果（只读数据；缓存于导航区域节点对象的 userData） */
export interface NavBakeResult {
  /** 网格尺寸（列 w × 行 h） */
  w: number;
  h: number;
  /** 一格边长（世界单位） */
  cellSize: number;
  /** 网格 (0,0) 格中心的世界 XZ 坐标 */
  originX: number;
  originZ: number;
  /** 覆盖范围（世界系 AABB；由输入 bounds 原样记录） */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** 每格高度（绝对世界 Y；行主序） */
  heights: Float32Array;
  /** 可行走判定（已含障碍与代理半径净空） */
  walkable: Uint8Array;
  /** 有符号距离场（世界单位；正 = 到最近障碍距离，负 = 障碍内部深度） */
  sdf: Float32Array;
  /** 统计（检查器展示） */
  stats: {
    cells: number;
    walkableCells: number;
    blockedCells: number;
    bakeMs: number;
    /** 覆盖区域中可达格子占比（连通分量内不计，仅面积占比） */
    walkableRatio: number;
  };
}

/** 无障碍区域的距离上限（世界单位；SDF 无遮挡格钳到该值，足够表达"很远"） */
export const NAV_SDF_FAR = 1e4;

/** 代理移动/寻路时的默认抬升（路径点与代理贴地高度上加的视觉余量） */
export const NAV_SURFACE_LIFT = 0.1;

/** 烘焙输入 */
export interface NavBakeInput {
  /** 覆盖范围（世界系 XZ AABB，通常取所采样地形的范围） */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** 高度采样：返回 null = 采样点在地形之外（不可行走） */
  heightAt: (x: number, z: number) => number | null;
  /** 静态障碍列表（世界系） */
  obstacles: NavObstacle[];
  settings: NavAreaSettings;
}

/** 格坐标 → 格中心世界坐标 */
export function cellToWorldX(b: NavBakeResult, i: number): number {
  return b.originX + i * b.cellSize;
}

export function cellToWorldZ(b: NavBakeResult, j: number): number {
  return b.originZ + j * b.cellSize;
}

/** 世界坐标 → 格索引（返回浮点；越界为负/超界值，调用方自行钳制） */
export function worldToCellX(b: NavBakeResult, x: number): number {
  return (x - b.originX) / b.cellSize;
}

export function worldToCellZ(b: NavBakeResult, z: number): number {
  return (z - b.originZ) / b.cellSize;
}

/** 网格内双线性采样高度（世界 XZ → 绝对 Y；越界钳边） */
export function sampleNavHeight(b: NavBakeResult, x: number, z: number): number {
  const fx = Math.min(b.w - 1, Math.max(0, worldToCellX(b, x)));
  const fz = Math.min(b.h - 1, Math.max(0, worldToCellZ(b, z)));
  const ix = Math.min(b.w - 2, Math.floor(fx));
  const iz = Math.min(b.h - 2, Math.floor(fz));
  const tx = fx - ix;
  const tz = fz - iz;
  const h = b.heights;
  const row = b.w;
  const h00 = h[iz * row + ix];
  const h10 = h[iz * row + ix + 1];
  const h01 = h[(iz + 1) * row + ix];
  const h11 = h[(iz + 1) * row + ix + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

/** 双线性采样 SDF（世界 XZ → 世界单位距离；越界按"远离障碍"处理 = 取边界值） */
export function sampleNavSdf(b: NavBakeResult, x: number, z: number): number {
  const fx = Math.min(b.w - 1, Math.max(0, worldToCellX(b, x)));
  const fz = Math.min(b.h - 1, Math.max(0, worldToCellZ(b, z)));
  const ix = Math.min(b.w - 2, Math.floor(fx));
  const iz = Math.min(b.h - 2, Math.floor(fz));
  const tx = fx - ix;
  const tz = fz - iz;
  const s = b.sdf;
  const row = b.w;
  const s00 = s[iz * row + ix];
  const s10 = s[iz * row + ix + 1];
  const s01 = s[(iz + 1) * row + ix];
  const s11 = s[(iz + 1) * row + ix + 1];
  return (s00 * (1 - tx) + s10 * tx) * (1 - tz) + (s01 * (1 - tx) + s11 * tx) * tz;
}

/** SDF 梯度（世界系 XZ；有限差分，供碰撞滑移沿 ∇SDF 推出障碍） */
export function sampleNavSdfGradient(
  b: NavBakeResult,
  x: number,
  z: number,
  out: { x: number; z: number },
): void {
  const e = b.cellSize * 0.5;
  out.x = sampleNavSdf(b, x + e, z) - sampleNavSdf(b, x - e, z);
  out.z = sampleNavSdf(b, x, z + e) - sampleNavSdf(b, x, z - e);
}

// ---------------------------------------------------------------------------
// Felzenszwalb & Huttenlocher 一维精确欧氏距离变换（平方距离）。
// "无目标"位用有限大值 EDT_INF 表示：Float64 精度下包络算法仍然正确
//（INF 抛物线永远不会成为有限源的最近解），全 INF 行/列结果 ≥ EDT_INF，
// 调用方按"远超上限"处理。两趟（行/列）即得 2D 精确 EDT，复杂度 O(w*h)。
// ---------------------------------------------------------------------------

const EDT_INF = 1e12;

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -EDT_INF;
  z[1] = EDT_INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k] && k > 0) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = EDT_INF;
  }
  let k2 = 0;
  for (let q = 0; q < n; q++) {
    while (z[k2 + 1] < q) k2++;
    d[q] = (q - v[k2]) * (q - v[k2]) + f[v[k2]];
  }
}

/** 布尔场 → 到最近 true 格的欧氏距离（格单位）；无 true 时全部返回 EDT_INF */
function distanceTransform(blocked: Uint8Array, w: number, h: number): Float64Array {
  const INF_SQ = new Float64Array(w * h).fill(EDT_INF);
  const d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const f = new Float64Array(Math.max(w, h));
  // 列方向（先按行扫描列下标）：f[q] = blocked[q][col] ? 0 : INF
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) f[j] = blocked[j * w + i] ? 0 : EDT_INF;
    edt1d(f, h, d, v, z);
    for (let j = 0; j < h; j++) INF_SQ[j * w + i] = d[j];
  }
  // 行方向
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) f[i] = INF_SQ[j * w + i];
    edt1d(f, w, d, v, z);
    for (let i = 0; i < w; i++) INF_SQ[j * w + i] = d[i];
  }
  return INF_SQ;
}

/**
 * 烘焙导航区域（同步 CPU 计算；1 格 = cellSize 米，200×200 区域 @1m ≈ 4 万格，
 * EDT + 坡度判定合计毫秒级）。结果可直接缓存/渲染，运行期查询全部查表。
 */
export function bakeNavArea(input: NavBakeInput): NavBakeResult {
  const t0 = nowMs();
  const { bounds, settings } = input;
  const cs = settings.cellSize;
  const w = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cs));
  const h = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cs));
  const originX = bounds.minX + cs / 2;
  const originZ = bounds.minZ + cs / 2;

  const heights = new Float32Array(w * h);
  const walkable = new Uint8Array(w * h);
  const blocked = new Uint8Array(w * h);
  const maxSlopeTan = Math.tan((settings.maxSlope * Math.PI) / 180);
  const half = cs * 0.5;

  // ① 地形采样：坡度（中心差分）+ 高差 + 区域内判定
  for (let j = 0; j < h; j++) {
    const wz = originZ + j * cs;
    for (let i = 0; i < w; i++) {
      const wx = originX + i * cs;
      const idx = j * w + i;
      const hy = input.heightAt(wx, wz);
      if (hy === null) {
        heights[idx] = 0;
        blocked[idx] = 1;
        continue;
      }
      heights[idx] = hy;
      const hx1 = input.heightAt(wx - half, wz);
      const hx2 = input.heightAt(wx + half, wz);
      const hz1 = input.heightAt(wx, wz - half);
      const hz2 = input.heightAt(wx, wz + half);
      const dx = hx1 !== null && hx2 !== null ? (hx2 - hx1) / (2 * half) : 0;
      const dz = hz1 !== null && hz2 !== null ? (hz2 - hz1) / (2 * half) : 0;
      const slope = Math.hypot(dx, dz);
      if (slope > maxSlopeTan) {
        blocked[idx] = 1;
        continue;
      }
      // 相邻四格高差超限（陡坎）同样不可行走
      if (
        stepBlocked(input.heightAt, wx + cs, wz, hy, settings) ||
        stepBlocked(input.heightAt, wx - cs, wz, hy, settings) ||
        stepBlocked(input.heightAt, wx, wz + cs, hy, settings) ||
        stepBlocked(input.heightAt, wx, wz - cs, hy, settings)
      ) {
        blocked[idx] = 1;
      }
    }
  }

  // ② 障碍投影：XZ AABB 覆盖格标记为障碍（含格心在盒内的格子）
  for (const ob of input.obstacles) {
    const i0 = Math.max(0, Math.floor((ob.minX - originX) / cs));
    const i1 = Math.min(w - 1, Math.ceil((ob.maxX - originX) / cs));
    const j0 = Math.max(0, Math.floor((ob.minZ - originZ) / cs));
    const j1 = Math.min(h - 1, Math.ceil((ob.maxZ - originZ) / cs));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const wx = originX + i * cs;
        const wz = originZ + j * cs;
        if (wx < ob.minX || wx > ob.maxX || wz < ob.minZ || wz > ob.maxZ) continue;
        // 高架障碍（底部高于本格地形 1m 以上）不阻挡地面行走
        const groundY = heights[j * w + i];
        if (ob.minY > groundY + 1) continue;
        blocked[j * w + i] = 1;
      }
    }
  }

  // ③ SDF：到障碍的精确欧氏距离（EDT），障碍内部取负号（到最近可行走格的深度）
  const distToBlockedSq = distanceTransform(blocked, w, h);
  const free: Uint8Array = new Uint8Array(w * h);
  for (let k = 0; k < free.length; k++) free[k] = blocked[k] ? 0 : 1;
  const distToFreeSq = distanceTransform(free, w, h);
  const sdf = new Float32Array(w * h);
  for (let k = 0; k < sdf.length; k++) {
    const inBlocked = blocked[k] === 1;
    const dOut = Math.sqrt(distToBlockedSq[k]) * cs;
    const dIn = Math.sqrt(distToFreeSq[k]) * cs;
    sdf[k] = inBlocked ? -Math.min(dIn, NAV_SDF_FAR) : Math.min(dOut, NAV_SDF_FAR);
  }

  // ④ 最终可行走：地形可行 ∧ 到障碍距离满足代理半径净空
  let walkableCells = 0;
  for (let k = 0; k < walkable.length; k++) {
    const ok = blocked[k] === 0 && sdf[k] >= settings.agentRadius;
    walkable[k] = ok ? 1 : 0;
    if (ok) walkableCells++;
  }

  return {
    w,
    h,
    cellSize: cs,
    originX,
    originZ,
    bounds: { ...bounds },
    heights,
    walkable,
    sdf,
    stats: {
      cells: w * h,
      walkableCells,
      blockedCells: w * h - walkableCells,
      bakeMs: nowMs() - t0,
      walkableRatio: walkableCells / Math.max(1, w * h),
    },
  };
}

/** 相邻格高差超限判定（越界采样视为无限制） */
function stepBlocked(
  heightAt: (x: number, z: number) => number | null,
  wx: number,
  wz: number,
  hy: number,
  settings: NavAreaSettings,
): boolean {
  const n = heightAt(wx, wz);
  if (n === null) return true;
  return Math.abs(n - hy) > settings.maxHeightStep;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
