// ---------------------------------------------------------------------------
// 程序化地形生成（编辑器侧；three BufferGeometry 输出）。
// 算法语义移植自 three.js 示例 generators/TerrainGenerator.js：
// - 高度场：ImprovedNoise 导数阻尼分形（fake erosion，脊锐谷平）+ 低频域扭曲
//   （山脊蜿蜒）+ 谷地压平幂曲线 + 海平面下移；
// - 热侵蚀（talus）：超过休止角的坡面逐 pass 塌落，消除分形针尖；
// - 网格：逐 quad 交替对角线的菱形三角化，避免单向纹理感；
// - 着色：按海拔/坡度在 CPU 烘焙 128×128 颜色纹理（草/林/岩/碎石/雪带 + 明度扰动），
//   MeshStandardMaterial(map) 直接消费，WebGL/WebGPU 双后端可用。
// 播放器侧同语义实现见 public/engine/runtime/terrain.mjs（两边改参数需同步）。
// ---------------------------------------------------------------------------
import * as THREE from "three";
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";
import { cloneTerrainSettings, type TerrainSettings } from "./types";
import { simplifyTerrainMesh } from "./simplify";

/** 确定性 PRNG（mulberry32）：同种子恒定序列 */
function createRandom(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 整数格点哈希（0..1；表面色扰动的确定性值噪声用） */
function hash2(ix: number, iz: number, seed: number): number {
  let h = (ix * 374761393 + iz * 668265263 + seed * 1442695) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 平滑值噪声（-1..1；世界坐标驱动，颗粒/斑块扰动） */
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

/**
 * 构建某 seed 的高度函数 height(worldX, worldZ)。
 * ImprovedNoise 置换表固定 → 种子只位移采样窗口（平移 + 逐层 z 切片），
 * 由 PRNG 抽取以去相关。
 */
function heightField(p: TerrainSettings): (x: number, z: number) => number {
  const perlin = new ImprovedNoise();
  const random = createRandom(p.seed);
  const offsetX = random() * 256;
  const offsetZ = random() * 256;
  const slice = random() * 256;
  const { frequency, octaves, lacunarity, gain, erosion, warp, valleyBias, seaLevel, heightScale } = p;

  // 低频分形和（域扭曲场）
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

  // 导数阻尼分形和：坡度已陡处抑制后继层（脊更脆、谷更顺），逐层旋转采样域破除轴向网格
  function eroded(x: number, z: number): number {
    let sum = 0, amp = 1, dX = 0, dZ = 0, px = x, pz = z, freq = 1;
    const e = 0.004; // 有限差分步长（噪声单位）
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
      // 采样域旋转 ~37°（矩阵 [0.8 -0.6; 0.6 0.8]）
      const rx = 0.8 * px - 0.6 * pz;
      pz = 0.6 * px + 0.8 * pz;
      px = rx;
      freq *= lacunarity;
      amp *= gain;
    }
    return sum * 0.5 + 0.5;
  }

  return function (worldX: number, worldZ: number): number {
    const x = worldX * frequency;
    const z = worldZ * frequency;
    // 域扭曲：山脊/谷地蜿蜒而非直线
    const wx = x + warp * warpField(x + 1.3, z + 7.2, slice + 40);
    const wz = z + warp * warpField(x + 5.2, z + 1.3, slice + 70);
    // 幂曲线压低谷地成平地
    const h = Math.pow(Math.min(eroded(wx, wz) * 1.1, 1), valleyBias);
    return (h - seaLevel) * heightScale;
  };
}

/**
 * 热侵蚀（talus）：悬空超过休止角落差的下坡面逐 pass 按比例塌落；
 * delta 缓冲保证物料守恒（结果与遍历顺序无关）。
 */
function thermalErode(h: Float32Array, n: number, cellSize: number, talus: number, passes: number): void {
  const drop = talus * cellSize;
  const carry = 0.5; // 每 pass 挪走最陡悬空量的比例（≤0.5 稳定）
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

// —— 顶点色烘焙辅助（sRGB hex → 线性 RGB）——
function hexToLinear(hex: number): [number, number, number] {
  const c = new THREE.Color();
  c.setHex(hex & 0xffffff); // ColorManagement 开启时自动 sRGB → 线性
  return [c.r, c.g, c.b];
}

function mix3(a: number[], b: number[], t: number): void {
  a[0] += (b[0] - a[0]) * t;
  a[1] += (b[1] - a[1]) * t;
  a[2] += (b[2] - a[2]) * t;
}

function scale3(a: number[], f: number): void {
  a[0] = Math.min(1, a[0] * f);
  a[1] = Math.min(1, a[1] * f);
  a[2] = Math.min(1, a[2] * f);
}

/** 一次地形烘焙结果：几何 + 颜色纹理 + 采样数据 */
export interface TerrainBuild {
  geometry: THREE.BufferGeometry;
  /** 表面配色纹理（128×128 RGBA，世界坐标驱动；MeshStandardMaterial.map 消费） */
  colorTexture: THREE.DataTexture;
  /** 烘焙后的高度网格（行主序，N×N） */
  heights: Float32Array;
  /** 网格边长（N = segments + 1） */
  gridSize: number;
  size: number;
  segments: number;
  minY: number;
  maxY: number;
}

/** 双线性采样高度场（世界坐标 → 高度；内部烘焙用） */
function sampleHeightAt(h: Float32Array, n: number, size: number, wx: number, wz: number): number {
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

/**
 * 烘焙表面配色纹理（256×256 RGBA，世界坐标驱动）。
 * 每纹素按世界坐标从高度场采样高度 + 数值微分法线，执行海拔/坡度色带逻辑。
 * 烘焙后 3×3 箱式模糊 + mipmap，消除锯齿；WebGL/WebGPU 双后端通用（map 内置）。
 */
function bakeColorTexture(
  heights: Float32Array, n: number, p: TerrainSettings,
  min: number, max: number,
): THREE.DataTexture {
  const res = 256;
  const data = new Uint8Array(res * res * 4);
  const hSpan = Math.max(1e-6, max - min);
  const cellSize = p.size / (n - 1);

  const grass = hexToLinear(p.grassColor);
  const rock = hexToLinear(p.rockColor);
  const snow = hexToLinear(p.snowColor);
  const dryGrass = [...grass]; scale3(dryGrass, 1.28);
  const forest = [...grass]; scale3(forest, 0.55);
  const scree = [...rock]; scale3(scree, 1.15);
  const lichen = [...rock]; mix3(lichen, grass, 0.35);
  const snowDeep = [...snow]; scale3(snowDeep, 0.88);
  const colorSeed = p.seed & 0xffff;
  const tmp = [0, 0, 0];

  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const wx = ((i / (res - 1)) - 0.5) * p.size;
      const wz = ((j / (res - 1)) - 0.5) * p.size;
      const wy = sampleHeightAt(heights, n, p.size, wx, wz);

      const e = cellSize * 0.5;
      const dx = (sampleHeightAt(heights, n, p.size, wx + e, wz) - sampleHeightAt(heights, n, p.size, wx - e, wz)) / (2 * e);
      const dz = (sampleHeightAt(heights, n, p.size, wx, wz + e) - sampleHeightAt(heights, n, p.size, wx, wz - e)) / (2 * e);
      const ny = 1 / Math.sqrt(dx * dx + 1 + dz * dz);

      const altitude = Math.min(1, Math.max(0, (wy - min) / hSpan));
      const flatness = Math.min(1, Math.max(0, ny));
      const steep = 1 - flatness;
      const detail = valueNoise2(wx * 0.05, wz * 0.05, colorSeed);
      const grain = valueNoise2(wx * 0.18, wz * 0.18, colorSeed + 7);
      const macro = valueNoise2(wx * 0.012, wz * 0.012, colorSeed + 13);

      const surface = [...grass];
      mix3(surface, dryGrass, smoothstep(0.15, 0.75, macro) * smoothstep(0.22, 0.5, altitude));
      mix3(surface, forest, smoothstep(0.16, 0.34, altitude) * smoothstep(0.5, 0.72, flatness) * 0.75);
      const rockShade = [...rock];
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

      const idx = (j * res + i) * 4;
      data[idx] = Math.round(surface[0] * 255);
      data[idx + 1] = Math.round(surface[1] * 255);
      data[idx + 2] = Math.round(surface[2] * 255);
      data[idx + 3] = 255;
    }
  }

  // 3×3 箱式模糊（平滑颜色过渡，消除锯齿）
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

/**
 * 按设置烘焙地形几何（位置 + UV + 菱形三角索引 + 顶点法线 + 颜色纹理）。
 * 每次调用都产出全新几何和纹理（调用方负责释放旧资源）。
 */
export function buildTerrain(settings: TerrainSettings): TerrainBuild {
  const p = cloneTerrainSettings(settings);
  const n = p.segments + 1;
  const half = p.size / 2;

  const coord = new Array<number>(n);
  for (let i = 0; i < n; i++) coord[i] = (i / p.segments) * p.size - half;

  // 烘焙高度网格（保留供采样）
  const height = heightField(p);
  const heights = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      heights[iz * n + ix] = height(coord[ix], coord[iz]);
    }
  }

  // 热侵蚀：超过休止角的坡面塌落，消除分形针尖
  if (p.talusPasses > 0) thermalErode(heights, n, p.size / p.segments, p.talus, p.talusPasses);

  // 统计高度范围
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n * n; i++) {
    const y = heights[i];
    if (y < min) min = y;
    if (y > max) max = y;
  }

  // 自适应四叉树网格简化（segments 是 2 的幂且 ≥ 4 时启用）
  const hSpan = Math.max(1e-6, max - min);
  const simplified = simplifyTerrainMesh(heights, n, hSpan * 0.05);

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
    const idx: number[] = [];
    for (let iz = 0; iz < p.segments; iz++) {
      for (let ix = 0; ix < p.segments; ix++) {
        const a = iz * n + ix;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        if ((ix + iz) % 2 === 0) idx.push(a, c, b, b, c, d);
        else idx.push(a, c, d, a, d, b);
      }
    }
    indices = idx;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (indices instanceof Uint32Array) {
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  } else {
    geometry.setIndex(indices);
  }
  geometry.computeVertexNormals();

  // —— UV 生成（世界坐标 → 纹理坐标）——
  const uvs = new Float32Array(vertCount * 2);
  for (let i = 0; i < vertCount; i++) {
    uvs[i * 2] = positions[i * 3] / p.size + 0.5;
    uvs[i * 2 + 1] = positions[i * 3 + 2] / p.size + 0.5;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));

  // —— 颜色纹理烘焙（128×128，世界坐标驱动；替代顶点色，分辨率独立于网格）——
  const colorTexture = bakeColorTexture(heights, n, p, min, max);

  return { geometry, colorTexture, heights, gridSize: n, size: p.size, segments: p.segments, minY: min, maxY: max };
}

