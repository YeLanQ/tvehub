// ---------------------------------------------------------------------------
// 导航寻路（framework 层）：A*（二叉堆 + 八方向 + 禁切角）+ 视线拉直平滑。
//
// 在烘焙网格（NavBakeResult）上搜索：代价 = 距离，启发 = 八方向距离（可采纳，
// 结果最优）；对角移动要求两个正交邻格均可行走（不穿墙角）。起终点落在
// 不可行走格时先在附近螺旋搜最近的可行走格。得到格路径后做"视线拉直"
// （string pulling）：线段上逐格 SDF ≥ 代理半径即可直连，把折线压成尽量少
// 的转弯点——路径点数从几百降到个位数，代理跟随与渲染都轻。
// ---------------------------------------------------------------------------

import {
  cellToWorldX,
  cellToWorldZ,
  sampleNavHeight,
  sampleNavSdf,
  worldToCellX,
  worldToCellZ,
  NAV_SURFACE_LIFT,
  type NavBakeResult,
} from "./bake";

/** 平滑后的路径点（世界系；y 为贴地高度 + 抬升） */
export interface NavPathPoint {
  x: number;
  y: number;
  z: number;
}

export interface NavPathResult {
  found: boolean;
  /** 平滑后的路径点（含起点与终点；found=false 时为空） */
  points: NavPathPoint[];
  /** 实际使用的起终点格（被夹到最近可行走格后的结果） */
  startCell: { i: number; j: number } | null;
  endCell: { i: number; j: number } | null;
}

/** 二叉最小堆（按 f 排序的 A* 开放集） */
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.vals[0];
    const lastKey = this.keys.pop() as number;
    const lastVal = this.vals.pop() as number;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.vals[0] = lastVal;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = k;
    const v = this.vals[a];
    this.vals[a] = this.vals[b];
    this.vals[b] = v;
  }
}

/** 从 (i,j) 螺旋外扩找最近可行走格（最多 radius 圈；找不到 null） */
function nearestWalkable(
  nav: NavBakeResult,
  i0: number,
  j0: number,
  radius = 8,
): { i: number; j: number } | null {
  const ci = Math.min(Math.max(i0, 0), nav.w - 1);
  const cj = Math.min(Math.max(j0, 0), nav.h - 1);
  if (nav.walkable[cj * nav.w + ci]) return { i: ci, j: cj };
  for (let r = 1; r <= radius; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= nav.w || j >= nav.h) continue;
        if (nav.walkable[j * nav.w + i]) return { i, j };
      }
    }
  }
  return null;
}

/** A* 主搜索：格路径（未平滑）；找不到返回 null */
function astar(
  nav: NavBakeResult,
  start: { i: number; j: number },
  end: { i: number; j: number },
): number[] | null {
  const w = nav.w;
  const n = w * nav.h;
  const gScore = new Float32Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const open = new MinHeap();
  const sIdx = start.j * w + start.i;
  const eIdx = end.j * w + end.i;
  gScore[sIdx] = 0;
  open.push(heuristic(start.i, start.j, end.i, end.j), sIdx);
  const SQRT2 = Math.SQRT2;

  while (open.size > 0) {
    const cur = open.pop();
    if (cur === eIdx) return reconstruct(cameFrom, eIdx);
    if (closed[cur]) continue;
    closed[cur] = 1;
    const ci = cur % w;
    const cj = (cur - ci) / w;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= nav.h) continue;
        const nIdx = nj * w + ni;
        if (closed[nIdx] || !nav.walkable[nIdx]) continue;
        // 对角不切角：两个正交邻格必须都可行走
        if (di !== 0 && dj !== 0) {
          if (!nav.walkable[cj * w + ni] || !nav.walkable[nj * w + ci]) continue;
        }
        const step = di !== 0 && dj !== 0 ? SQRT2 : 1;
        // 坡度代价：上坡/下坡高差计入（陡的方向更贵，路径更贴谷底）
        const climb = Math.abs(nav.heights[nIdx] - nav.heights[cur]) / nav.cellSize;
        const tentative = gScore[cur] + step * (1 + climb * 0.5);
        if (tentative < gScore[nIdx]) {
          gScore[nIdx] = tentative;
          cameFrom[nIdx] = cur;
          open.push(tentative + heuristic(ni, nj, end.i, end.j), nIdx);
        }
      }
    }
  }
  return null;
}

