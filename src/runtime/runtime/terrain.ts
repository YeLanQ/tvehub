// 地形（terrainNode）构建：程序化高度场地形（位置 + 顶点色 + 菱形三角索引）。
// 算法语义移植自 three.js 示例 TerrainGenerator.js（导数阻尼分形 + 域扭曲 +
// 热侵蚀 + 菱形网格 + 海拔/坡度色带），与编辑器 framework/terrain/generate.ts
// 同一套参数与算法（两边改参数需同步）。表面配色在 CPU 烘焙为顶点色，
// MeshStandardMaterial(map=colorTexture) 在 WebGL/WebGPU 双后端一致可用。
// 脚本经 engine SDK 的 TerrainNode.sampleHeight / sampleSlope 贴地采样。
import * as THREE from "../core/three.module.min.js";
import { num } from "../core/utils";
import { resourceLoader } from "./resource";
import type { NodeJson } from "./node-json";
import type { SceneTerrainEntry } from "./nodes";

// ---------------------------------------------------------------------------
// 类型（JSON 宽松视图 + 解析产物 + 烘焙数据）
// ---------------------------------------------------------------------------

/** JSON 来源的宽松对象（索引签名放行未知键） */
type UnknownRec = Record<string, unknown>;

/** 地形设置（parseSettings 收敛结果；与编辑器 parseTerrainSettings 同取值域） */
interface TerrainSettings {
  seed: number;
  size: number;
  segments: number;
  heightScale: number;
  frequency: number;
  octaves: number;
  lacunarity: number;
  gain: number;
  erosion: number;
  warp: number;
  valleyBias: number;
  seaLevel: number;
  talus: number;
  talusPasses: number;
  grassColor: number;
  rockColor: number;
  snowColor: number;
}

/** 地形材质图层 JSON（materialSettings.layers[n]；color 为 sRGB hex） */
interface TerrainLayerJson {
  color?: number;
  [key: string]: unknown;
}

/** 地形材质绑定 JSON（materialSettings：图层颜色覆盖 + splatmap 重烘焙 + PBR 参数） */
interface TerrainMaterialSettingsJson {
  layers?: TerrainLayerJson[];
  /** splatmap 图片 rel（存在则异步重烘焙颜色纹理） */
  splatmap?: string;
  metalness?: number;
  roughness?: number;
  [key: string]: unknown;
}

/** 传给烘焙的 splatmap 权重源（data=null → 按海拔/坡度 4 层混合） */
interface SplatmapInput {
  data: Uint8Array | null;
  width: number;
  height: number;
  layerColors: number[];
}

/** 线性 RGB 三元组（hexToLinear 产物；mix3/scale3 原地修改） */
type Rgb = [number, number, number];

/** 自适应四叉树叶节点（children 缺省即叶子；坐标为高度场网格下标） */
interface TerrainQuad {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  children?: TerrainQuad[];
}

/** 高度场网格简化产物（vertices = 网格坐标 [x,z] 对；indices 为叶子菱形三角带） */
interface SimplifiedTerrainMesh {
  vertices: Int32Array;
  indices: Uint32Array;
}

/** buildTerrain 烘焙产物（buildSceneTree 地形条目 data 的实体） */
interface TerrainBuildData {
  geometry: THREE.BufferGeometry;
  colorTexture: THREE.DataTexture;
  heights: Float32Array;
  gridSize: number;
  size: number;
  segments: number;
  minY: number;
  maxY: number;
}

/** DEM 数据源 JSON（dem.data = base64 Float32 归一化高度；gridN 网格边长） */
interface DemJson {
  data?: unknown;
  gridN?: unknown;
  [key: string]: unknown;
}