/** 双线性采样世界高度（x/z 超界钳到边缘；build 结果上调用） */
export function sampleTerrainHeight(b: TerrainBuild, x: number, z: number): number {
  const seg = b.segments;
  const half = b.size / 2;
  const n = b.gridSize;
  const fx = Math.min(seg, Math.max(0, ((x + half) / b.size) * seg));
  const fz = Math.min(seg, Math.max(0, ((z + half) / b.size) * seg));
  const ix = Math.min(n - 2, Math.floor(fx));
  const iz = Math.min(n - 2, Math.floor(fz));
  const tx = fx - ix;
  const tz = fz - iz;
  const h = b.heights;
  const h00 = h[iz * n + ix];
  const h10 = h[iz * n + ix + 1];
  const h01 = h[(iz + 1) * n + ix];
  const h11 = h[(iz + 1) * n + ix + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}
/**
 * 将简化后的地形几何按空间边界拆分成 M×M 个子几何，供视锥剔除。
 * 每个三角形按质心分配到一个 chunk；跨 chunk 三角形不分割（无裂缝）。
 */
export function splitTerrainGeometry(
  geometry: THREE.BufferGeometry,
  size: number,
  chunks: number,
): THREE.BufferGeometry[] {
  if (chunks <= 1) return [geometry];

  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute | undefined;
  const origNormal = geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const index = geometry.getIndex();
  if (!index) return [geometry];

  const chunkSize = size / chunks;
  const half = size / 2;

  const chunkTriArrays: number[][] = Array.from({ length: chunks * chunks }, () => []);
  const triCount = index.count / 3;
  for (let t = 0; t < triCount; t++) {
    const a = index.getX(t * 3);
    const b = index.getX(t * 3 + 1);
    const c = index.getX(t * 3 + 2);
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
    const newPositions: number[] = [];
    const newUVs: number[] = [];
    const newNormals: number[] = [];
    const newIndices: number[] = [];

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