/** 八方向启发（可采纳；起终点格保证在网格内，无需 nav 参数） */
function heuristic(i: number, j: number, ei: number, ej: number): number {
  const dx = Math.abs(i - ei);
  const dj = Math.abs(j - ej);
  return (dx + dj) + (Math.SQRT2 - 2) * Math.min(dx, dj);
}

function reconstruct(cameFrom: Int32Array, endIdx: number): number[] {
  const out: number[] = [];
  let cur = endIdx;
  while (cur >= 0) {
    out.push(cur);
    cur = cameFrom[cur];
  }
  out.reverse();
  return out;
}

/** 格间视线检查：线段逐格采样 SDF ≥ 代理半径（超采样防斜线穿格） */
function lineOfSight(
  nav: NavBakeResult,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  clearance: number,
): boolean {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const dist = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(dist / (nav.cellSize * 0.4)));
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    if (sampleNavSdf(nav, x0 + dx * t, z0 + dz * t) < clearance) return false;
  }
  return true;
}

/**
 * 寻路入口：世界坐标起终点 → 平滑路径。
 * clearance 取代理半径（起终点/路径逐点净空）；找不到可达路线 found=false。
 */
export function findNavPath(
  nav: NavBakeResult,
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
  agentRadius: number,
): NavPathResult {
  const empty: NavPathResult = { found: false, points: [], startCell: null, endCell: null };
  const ci = Math.round(worldToCellX(nav, startX));
  const cj = Math.round(worldToCellZ(nav, startZ));
  const ei = Math.round(worldToCellX(nav, endX));
  const ej = Math.round(worldToCellZ(nav, endZ));
  const start = nearestWalkable(nav, ci, cj);
  const end = nearestWalkable(nav, ei, ej);
  if (!start || !end) return empty;
  if (start.i === end.i && start.j === end.j) {
    return {
      found: true,
      points: [navPointAt(nav, start.i, start.j), navPointAt(nav, end.i, end.j)],
      startCell: start,
      endCell: end,
    };
  }
  const cells = astar(nav, start, end);
  if (!cells) return { ...empty, startCell: start, endCell: end };

  // 视线拉直：贪心取"当前点能直连的最远格"作为下一个拐点
  const pts: NavPathPoint[] = [];
  const world: { x: number; z: number }[] = cells.map((idx) => {
    const i = idx % nav.w;
    const j = (idx - i) / nav.w;
    return { x: cellToWorldX(nav, i), z: cellToWorldZ(nav, j) };
  });
  let anchor = 0;
  pts.push(navPointAt(nav, start.i, start.j));
  while (anchor < world.length - 1) {
    let furthest = anchor + 1;
    for (let k = world.length - 1; k > anchor + 1; k--) {
      if (lineOfSight(nav, world[anchor].x, world[anchor].z, world[k].x, world[k].z, agentRadius)) {
        furthest = k;
        break;
      }
    }
    anchor = furthest;
    const idx = cells[anchor];
    const i = idx % nav.w;
    const j = (idx - i) / nav.w;
    pts.push(navPointAt(nav, i, j));
  }
  // 终点用原始请求坐标（贴到最近可行走格的路径末端 → 精确到点击处）
  pts[pts.length - 1] = { x: endX, y: pathY(nav, endX, endZ), z: endZ };
  return { found: true, points: pts, startCell: start, endCell: end };
}

/** 格中心路径点（贴地高度 + 抬升） */
function navPointAt(nav: NavBakeResult, i: number, j: number): NavPathPoint {
  const x = cellToWorldX(nav, i);
  const z = cellToWorldZ(nav, j);
  return { x, y: pathY(nav, x, z), z };
}

function pathY(nav: NavBakeResult, x: number, z: number): number {
  return sampleNavHeight(nav, x, z) + NAV_SURFACE_LIFT;
}