/** 雕刻偏移层 JSON（sculpt.data = base64 Float32；gridN 须与烘焙网格一致） */
interface SculptJson {
  data?: unknown;
  gridN?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// ImprovedNoise（Ken Perlin 2002；置换表固定 → 种子只能位移采样窗口）
// ---------------------------------------------------------------------------
const _p = [
  151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10,
  23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87,
  174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211,
  133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208,
  89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217, 226, 250, 124, 123, 5,
  202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213, 119,
  248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232,
  178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249,
  14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205,
  93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180,
];
for (let i = 0; i < 256; i++) _p[256 + i] = _p[i];

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function grad(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

class ImprovedNoise {
  noise(x: number, y: number, z: number): number {
    const floorX = Math.floor(x), floorY = Math.floor(y), floorZ = Math.floor(z);
    const X = floorX & 255, Y = floorY & 255, Z = floorZ & 255;
    x -= floorX;
    y -= floorY;
    z -= floorZ;
    const xMinus1 = x - 1, yMinus1 = y - 1, zMinus1 = z - 1;
    const u = fade(x), v = fade(y), w = fade(z);
    const A = _p[X] + Y, AA = _p[A] + Z, AB = _p[A + 1] + Z, B = _p[X + 1] + Y, BA = _p[B] + Z, BB = _p[B + 1] + Z;
    return lerp(
      lerp(
        lerp(grad(_p[AA], x, y, z), grad(_p[BA], xMinus1, y, z), u),
        lerp(grad(_p[AB], x, yMinus1, z), grad(_p[BB], xMinus1, yMinus1, z), u),
        v,
      ),
      lerp(
        lerp(grad(_p[AA + 1], x, y, zMinus1), grad(_p[BA + 1], xMinus1, y, zMinus1), u),
        lerp(grad(_p[AB + 1], x, yMinus1, zMinus1), grad(_p[BB + 1], xMinus1, yMinus1, zMinus1), u),
        v,
      ),
      w,
    );
  }
}

// ---------------------------------------------------------------------------
// 设置收敛（与编辑器 parseTerrainSettings / TERRAIN_LIMITS 同一取值域）
// ---------------------------------------------------------------------------
const DEFAULTS = {
  seed: 1,
  size: 200,
  // 256（2 的幂）：与编辑器默认一致，保持四叉树顶点简化启用
  segments: 256,
  heightScale: 65,
  frequency: 0.01,
  octaves: 5,
  lacunarity: 1.97,
  gain: 0.5,
  erosion: 0.7,
  warp: 0.35,
  valleyBias: 1.2,
  seaLevel: 0.15,
  talus: 1,
  talusPasses: 12,
  grassColor: 0x6e7253,
  rockColor: 0x736a5f,
  snowColor: 0xe9ecf0,
};

const LIMITS: Record<string, [number, number]> = {
  seed: [1, 999999],
  size: [10, 2000],
  segments: [16, 256],
  // 上限覆盖真实地形起伏量级（DEM 导入自动设置；与编辑器 TERRAIN_LIMITS 同步改）
  heightScale: [0, 10000],
  frequency: [0.0005, 0.05],
  octaves: [1, 8],
  lacunarity: [1, 4],
  gain: [0.1, 0.9],
  erosion: [0, 2],
  warp: [0, 1.5],
  valleyBias: [0.5, 3],
  seaLevel: [-0.5, 0.8],
  talus: [0.2, 2],
  talusPasses: [0, 40],
};

function clampN(v: unknown, lo: number, hi: number, fb: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fb;
  return Math.min(hi, Math.max(lo, n));
}

function clampI(v: unknown, lo: number, hi: number, fb: number): number {
  return Math.round(clampN(v, lo, hi, fb));
}

function clampHex(v: unknown, fb: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fb;
  return Math.min(0xffffff, Math.max(0, Math.round(n))) & 0xffffff;
}

/** 收敛地形设置（缺字段/越界回默认或钳进取值域；与编辑器 parse 同边界） */
function parseSettings(v: unknown): TerrainSettings {
  const o = (v && typeof v === "object" ? v : {}) as UnknownRec; // JSON 来源宽松对象，逐字段经 clamp 收敛
  return {
    seed: clampI(o.seed, ...LIMITS.seed, DEFAULTS.seed),
    size: clampN(o.size, ...LIMITS.size, DEFAULTS.size),
    segments: clampI(o.segments, ...LIMITS.segments, DEFAULTS.segments),
    heightScale: clampN(o.heightScale, ...LIMITS.heightScale, DEFAULTS.heightScale),
    frequency: clampN(o.frequency, ...LIMITS.frequency, DEFAULTS.frequency),
    octaves: clampI(o.octaves, ...LIMITS.octaves, DEFAULTS.octaves),
    lacunarity: clampN(o.lacunarity, ...LIMITS.lacunarity, DEFAULTS.lacunarity),
    gain: clampN(o.gain, ...LIMITS.gain, DEFAULTS.gain),
    erosion: clampN(o.erosion, ...LIMITS.erosion, DEFAULTS.erosion),
    warp: clampN(o.warp, ...LIMITS.warp, DEFAULTS.warp),
    valleyBias: clampN(o.valleyBias, ...LIMITS.valleyBias, DEFAULTS.valleyBias),
    seaLevel: clampN(o.seaLevel, ...LIMITS.seaLevel, DEFAULTS.seaLevel),
    talus: clampN(o.talus, ...LIMITS.talus, DEFAULTS.talus),
    talusPasses: clampI(o.talusPasses, ...LIMITS.talusPasses, DEFAULTS.talusPasses),
    grassColor: clampHex(o.grassColor, DEFAULTS.grassColor),
    rockColor: clampHex(o.rockColor, DEFAULTS.rockColor),
    snowColor: clampHex(o.snowColor, DEFAULTS.snowColor),
  };
}

// ---------------------------------------------------------------------------
// 高度场（mulberry32 种子 → ImprovedNoise 采样窗口位移 + 导数阻尼分形 + 域扭曲）
// ---------------------------------------------------------------------------
function createRandom(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return function (): number {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function heightField(p: TerrainSettings): (worldX: number, worldZ: number) => number {
  const perlin = new ImprovedNoise();
  const random = createRandom(p.seed);
  const offsetX = random() * 256;
  const offsetZ = random() * 256;
  const slice = random() * 256;
  const { frequency, octaves, lacunarity, gain, erosion, warp, valleyBias, seaLevel, heightScale } = p;

  function warpField(x: number, z: number, zr: number): number {
    let freq = 1, amp = 1, sum = 0, norm = 0;
    for (let i = 0; i < 2; i++) {
      sum += amp * perlin.noise(x * freq + offsetX, z * freq + offsetZ, zr + i * 1.7);
      norm += amp;
      freq *= lacunarity;
      amp *= gain;
    }
    return sum / norm;
  }

  function eroded(x: number, z: number): number {
    let sum = 0, amp = 1, dX = 0, dZ = 0, px = x, pz = z, freq = 1;
    const e = 0.004;
    for (let i = 0; i < octaves; i++) {
      const zr = slice + i * 1.7;
      const bx = px * freq + offsetX;
      const bz = pz * freq + offsetZ;
      const n = perlin.noise(bx, bz, zr);
      const nx = perlin.noise(bx + e, bz, zr);
      const nz = perlin.noise(bx, bz + e, zr);
      dX += ((nx - n) / e) * freq;
      dZ += ((nz - n) / e) * freq;
      sum += (amp * n) / (1 + erosion * (dX * dX + dZ * dZ));
      const rx = 0.8 * px - 0.6 * pz;
      pz = 0.6 * px + 0.8 * pz;
      px = rx;
      freq *= lacunarity;
      amp *= gain;
    }
    return sum * 0.5 + 0.5;
  }

  return function (worldX, worldZ) {
    const x = worldX * frequency;
    const z = worldZ * frequency;
    const wx = x + warp * warpField(x + 1.3, z + 7.2, slice + 40);
    const wz = z + warp * warpField(x + 5.2, z + 1.3, slice + 70);
    const h = Math.pow(Math.min(eroded(wx, wz) * 1.1, 1), valleyBias);
    return (h - seaLevel) * heightScale;
  };
}

/** 热侵蚀（talus）：超休止角坡面逐 pass 塌落；delta 缓冲保证物料守恒 */
function thermalErode(h: Float32Array, n: number, cellSize: number, talus: number, passes: number): void {
  const drop = talus * cellSize;
  const carry = 0.5;
  const delta = new Float32Array(n * n);
  const ex = [0, 0, 0, 0];
  const off = [-1, 1, -n, n];
  for (let p = 0; p < passes; p++) {
    delta.fill(0);
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        const i = z * n + x;
        const hi = h[i];
        ex[0] = x > 0 ? hi - h[i - 1] - drop : 0;
        ex[1] = x < n - 1 ? hi - h[i + 1] - drop : 0;
        ex[2] = z > 0 ? hi - h[i - n] - drop : 0;
        ex[3] = z < n - 1 ? hi - h[i + n] - drop : 0;
        let sum = 0;
        let peak = 0;
        for (let k = 0; k < 4; k++) {
          const d = ex[k];
          if (d <= 0) {
            ex[k] = 0;
            continue;
          }
          sum += d;
          if (d > peak) peak = d;
        }
        if (sum <= 0) continue;
        const move = carry * peak;
        delta[i] -= move;
        for (let k = 0; k < 4; k++) {
          if (ex[k] > 0) delta[i + off[k]] += (move * ex[k]) / sum;
        }
      }
    }
    for (let k = 0; k < n * n; k++) h[k] += delta[k];
  }
}

// ---------------------------------------------------------------------------
// 顶点色（海拔/坡度色带 + 值噪声扰动；hex → 线性 RGB 与 ColorManagement 一致）
// ---------------------------------------------------------------------------
function hash2(ix: number, iz: number, seed: number): number {
  let h = (ix * 374761393 + iz * 668265263 + seed * 1442695) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise2(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const tx = x - ix;
  const tz = z - iz;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return ((a * (1 - sx) + b * sx) * (1 - sz) + (c * (1 - sx) + d * sx) * sz) * 2 - 1;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** sRGB hex → 线性 RGB（three 默认把 hex 视作 sRGB；顶点色按线性消费，需先转换） */
function hexToLinear(hex: number): Rgb {
  const c = new THREE.Color();
  c.setHex(hex & 0xffffff);
  return [c.r, c.g, c.b];
}

function mix3(a: Rgb, b: Rgb, t: number): void {
  a[0] += (b[0] - a[0]) * t;
  a[1] += (b[1] - a[1]) * t;
  a[2] += (b[2] - a[2]) * t;
}

function scale3(a: Rgb, f: number): void {
  a[0] = Math.min(1, a[0] * f);
  a[1] = Math.min(1, a[1] * f);
  a[2] = Math.min(1, a[2] * f);
}

// ---------------------------------------------------------------------------
// 自适应四叉树网格简化（与编辑器 simplify.ts 同语义）
// ---------------------------------------------------------------------------

function _quadMaxError(h: Float32Array, n: number, x0: number, x1: number, z0: number, z1: number): number {
  const h00 = h[z0 * n + x0], h10 = h[z0 * n + x1], h01 = h[z1 * n + x0], h11 = h[z1 * n + x1];
  const dx = x1 - x0, dz = z1 - z0;
  let maxErr = 0;
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const tx = (x - x0) / dx, tz = (z - z0) / dz;
      const interp = h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
      const err = Math.abs(h[z * n + x] - interp);
      if (err > maxErr) maxErr = err;
    }
  }
  return maxErr;
}

function _buildQuad(h: Float32Array, n: number, x0: number, x1: number, z0: number, z1: number, threshold: number, depth: number, maxDepth: number): TerrainQuad {
  const q: TerrainQuad = { x0, z0, x1, z1 };
  if (x1 - x0 <= 1 || z1 - z0 <= 1 || depth >= maxDepth) return q;
  if (_quadMaxError(h, n, x0, x1, z0, z1) < threshold) return q;
  const mx = (x0 + x1) >> 1, mz = (z0 + z1) >> 1;
  q.children = [
    _buildQuad(h, n, x0, mx, z0, mz, threshold, depth + 1, maxDepth),
    _buildQuad(h, n, mx, x1, z0, mz, threshold, depth + 1, maxDepth),
    _buildQuad(h, n, x0, mx, mz, z1, threshold, depth + 1, maxDepth),
    _buildQuad(h, n, mx, x1, mz, z1, threshold, depth + 1, maxDepth),
  ];
  return q;
}

function _collectLeaves(q: TerrainQuad, leaves: TerrainQuad[]): void {
  if (!q.children) { leaves.push(q); return; }
  for (const c of q.children) _collectLeaves(c, leaves);
}

function _findLeaf(root: TerrainQuad, x: number, z: number): TerrainQuad | null {
  if (x < root.x0 || x > root.x1 || z < root.z0 || z > root.z1) return null;
  if (!root.children) return root;
  for (const c of root.children) {
    const r = _findLeaf(c, x, z);
    if (r) return r;
  }
  return null;
}

function _balanceTree(root: TerrainQuad): void {
  let changed = true;
  while (changed) {
    changed = false;
    const leaves: TerrainQuad[] = [];
    _collectLeaves(root, leaves);
    for (const l of leaves) {
      if (l.children) continue;
      const lSize = l.x1 - l.x0;
      const checks = [
        [l.x0, l.z0 - 1], [l.x1, l.z0 - 1],
        [l.x0, l.z1 + 1], [l.x1, l.z1 + 1],
        [l.x0 - 1, l.z0], [l.x0 - 1, l.z1],
        [l.x1 + 1, l.z0], [l.x1 + 1, l.z1],
      ];
      for (const [cx, cz] of checks) {
        const neighbor = _findLeaf(root, cx, cz);
        if (neighbor && !neighbor.children && (neighbor.x1 - neighbor.x0) < lSize / 2) {
          const mx = (l.x0 + l.x1) >> 1, mz = (l.z0 + l.z1) >> 1;
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

function _simplifyTerrainMesh(heights: Float32Array, n: number, threshold: number): SimplifiedTerrainMesh | null {
  const segs = n - 1;
  if (segs < 4 || (segs & (segs - 1)) !== 0) return null;

  const maxDepth = Math.round(Math.log2(segs));
  const root = _buildQuad(heights, n, 0, segs, 0, segs, threshold, 0, maxDepth);
  _balanceTree(root);

  const leaves: TerrainQuad[] = [];
  _collectLeaves(root, leaves);

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
    const mx = (l.x0 + l.x1) >> 1, mz = (l.z0 + l.z1) >> 1;
    const A = getVert(l.x0, l.z0), B = getVert(l.x1, l.z0);
    const C = getVert(l.x1, l.z1), D = getVert(l.x0, l.z1);
    const M = getVert(mx, mz);

    const topN = _findLeaf(root, mx, l.z0 - 1);
    const rightN = _findLeaf(root, l.x1 + 1, mz);
    const bottomN = _findLeaf(root, mx, l.z1 + 1);
    const leftN = _findLeaf(root, l.x0 - 1, mz);

    const topMid = topN && !topN.children && (topN.x1 - topN.x0) < lSize ? getVert(mx, l.z0) : -1;
    const rightMid = rightN && !rightN.children && (rightN.x1 - rightN.x0) < lSize ? getVert(l.x1, mz) : -1;
    const bottomMid = bottomN && !bottomN.children && (bottomN.x1 - bottomN.x0) < lSize ? getVert(mx, l.z1) : -1;
    const leftMid = leftN && !leftN.children && (leftN.x1 - leftN.x0) < lSize ? getVert(l.x0, mz) : -1;

    if (topMid >= 0) { indices.push(A, M, topMid, topMid, M, B); } else { indices.push(A, M, B); }
    if (rightMid >= 0) { indices.push(B, M, rightMid, rightMid, M, C); } else { indices.push(B, M, C); }
    if (bottomMid >= 0) { indices.push(C, M, bottomMid, bottomMid, M, D); } else { indices.push(C, M, D); }
    if (leftMid >= 0) { indices.push(D, M, leftMid, leftMid, M, A); } else { indices.push(D, M, A); }
  }

  return { vertices: Int32Array.from(vertices), indices: Uint32Array.from(indices) };
}

function _sampleHeightAt(h: Float32Array, n: number, size: number, wx: number, wz: number): number {
  const half = size / 2;
  const segs = n - 1;
  const fx = Math.min(segs, Math.max(0, ((wx + half) / size) * segs));
  const fz = Math.min(segs, Math.max(0, ((wz + half) / size) * segs));
  const ix = Math.min(n - 2, Math.floor(fx));
  const iz = Math.min(n - 2, Math.floor(fz));
  const tx = fx - ix, tz = fz - iz;
  return (h[iz * n + ix] * (1 - tx) + h[iz * n + ix + 1] * tx) * (1 - tz) +
         (h[(iz + 1) * n + ix] * (1 - tx) + h[(iz + 1) * n + ix + 1] * tx) * tz;
}

function _bakeColorTexture(heights: Float32Array, n: number, p: TerrainSettings, min: number, max: number, splatmap: SplatmapInput | null): THREE.DataTexture {
  const res = 256;
  const data = new Uint8Array(res * res * 4);
  const hSpan = Math.max(1e-6, max - min);
  const cellSize = p.size / (n - 1);

  const grass = hexToLinear(p.grassColor);
  const rock = hexToLinear(p.rockColor);
  const snow = hexToLinear(p.snowColor);
  const dryGrass: Rgb = [...grass]; scale3(dryGrass, 1.28);
  const forest: Rgb = [...grass]; scale3(forest, 0.55);
  const scree: Rgb = [...rock]; scale3(scree, 1.15);
  const lichen: Rgb = [...rock]; mix3(lichen, grass, 0.35);
  const snowDeep: Rgb = [...snow]; scale3(snowDeep, 0.88);
  const colorSeed = p.seed & 0xffff;
  const tmp: Rgb = [0, 0, 0];

  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const wx = ((i / (res - 1)) - 0.5) * p.size;
      const wz = ((j / (res - 1)) - 0.5) * p.size;
      const wy = _sampleHeightAt(heights, n, p.size, wx, wz);

      const e = cellSize * 0.5;
      const dx = (_sampleHeightAt(heights, n, p.size, wx + e, wz) - _sampleHeightAt(heights, n, p.size, wx - e, wz)) / (2 * e);
      const dz = (_sampleHeightAt(heights, n, p.size, wx, wz + e) - _sampleHeightAt(heights, n, p.size, wx, wz - e)) / (2 * e);
      const ny = 1 / Math.sqrt(dx * dx + 1 + dz * dz);

      const altitude = Math.min(1, Math.max(0, (wy - min) / hSpan));
      const flatness = Math.min(1, Math.max(0, ny));
      const steep = 1 - flatness;
      const detail = valueNoise2(wx * 0.05, wz * 0.05, colorSeed);
      const grain = valueNoise2(wx * 0.18, wz * 0.18, colorSeed + 7);
      const macro = valueNoise2(wx * 0.012, wz * 0.012, colorSeed + 13);

      let surface: Rgb;
      if (splatmap) {
        const lc = splatmap.layerColors;
        const c0 = hexToLinear(lc[0]), c1 = hexToLinear(lc[1]), c2 = hexToLinear(lc[2]), c3 = hexToLinear(lc[3]);
        if (splatmap.data) {
          const su = Math.min(1, Math.max(0, (wx / p.size) + 0.5));
          const sv = Math.min(1, Math.max(0, (wz / p.size) + 0.5));
          const sx = Math.min(splatmap.width - 1, Math.max(0, Math.round(su * (splatmap.width - 1))));
          const sy = Math.min(splatmap.height - 1, Math.max(0, Math.round(sv * (splatmap.height - 1))));
          const si = (sy * splatmap.width + sx) * 4;
          const wR = splatmap.data[si] / 255;
          const wG = splatmap.data[si + 1] / 255;
          const wB = splatmap.data[si + 2] / 255;
          const wA = splatmap.data[si + 3] / 255;
          const wSum = Math.max(1e-6, wR + wG + wB + wA);
          surface = [
            (c0[0] * wR + c1[0] * wG + c2[0] * wB + c3[0] * wA) / wSum,
            (c0[1] * wR + c1[1] * wG + c2[1] * wB + c3[1] * wA) / wSum,
            (c0[2] * wR + c1[2] * wG + c2[2] * wB + c3[2] * wA) / wSum,
          ];
        } else {
          const w0 = smoothstep(0.5, 0.2, altitude) * flatness;
          const w1 = steep;
          const w2 = smoothstep(0.5, 0.8, altitude) * flatness;
          const w3 = smoothstep(0.2, 0.5, altitude) * smoothstep(0.7, 0.3, altitude) * flatness;
          const wSum = Math.max(1e-6, w0 + w1 + w2 + w3);
          surface = [
            (c0[0] * w0 + c1[0] * w1 + c2[0] * w2 + c3[0] * w3) / wSum,
            (c0[1] * w0 + c1[1] * w1 + c2[1] * w2 + c3[1] * w3) / wSum,
            (c0[2] * w0 + c1[2] * w1 + c2[2] * w2 + c3[2] * w3) / wSum,
          ];
        }
        scale3(surface, (macro * 0.5 + 0.5) * 0.3 + 0.84);
        scale3(surface, (grain * 0.5 + 0.5) * 0.12 + 0.94);
      } else {
        surface = [...grass];
        mix3(surface, dryGrass, smoothstep(0.15, 0.75, macro) * smoothstep(0.22, 0.5, altitude));
        mix3(surface, forest, smoothstep(0.16, 0.34, altitude) * smoothstep(0.5, 0.72, flatness) * 0.75);
        const rockShade: Rgb = [...rock];
        const strata = (Math.sin(wy * 0.5 + detail * 3 + macro * 4) * 0.6 + Math.sin(wy * 1.4 + grain * 2) * 0.4) * 0.5 + 0.5;
        const lichenMask = smoothstep(0.45, 0.72, grain) * smoothstep(0.62, 0.32, steep) * smoothstep(0.66, 0.34, altitude);
        mix3(rockShade, lichen, lichenMask * 0.45);
        scale3(rockShade, strata * 0.36 + 0.8);
        mix3(surface, rockShade, smoothstep(0.46, 0.64, altitude + detail * 0.06));
        mix3(surface, rockShade, smoothstep(0.34, 0.62, steep));
        const screeMask = smoothstep(0.42, 0.7, steep) * smoothstep(0.35, 0.7, flatness) * (detail * 0.5 + 0.5);
        mix3(surface, scree, screeMask * 0.5);
        const snowMask = smoothstep(0.56, 0.78, altitude + detail * 0.08 + grain * 0.05) * smoothstep(0.3, 0.6, flatness);
        tmp[0] = snow[0]; tmp[1] = snow[1]; tmp[2] = snow[2];
        mix3(tmp, snowDeep, smoothstep(0.2, 0.7, grain) * 0.6);
        mix3(surface, tmp, snowMask);
        const cavity = smoothstep(0.24, 0.06, altitude) * flatness;
        scale3(surface, 1 - cavity * 0.32);
        scale3(surface, (macro * 0.5 + 0.5) * 0.3 + 0.84);
        scale3(surface, (grain * 0.5 + 0.5) * 0.12 + 0.94);
      }

      const idx = (j * res + i) * 4;
      data[idx] = Math.round(surface[0] * 255);
      data[idx + 1] = Math.round(surface[1] * 255);
      data[idx + 2] = Math.round(surface[2] * 255);
      data[idx + 3] = 255;
    }
  }

  const blurred = new Uint8Array(res * res * 4);
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      let r = 0, g = 0, b = 0, count = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ni = Math.min(res - 1, Math.max(0, i + di));
          const nj = Math.min(res - 1, Math.max(0, j + dj));
          const sIdx = (nj * res + ni) * 4;
          r += data[sIdx]; g += data[sIdx + 1]; b += data[sIdx + 2]; count++;
        }
      }
      const dIdx = (j * res + i) * 4;
      blurred[dIdx] = Math.round(r / count);
      blurred[dIdx + 1] = Math.round(g / count);
      blurred[dIdx + 2] = Math.round(b / count);
      blurred[dIdx + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(blurred, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// 构建
// ---------------------------------------------------------------------------

/** 程序化基准高度（分形 + 热侵蚀；DEM 数据源地形不走这条路径） */
function bakeHeights(p: TerrainSettings, coord: number[], n: number): Float32Array {
  const height = heightField(p);
  const heights = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      heights[iz * n + ix] = height(coord[ix], coord[iz]);
    }
  }
  if (p.talusPasses > 0) thermalErode(heights, n, p.size / p.segments, p.talus, p.talusPasses);
  return heights;
}

// —— 数字地形数据源（编辑器 framework/terrain/dem.ts 的解码镜像：只解码内嵌
//    归一化网格 + 双线性重采样，不解析 ASC/HGT 等源文件；两边算法需同步）——
function _decodeDemData(data: string): Float32Array | null {
  try {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.byteLength % 4 === 0 ? new Float32Array(bytes.buffer) : null;
  } catch {
    return null;
  }
}

function _resampleDemGrid(src: Float32Array, srcN: number, targetN: number): Float32Array {
  if (srcN === targetN) return src;
  const out = new Float32Array(targetN * targetN);
  const last = srcN - 1;
  for (let z = 0; z < targetN; z++) {
    const fz = (z / (targetN - 1)) * last;
    const z0 = Math.min(last - 1, Math.floor(fz));
    const tz = fz - z0;
    for (let x = 0; x < targetN; x++) {
      const fx = (x / (targetN - 1)) * last;
      const x0 = Math.min(last - 1, Math.floor(fx));
      const tx = fx - x0;
      const h00 = src[z0 * srcN + x0];
      const h10 = src[z0 * srcN + x0 + 1];
      const h01 = src[(z0 + 1) * srcN + x0];
      const h11 = src[(z0 + 1) * srcN + x0 + 1];
      out[z * targetN + x] = (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
    }
  }
  return out;
}

/** DEM 基准高度（归一化 × heightScale 垂直夸张；损坏返回 null → 回退程序化） */
function demBaseOf(dem: DemJson | null | undefined, heightScale: number, targetN: number): Float32Array | null {
  if (!dem || typeof dem.data !== "string" || typeof dem.gridN !== "number" || dem.gridN < 2) return null;
  const norm = _decodeDemData(dem.data);
  if (!norm || norm.length !== dem.gridN * dem.gridN) return null;
  const sampled = _resampleDemGrid(norm, dem.gridN, targetN);
  const out = new Float32Array(sampled.length);
  for (let i = 0; i < sampled.length; i++) out[i] = sampled[i] * heightScale;
  return out;
}

/**
 * 烘焙地形几何与采样数据（位置/顶点色/法线/菱形索引）。
 * splatmap 不为空时，颜色纹理按 splatmap RGBA 权重混合 4 个图层颜色。
 * base 不为空且与网格规模一致时作为基准高度（编辑器 DEM 数据源解码产物），
 * 跳过程序化分形+热侵蚀（与编辑器 buildTerrain 的 baseHeights 参数同语义）。
 * 返回 { geometry, colorTexture, heights, gridSize, size, segments, minY, maxY }。
 */
function buildTerrain(p: TerrainSettings, splatmap: SplatmapInput | null, sculpt: Float32Array | null, base: Float32Array | null): TerrainBuildData {
  const n = p.segments + 1;
  const half = p.size / 2;

  const coord: number[] = new Array(n);
  for (let i = 0; i < n; i++) coord[i] = (i / p.segments) * p.size - half;

  const heights = base && base.length === n * n ? new Float32Array(base) : bakeHeights(p, coord, n);

  // 雕刻偏移层（编辑器笔刷雕刻；TerrainNode.sculpt，网格规模一致才叠加）
  if (sculpt && sculpt.length === heights.length) {
    for (let i = 0; i < heights.length; i++) heights[i] += sculpt[i];
  }

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n * n; i++) {
    const y = heights[i];
    if (y < min) min = y;
    if (y > max) max = y;
  }

  const hSpan = Math.max(1e-6, max - min);
  const simplified = _simplifyTerrainMesh(heights, n, hSpan * 0.05);

  let positions: Float32Array;
  let vertCount: number;
  let indices: Uint32Array | number[];

  if (simplified) {
    vertCount = simplified.vertices.length / 2;
    positions = new Float32Array(vertCount * 3);
    for (let i = 0; i < vertCount; i++) {
      const gx = simplified.vertices[i * 2];
      const gz = simplified.vertices[i * 2 + 1];
      positions[i * 3] = coord[gx];
      positions[i * 3 + 1] = heights[gz * n + gx];
      positions[i * 3 + 2] = coord[gz];
    }
    indices = simplified.indices;
  } else {
    vertCount = n * n;
    positions = new Float32Array(vertCount * 3);
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const o = iz * n + ix;
        positions[o * 3] = coord[ix];
        positions[o * 3 + 1] = heights[o];
        positions[o * 3 + 2] = coord[iz];
      }
    }
    indices = [];
    for (let iz = 0; iz < p.segments; iz++) {
      for (let ix = 0; ix < p.segments; ix++) {
        const a = iz * n + ix, b = a + 1, c = a + n, d = c + 1;
        if ((ix + iz) % 2 === 0) indices.push(a, c, b, b, c, d);
        else indices.push(a, c, d, a, d, b);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (indices instanceof Uint32Array) {
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  } else {
    geometry.setIndex(indices);
  }
  geometry.computeVertexNormals();

  const uvs = new Float32Array(vertCount * 2);
  for (let i = 0; i < vertCount; i++) {
    uvs[i * 2] = positions[i * 3] / p.size + 0.5;
    uvs[i * 2 + 1] = positions[i * 3 + 2] / p.size + 0.5;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));

  const colorTexture = _bakeColorTexture(heights, n, p, min, max, splatmap ?? null);

  return { geometry, colorTexture, heights, gridSize: n, size: p.size, segments: p.segments, minY: min, maxY: max };
}


/** 双线性采样世界高度（x/z 超界钳到边缘） */
function sampleHeight(data: TerrainBuildData, x: number, z: number): number {
  const seg = data.segments;
  const half = data.size / 2;
  const n = data.gridSize;
  const fx = Math.min(seg, Math.max(0, ((x + half) / data.size) * seg));
  const fz = Math.min(seg, Math.max(0, ((z + half) / data.size) * seg));
  const ix = Math.min(n - 2, Math.floor(fx));
  const iz = Math.min(n - 2, Math.floor(fz));
  const tx = fx - ix;
  const tz = fz - iz;
  const h = data.heights;
  const h00 = h[iz * n + ix];
  const h10 = h[iz * n + ix + 1];
  const h01 = h[(iz + 1) * n + ix];
  const h11 = h[(iz + 1) * n + ix + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

/** 地表平坦度（1 = 平地 → 0 = 崖壁；有限差分） */
function sampleSlope(data: TerrainBuildData, x: number, z: number): number {
  const e = data.size / data.segments;
  const hx = sampleHeight(data, x + e, z) - sampleHeight(data, x - e, z);
  const hz = sampleHeight(data, x, z + e) - sampleHeight(data, x, z - e);
  return (2 * e) / Math.sqrt(hx * hx + 4 * e * e + hz * hz);
}

function _splitTerrainGeometry(geometry: THREE.BufferGeometry, size: number, chunks: number): THREE.BufferGeometry[] {
  if (chunks <= 1) return [geometry];

  const pos = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  const origNormal = geometry.getAttribute("normal");
  const index = geometry.getIndex();
  if (!index) return [geometry];

  const chunkSize = size / chunks;
  const half = size / 2;

  const chunkTriArrays: number[][] = [];
  for (let i = 0; i < chunks * chunks; i++) chunkTriArrays.push([]);
  const triCount = index.count / 3;
  for (let t = 0; t < triCount; t++) {
    const a = index.getX(t * 3), b = index.getX(t * 3 + 1), c = index.getX(t * 3 + 2);
    const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const ix = Math.min(chunks - 1, Math.max(0, Math.floor((cx + half) / chunkSize)));
    const iz = Math.min(chunks - 1, Math.max(0, Math.floor((cz + half) / chunkSize)));
    chunkTriArrays[iz * chunks + ix].push(a, b, c);
  }

  const result: THREE.BufferGeometry[] = [];
  for (let ci = 0; ci < chunks * chunks; ci++) {
    const tris = chunkTriArrays[ci];
    if (tris.length === 0) continue;

    const vertMap = new Map<number, number>();
    const newPositions: number[] = [], newUVs: number[] = [], newNormals: number[] = [], newIndices: number[] = [];

    for (let i = 0; i < tris.length; i += 3) {
      for (let j = 0; j < 3; j++) {
        const oldIdx = tris[i + j];
        let newIdx = vertMap.get(oldIdx);
        if (newIdx === undefined) {
          newIdx = newPositions.length / 3;
          vertMap.set(oldIdx, newIdx);
          newPositions.push(pos.getX(oldIdx), pos.getY(oldIdx), pos.getZ(oldIdx));
          if (uv) newUVs.push(uv.getX(oldIdx), uv.getY(oldIdx));
          if (origNormal) newNormals.push(origNormal.getX(oldIdx), origNormal.getY(oldIdx), origNormal.getZ(oldIdx));
        }
        newIndices.push(newIdx);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(newPositions, 3));
    if (newUVs.length > 0) geom.setAttribute("uv", new THREE.Float32BufferAttribute(newUVs, 2));
    if (newNormals.length > 0) geom.setAttribute("normal", new THREE.Float32BufferAttribute(newNormals, 3));
    geom.setIndex(newIndices);
    result.push(geom);
  }

  return result;
}

/**
 * 构建 terrainNode 的渲染网格：烘焙高度场几何 + 颜色纹理材质，拆分 4×4 chunk
 * 供视锥剔除（每 chunk 独立 boundingBox，three.js 自动剔除不可见 chunk）。
 * 返回 { obj, data, settings }；obj 为名为 __terrainMesh 的 Group（含 chunk 子网格）。
 */
export function createTerrain(json: NodeJson): { obj: THREE.Group; data: TerrainBuildData; settings: TerrainSettings } {
  const settings = parseSettings(json.terrain);
  // 地形材质绑定時：用材质图层颜色覆盖地形内置配色 + PBR 参数
  // （materialSettings 为编辑器材质绑定 JSON，结构断言收窄 layers/splatmap/PBR 字段）
  const ms = (json.materialSettings ?? null) as TerrainMaterialSettingsJson | null;
  const ts: TerrainSettings = ms
    ? { ...settings, grassColor: ms.layers?.[0]?.color ?? settings.grassColor,
                   rockColor: ms.layers?.[1]?.color ?? settings.rockColor,
                   snowColor: ms.layers?.[2]?.color ?? settings.snowColor }
    : settings;
  // 材质已绑定：传程序化 splatmap（data=null → 按海拔/坡度 4 层混合）
  const splatmap: SplatmapInput | null = ms
    ? { data: null, width: 0, height: 0,
        layerColors: [
          ms.layers?.[0]?.color ?? 0x6e7253,
          ms.layers?.[1]?.color ?? 0x736a5f,
          ms.layers?.[2]?.color ?? 0xe9ecf0,
          ms.layers?.[3]?.color ?? 0xffffff,
        ] }
    : null;
  // 雕刻偏移层：节点 sculpt 字段（base64 Float32，编辑器笔刷雕刻写入）
  const sculptJson = json.sculpt as SculptJson | null | undefined; // sculpt 为编辑器雕刻层 JSON（data/gridN）
  let sculpt: Float32Array | null = null;
  if (sculptJson && typeof sculptJson.data === "string" && sculptJson.gridN === settings.segments + 1) {
    try {
      const bin = atob(sculptJson.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      sculpt = new Float32Array(bytes.buffer);
    } catch {
      sculpt = null;
    }
  }
  // dem 为 DEM 数据源 JSON（data: base64 归一化高度，gridN 网格边长）
  const data = buildTerrain(ts, splatmap, sculpt, demBaseOf(json.dem as DemJson | null | undefined, settings.heightScale, settings.segments + 1));
  // 分块数随尺寸自适应（与编辑器 SceneSynchronizer 同规则）：≥800 用 8×8
  const chunkGeoms = _splitTerrainGeometry(data.geometry, data.size, data.size >= 800 ? 8 : 4);
  data.geometry.dispose();

  const matMetalness = ms ? (ms.metalness ?? 0) : 0;
  const matRoughness = ms ? (ms.roughness ?? 0.95) : 0.95;
  const material = new THREE.MeshStandardMaterial({ map: data.colorTexture, metalness: matMetalness, roughness: matRoughness });
  const group = new THREE.Group();
  group.name = "__terrainMesh";
  for (const geom of chunkGeoms) {
    const chunkMesh = new THREE.Mesh(geom, material);
    chunkMesh.castShadow = true;
    chunkMesh.receiveShadow = true;
    chunkMesh.userData.terrainHeights = data.heights;
    chunkMesh.userData.terrainGridSize = data.gridSize;
    chunkMesh.userData.terrainSize = data.size;
    group.add(chunkMesh);
  }
  group.userData.terrainMinY = data.minY;
  group.userData.terrainMaxY = data.maxY;
  return { obj: group, data, settings };
}

/**
 * 异步回填地形 splatmap：对绑定了地形材质且材质引用了 splatmap 的地形节点，
 * 加载 splatmap 图片像素数据，按 RGBA 权重重新烘焙颜色纹理并替换材质 map。
 * 与 applyMeshTextures 同一异步 pass（buildSceneTree 后执行）。
 * terrains = buildSceneTree 收集的 [{ json, obj, data, settings }]。
 */
export async function applyTerrainSplatmaps(terrains: SceneTerrainEntry[]): Promise<void> {
  await Promise.all(
    terrains.map(async (entry) => {
      // materialSettings 为编辑器材质绑定 JSON（结构断言收窄 splatmap/layers 字段）
      const ms = entry.json?.materialSettings as TerrainMaterialSettingsJson | undefined;
      const rel = ms?.splatmap;
      if (!rel || typeof rel !== "string") return;

      let bmp: ImageBitmap | undefined;
      try {
        bmp = await resourceLoader.loadImageBitmap(rel, false);
      } catch {
        return;
      }
      if (!bmp) return;

      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return;
      ctx2d.drawImage(bmp, 0, 0);
      const imgData = ctx2d.getImageData(0, 0, bmp.width, bmp.height);

      const layerColors = [
        ms.layers?.[0]?.color ?? 0x6e7253,
        ms.layers?.[1]?.color ?? 0x736a5f,
        ms.layers?.[2]?.color ?? 0xe9ecf0,
        ms.layers?.[3]?.color ?? 0xffffff,
      ];
      const splatmap: SplatmapInput = {
        data: new Uint8Array(imgData.data.buffer.slice(0)),
        width: bmp.width,
        height: bmp.height,
        layerColors,
      };

      // buildSceneTree 地形条目 data/settings 由 createTerrain 产出（SceneTerrainEntry 声明为 unknown）
      const d = entry.data as TerrainBuildData;
      const p = entry.settings as TerrainSettings;
      const newTex = _bakeColorTexture(d.heights, d.gridSize, p, d.minY, d.maxY, splatmap);

      const terrainGroup = entry.obj.children.find((c) => c.name === "__terrainMesh");
      if (!terrainGroup) return;
      // chunk 子网格为 Mesh（_splitTerrainGeometry 产物挂 MeshStandardMaterial）
      const mat = (terrainGroup.children[0] as THREE.Mesh | undefined)?.material as THREE.MeshStandardMaterial | undefined;
      if (!mat) return;
      if (mat.map) mat.map.dispose();
      mat.map = newTex;
      mat.needsUpdate = true;
    }),
  );
}

/**
 * 地形运行时系统（贴地采样 API；脚本经 TerrainNode SDK / engine 寻址）。
 * entries = buildSceneTree 收集的 [{ json, obj, data }]。
 */
export function createTerrains(entries: SceneTerrainEntry[]): {
  sampleHeight(nodeId: string, x: unknown, z: unknown): number;
  sampleSlope(nodeId: string, x: unknown, z: unknown): number;
  settingsOf(nodeId: string): TerrainSettings | null;
} {
  const byId = new Map<string, SceneTerrainEntry>();
  for (const e of entries) {
    const id = typeof e.json?.id === "string" ? e.json.id : "";
    if (id) byId.set(id, e);
  }
  return {
    /** 世界高度采样（节点本地 x/z；节点仅平移时即世界坐标） */
    sampleHeight(nodeId: string, x: unknown, z: unknown): number {
      const e = byId.get(nodeId);
      return e ? sampleHeight(e.data as TerrainBuildData, num(x, 0), num(z, 0)) : 0;
    },
    /** 地表平坦度采样（1 = 平地 → 0 = 崖壁） */
    sampleSlope(nodeId: string, x: unknown, z: unknown): number {
      const e = byId.get(nodeId);
      return e ? sampleSlope(e.data as TerrainBuildData, num(x, 0), num(z, 0)) : 1;
    },
    settingsOf(nodeId: string): TerrainSettings | null {
      const e = byId.get(nodeId);
      // settings 由 createTerrain 的 parseSettings 收敛（SceneTerrainEntry 声明为 unknown）
      return e ? { ...(e.settings as TerrainSettings) } : null;
    },
  };
}
