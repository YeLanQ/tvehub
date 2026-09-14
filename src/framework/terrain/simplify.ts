// ---------------------------------------------------------------------------
// 自适应四叉树地形网格简化（纯数据，不依赖 THREE）。
//
// 输入 N×N 规则网格高度场，输出简化后的非均匀网格（顶点网格坐标 + 三角形索引）。
// 算法：
// 1. 基于双线性插值误差的自适应四叉树细分——平坦区域不细分（大 quad），陡峭区域细分到最细；
// 2. 平衡化——强制相邻叶节点深度差 ≤ 1，消除 T-junction 裂缝；
// 3. 缝补三角化——每条边检查邻居是否更细，若是则插入边中点，生成 4–8 个三角形/叶节点。
//
// segments（= n - 1）必须是 2 的幂且 ≥ 4，否则返回 null（调用方回退到均匀网格）。
// 采样函数（sampleTerrainHeight）仍用原始 N×N 高度场，不受简化影响。
// ---------------------------------------------------------------------------

interface Quad {
  x0: number; z0: number; x1: number; z1: number;
  children?: Quad[];
}

/** quad 内所有网格点到 4 角双线性插值的最大偏差 */
function quadMaxError(h: Float32Array, n: number, x0: number, x1: number, z0: number, z1: number): number {
  const h00 = h[z0 * n + x0];
  const h10 = h[z0 * n + x1];
  const h01 = h[z1 * n + x0];
  const h11 = h[z1 * n + x1];
  const dx = x1 - x0;
  const dz = z1 - z0;
  let maxErr = 0;
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const tx = (x - x0) / dx;
      const tz = (z - z0) / dz;
      const interp = h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
      const err = Math.abs(h[z * n + x] - interp);
      if (err > maxErr) maxErr = err;
    }
  }
  return maxErr;
}

function buildQuad(
  h: Float32Array, n: number,
  x0: number, x1: number, z0: number, z1: number,
  threshold: number, depth: number, maxDepth: number,
): Quad {
  const q: Quad = { x0, z0, x1, z1 };
  if (x1 - x0 <= 1 || z1 - z0 <= 1 || depth >= maxDepth) return q;
  if (quadMaxError(h, n, x0, x1, z0, z1) < threshold) return q;
  const mx = (x0 + x1) >> 1;
  const mz = (z0 + z1) >> 1;
  q.children = [
    buildQuad(h, n, x0, mx, z0, mz, threshold, depth + 1, maxDepth),
    buildQuad(h, n, mx, x1, z0, mz, threshold, depth + 1, maxDepth),
    buildQuad(h, n, x0, mx, mz, z1, threshold, depth + 1, maxDepth),
    buildQuad(h, n, mx, x1, mz, z1, threshold, depth + 1, maxDepth),
  ];
  return q;
}

function collectLeaves(q: Quad, leaves: Quad[]): void {
  if (!q.children) { leaves.push(q); return; }
  for (const c of q.children) collectLeaves(c, leaves);
}

function findLeaf(root: Quad, x: number, z: number): Quad | null {
  if (x < root.x0 || x > root.x1 || z < root.z0 || z > root.z1) return null;
  if (!root.children) return root;
  for (const c of root.children) {
    const r = findLeaf(c, x, z);
    if (r) return r;
  }
  return null;
}

/** 平衡化：相邻叶节点深度差 ≤ 1，消除 T-junction */
function balanceTree(root: Quad): void {
  let changed = true;
  while (changed) {
    changed = false;
    const leaves: Quad[] = [];
    collectLeaves(root, leaves);
    for (const l of leaves) {
      if (l.children) continue;
      const lSize = l.x1 - l.x0;
      const checks: Array<[number, number]> = [
        [l.x0, l.z0 - 1], [l.x1, l.z0 - 1],
        [l.x0, l.z1 + 1], [l.x1, l.z1 + 1],
        [l.x0 - 1, l.z0], [l.x0 - 1, l.z1],
        [l.x1 + 1, l.z0], [l.x1 + 1, l.z1],
      ];
      for (const [cx, cz] of checks) {
        const neighbor = findLeaf(root, cx, cz);
        if (neighbor && !neighbor.children && (neighbor.x1 - neighbor.x0) < lSize / 2) {
          const mx = (l.x0 + l.x1) >> 1;
          const mz = (l.z0 + l.z1) >> 1;
          l.children = [
            { x0: l.x0, x1: mx, z0: l.z0, z1: mz },
            { x0: mx, x1: l.x1, z0: l.z0, z1: mz },
            { x0: l.x0, x1: mx, z0: mz, z1: l.z1 },
            { x0: mx, x1: l.x1, z0: mz, z1: l.z1 },
          ];
          changed = true;
          break;
        }
      }
    }
  }
}

