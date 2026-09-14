// 地形（terrainNode）构建：程序化高度场地形（位置 + 顶点色 + 菱形三角索引）。
// 算法语义移植自 three.js 示例 TerrainGenerator.js（导数阻尼分形 + 域扭曲 +
// 热侵蚀 + 菱形网格 + 海拔/坡度色带），与编辑器 framework/terrain/generate.ts
// 同一套参数与算法（两边改参数需同步）。表面配色在 CPU 烘焙为顶点色，
// MeshStandardMaterial(vertexColors) 在 WebGL/WebGPU 双后端一致可用。
// 脚本经 engine SDK 的 TerrainNode.sampleHeight / sampleSlope 贴地采样。
import * as THREE from "../core/three.module.min.js";
import { num } from "../core/utils";

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

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function grad(hash, x, y, z) {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

class ImprovedNoise {
  noise(x, y, z) {
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
  segments: 192,
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

const LIMITS = {
  seed: [1, 999999],
  size: [10, 2000],
  segments: [16, 256],
  heightScale: [0, 500],
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

function clampN(v, lo, hi, fb) {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fb;
  return Math.min(hi, Math.max(lo, n));
}

function clampI(v, lo, hi, fb) {
  return Math.round(clampN(v, lo, hi, fb));
}

function clampHex(v, fb) {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fb;
  return Math.min(0xffffff, Math.max(0, Math.round(n))) & 0xffffff;
}

/** 收敛地形设置（缺字段/越界回默认或钳进取值域；与编辑器 parse 同边界） */
function parseSettings(v) {
  const o = v && typeof v === "object" ? v : {};
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
function createRandom(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function heightField(p) {
  const perlin = new ImprovedNoise();
  const random = createRandom(p.seed);
  const offsetX = random() * 256;
  const offsetZ = random() * 256;
  const slice = random() * 256;
  const { frequency, octaves, lacunarity, gain, erosion, warp, valleyBias, seaLevel, heightScale } = p;

  function warpField(x, z, zr) {
    let freq = 1, amp = 1, sum = 0, norm = 0;
    for (let i = 0; i < 2; i++) {
      sum += amp * perlin.noise(x * freq + offsetX, z * freq + offsetZ, zr + i * 1.7);
      norm += amp;
      freq *= lacunarity;
      amp *= gain;
    }
    return sum / norm;
  }

  function eroded(x, z) {
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
function thermalErode(h, n, cellSize, talus, passes) {
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
function hash2(ix, iz, seed) {
  let h = (ix * 374761393 + iz * 668265263 + seed * 1442695) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise2(x, z, seed) {
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

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** sRGB hex → 线性 RGB（three 默认把 hex 视作 sRGB；顶点色按线性消费，需先转换） */
function hexToLinear(hex) {
  const c = new THREE.Color();
  c.setHex(hex & 0xffffff);
  return [c.r, c.g, c.b];
}

function mix3(a, b, t) {
  a[0] += (b[0] - a[0]) * t;
  a[1] += (b[1] - a[1]) * t;
  a[2] += (b[2] - a[2]) * t;
}

function scale3(a, f) {
  a[0] = Math.min(1, a[0] * f);
  a[1] = Math.min(1, a[1] * f);
  a[2] = Math.min(1, a[2] * f);
}

// ---------------------------------------------------------------------------
// 构建
// ---------------------------------------------------------------------------

/**
 * 烘焙地形几何与采样数据（位置/顶点色/法线/菱形索引）。
 * 返回 { geometry, heights, gridSize, size, segments, minY, maxY }。
 */
function buildTerrain(p) {
  const n = p.segments + 1;
  const half = p.size / 2;

  const coord = new Array(n);
  for (let i = 0; i < n; i++) coord[i] = (i / p.segments) * p.size - half;

  const height = heightField(p);
  const heights = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      heights[iz * n + ix] = height(coord[ix], coord[iz]);
    }
  }

  if (p.talusPasses > 0) thermalErode(heights, n, p.size / p.segments, p.talus, p.talusPasses);

  const positions = new Float32Array(n * n * 3);
  let min = Infinity;
  let max = -Infinity;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const o = iz * n + ix;
      const y = heights[o];
      positions[o * 3] = coord[ix];
      positions[o * 3 + 1] = y;
      positions[o * 3 + 2] = coord[iz];
      if (y < min) min = y;
      if (y > max) max = y;
    }
  }

  const indices = [];
  for (let iz = 0; iz < p.segments; iz++) {
    for (let ix = 0; ix < p.segments; ix++) {
      const a = iz * n + ix;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      if ((ix + iz) % 2 === 0) indices.push(a, c, b, b, c, d);
      else indices.push(a, c, d, a, d, b);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const normalAttr = geometry.getAttribute("normal");
  const colors = new Float32Array(n * n * 3);
  const grass = hexToLinear(p.grassColor);
  const rock = hexToLinear(p.rockColor);
  const snow = hexToLinear(p.snowColor);
  const dryGrass = [...grass];
  scale3(dryGrass, 1.28);
  const forest = [...grass];
  scale3(forest, 0.55);
  const scree = [...rock];
  scale3(scree, 1.15);
  const lichen = [...rock];
  mix3(lichen, grass, 0.35);
  const snowDeep = [...snow];
  scale3(snowDeep, 0.88);
  const hSpan = Math.max(1e-6, max - min);
  const colorSeed = p.seed & 0xffff;
  const tmp = [0, 0, 0];
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const o = iz * n + ix;
      const wx = positions[o * 3];
      const wy = positions[o * 3 + 1];
      const wz = positions[o * 3 + 2];
      const altitude = Math.min(1, Math.max(0, (wy - min) / hSpan));
      const flatness = Math.min(1, Math.max(0, normalAttr.getY(o)));
      const steep = 1 - flatness;
      const detail = valueNoise2(wx * 0.05, wz * 0.05, colorSeed);
      const grain = valueNoise2(wx * 0.18, wz * 0.18, colorSeed + 7);
      const macro = valueNoise2(wx * 0.012, wz * 0.012, colorSeed + 13);

      const surface = [...grass];
      mix3(surface, dryGrass, smoothstep(0.15, 0.75, macro) * smoothstep(0.22, 0.5, altitude));
      mix3(surface, forest, smoothstep(0.16, 0.34, altitude) * smoothstep(0.5, 0.72, flatness) * 0.75);
      const rockShade = [...rock];
      const strata =
        (Math.sin(wy * 0.5 + detail * 3 + macro * 4) * 0.6 + Math.sin(wy * 1.4 + grain * 2) * 0.4) * 0.5 + 0.5;
      const lichenMask =
        smoothstep(0.45, 0.72, grain) * smoothstep(0.62, 0.32, steep) * smoothstep(0.66, 0.34, altitude);
      mix3(rockShade, lichen, lichenMask * 0.45);
      scale3(rockShade, strata * 0.36 + 0.8);
      mix3(surface, rockShade, smoothstep(0.46, 0.64, altitude + detail * 0.06));
      mix3(surface, rockShade, smoothstep(0.34, 0.62, steep));
      const screeMask = smoothstep(0.42, 0.7, steep) * smoothstep(0.35, 0.7, flatness) * (detail * 0.5 + 0.5);
      mix3(surface, scree, screeMask * 0.5);
      const snowMask =
        smoothstep(0.56, 0.78, altitude + detail * 0.08 + grain * 0.05) * smoothstep(0.3, 0.6, flatness);
      tmp[0] = snow[0];
      tmp[1] = snow[1];
      tmp[2] = snow[2];
      mix3(tmp, snowDeep, smoothstep(0.2, 0.7, grain) * 0.6);
      mix3(surface, tmp, snowMask);
      const cavity = smoothstep(0.24, 0.06, altitude) * flatness;
      scale3(surface, 1 - cavity * 0.32);
      scale3(surface, (macro * 0.5 + 0.5) * 0.3 + 0.84);
      scale3(surface, (grain * 0.5 + 0.5) * 0.12 + 0.94);

      colors[o * 3] = surface[0];
      colors[o * 3 + 1] = surface[1];
      colors[o * 3 + 2] = surface[2];
    }
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  return { geometry, heights, gridSize: n, size: p.size, segments: p.segments, minY: min, maxY: max };
}

/** 双线性采样世界高度（x/z 超界钳到边缘） */
function sampleHeight(data, x, z) {
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
function sampleSlope(data, x, z) {
  const e = data.size / data.segments;
  const hx = sampleHeight(data, x + e, z) - sampleHeight(data, x - e, z);
  const hz = sampleHeight(data, x, z + e) - sampleHeight(data, x, z - e);
  return (2 * e) / Math.sqrt(hx * hx + 4 * e * e + hz * hz);
}

/**
 * 构建 terrainNode 的渲染网格：烘焙高度场几何 + 顶点色材质（默认投射/接收阴影，
 * 与网格节点同策略）。返回 { obj, data, settings }；obj 为名为 __terrainMesh 的
 * 网格（由 nodes.mjs 挂到节点 Group 下，与编辑器同结构），data 供
 * createTerrains 的贴地采样 API 使用。
 */
export function createTerrain(json) {
  const settings = parseSettings(json.terrain);
  const data = buildTerrain(settings);
  const mesh = new THREE.Mesh(
    data.geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, roughness: 0.95 }),
  );
  mesh.name = "__terrainMesh";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.terrainMinY = data.minY;
  mesh.userData.terrainMaxY = data.maxY;
  return { obj: mesh, data, settings };
}

/**
 * 地形运行时系统（贴地采样 API；脚本经 TerrainNode SDK / engine 寻址）。
 * entries = buildSceneTree 收集的 [{ json, obj, data }]。
 */
export function createTerrains(entries) {
  const byId = new Map();
  for (const e of entries) {
    const id = typeof e.json?.id === "string" ? e.json.id : "";
    if (id) byId.set(id, e);
  }
  return {
    /** 世界高度采样（节点本地 x/z；节点仅平移时即世界坐标） */
    sampleHeight(nodeId, x, z) {
      const e = byId.get(nodeId);
      return e ? sampleHeight(e.data, num(x, 0), num(z, 0)) : 0;
    },
    /** 地表平坦度采样（1 = 平地 → 0 = 崖壁） */
    sampleSlope(nodeId, x, z) {
      const e = byId.get(nodeId);
      return e ? sampleSlope(e.data, num(x, 0), num(z, 0)) : 1;
    },
    settingsOf(nodeId) {
      const e = byId.get(nodeId);
      return e ? { ...e.settings } : null;
    },
  };
}