export interface SimplifiedMesh {
  /** 顶点网格坐标 [gridX0, gridZ0, gridX1, gridZ1, ...] */
  vertices: Int32Array;
  /** 三角形索引（引用 vertices 数组的索引，每 3 个一组） */
  indices: Uint32Array;
}

/**
 * 自适应四叉树地形网格简化。
 * @param heights  N×N 高度场（行主序）
 * @param n        gridSize = segments + 1
 * @param threshold 双线性插值误差阈值（< 此值的 quad 不细分）；建议 = (maxY - minY) * 0.05
 * @returns 简化网格，或 null（segments 不是 2 的幂或太小 → 调用方回退到均匀网格）
 */
export function simplifyTerrainMesh(
  heights: Float32Array,
  n: number,
  threshold: number,
): SimplifiedMesh | null {
  const segs = n - 1;
  if (segs < 4 || (segs & (segs - 1)) !== 0) return null;

  const maxDepth = Math.round(Math.log2(segs));
  const root = buildQuad(heights, n, 0, segs, 0, segs, threshold, 0, maxDepth);
  balanceTree(root);

  const leaves: Quad[] = [];
  collectLeaves(root, leaves);

  const vertMap = new Map<number, number>();
  const vertices: number[] = [];
  const indices: number[] = [];

  function getVert(x: number, z: number): number {
    const key = x * n + z;
    let idx = vertMap.get(key);
    if (idx === undefined) {
      idx = vertices.length / 2;
      vertices.push(x, z);
      vertMap.set(key, idx);
    }
    return idx;
  }

  for (const l of leaves) {
    const lSize = l.x1 - l.x0;
    const mx = (l.x0 + l.x1) >> 1;
    const mz = (l.z0 + l.z1) >> 1;

    const A = getVert(l.x0, l.z0);
    const B = getVert(l.x1, l.z0);
    const C = getVert(l.x1, l.z1);
    const D = getVert(l.x0, l.z1);
    const M = getVert(mx, mz);

    const topN = findLeaf(root, mx, l.z0 - 1);
    const rightN = findLeaf(root, l.x1 + 1, mz);
    const bottomN = findLeaf(root, mx, l.z1 + 1);
    const leftN = findLeaf(root, l.x0 - 1, mz);

    const topMid = topN && !topN.children && (topN.x1 - topN.x0) < lSize ? getVert(mx, l.z0) : -1;
    const rightMid = rightN && !rightN.children && (rightN.x1 - rightN.x0) < lSize ? getVert(l.x1, mz) : -1;
    const bottomMid = bottomN && !bottomN.children && (bottomN.x1 - bottomN.x0) < lSize ? getVert(mx, l.z1) : -1;
    const leftMid = leftN && !leftN.children && (leftN.x1 - leftN.x0) < lSize ? getVert(l.x0, mz) : -1;

    if (topMid >= 0) { indices.push(A, M, topMid, topMid, M, B); }
    else { indices.push(A, M, B); }
    if (rightMid >= 0) { indices.push(B, M, rightMid, rightMid, M, C); }
    else { indices.push(B, M, C); }
    if (bottomMid >= 0) { indices.push(C, M, bottomMid, bottomMid, M, D); }
    else { indices.push(C, M, D); }
    if (leftMid >= 0) { indices.push(D, M, leftMid, leftMid, M, A); }
    else { indices.push(D, M, A); }
  }

  return {
    vertices: Int32Array.from(vertices),
    indices: Uint32Array.from(indices),
  };
}