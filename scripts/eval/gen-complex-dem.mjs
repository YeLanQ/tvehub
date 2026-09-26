// 合成复杂 DEM 生成器（虚拟但地物特征齐全）：
//   斜贯山脊带（含垭口）+ 蜿蜒河谷下切 + 火山口（环形山+坑底）+ 三级台地 +
//   湖盆 + 东南缓倾平原 + 分形丘陵基底 + 排水坡降。
// 输出 Esri ASCII Grid（北行序），浮点保留 1 位小数（真实 DEM 精度口径）。
//   用法：node scripts/eval/gen-complex-dem.mjs [输出路径]
//   默认输出 .tmp/res/complex-dem.asc（512×512，cellsize 30m ≈ 15.4km×15.4km）
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = process.argv[2] ?? ".tmp/res/complex-dem.asc";
const N = 512;
const CELL = 30;
const XLL = 478020; // 伪 UTM 东向坐标
const YLL = 4418560; // 伪 UTM 北向坐标
const SEED = 20260926;

/** mulberry32：确定性 PRNG（种子重现） */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
mulberry32(SEED); // 预热一次固定内部状态（与值噪声晶格哈希配合可重现）

/** 整数晶格哈希 → [0,1)：值噪声的确定性基底 */
function hash2(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

/** 双线性插值值噪声 */
function valueNoise(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = smooth(fx);
  const sy = smooth(fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  const top = a + (b - a) * sx;
  const bottom = c + (d - c) * sx;
  return top + (bottom - top) * sy;
}

/** 分形布朗运动（归一化 0..1） */
function fbm(x, y, seed, octaves, lac = 2.03, gain = 0.5) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 101);
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / norm;
}

/** 山脊噪声（ridged multifractal：|n| 取反平方，峰锐谷缓） */
function ridged(x, y, seed, octaves, lac = 2.07, gain = 0.5) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(valueNoise(x * freq, y * freq, seed + o * 977) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / norm;
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 单点高程（u,v ∈ 0..1；v=0 为北） */
function elevation(u, v) {
  // 基底：分形丘陵 + 自西向东排水坡降
  let h = 205 + 240 * fbm(u * 3.1, v * 3.7, SEED + 1, 5) + 70 * fbm(u * 9.3, v * 11.1, SEED + 2, 4);
  h += 150 * (1 - u);

  // 山脊带：沿反对角线走廊，低频掩模造垭口/鞍部（走向各向异性）
  const band = Math.exp(-(((u - v) * 3.4) ** 2));
  const pass = 0.45 + 0.55 * fbm(u * 1.4 + 3, v * 1.4 + 8, SEED + 3, 2);
  h += 1550 * ridged(u * 2.3 + 7, v * 2.3 + 3, SEED + 4, 5) * band * pass;

  // 河谷：蜿蜒路径下切（两端收敛淡出）
  const riverX = 0.16 + 0.1 * Math.sin(v * 9.2) + 0.055 * Math.sin(v * 23 + 1.7);
  const distRiver = Math.abs(u - riverX);
  const fade = Math.sin(v * Math.PI);
  h -= 115 * Math.exp(-((distRiver / 0.035) ** 2)) * fade;

  // 火山口（0.30, 0.34）：外锥 + 环形山缘 + 内坑
  {
    const r = Math.hypot(u - 0.3, (v - 0.34) * 1.08) / 0.11;
    if (r < 1.7) {
      const rim = Math.exp(-((r - 1) ** 2) / 0.045) * 185;
      const cone = Math.max(0, 1 - r) * 115;
      const pit = r < 0.48 ? (1 - r / 0.48) ** 2 * -95 : 0;
      h += rim + cone + pit;
    }
  }

  // 三级台地（0.74, 0.70）：平顶山_quantize + 缓坡缘
  {
    const r = Math.hypot((u - 0.74) * 1.05, v - 0.7) / 0.13;
    if (r < 1.3) {
      const mask = 1 - smoothstep(0.82, 1.18, r);
      const terrace = Math.floor(Math.max(0, 1 - r) * 3.3) / 3.3;
      h += mask * (110 + 250 * terrace);
    }
  }

  // 湖盆（0.52, 0.16）：高斯凹陷压到水下
  {
    const g = Math.exp(-((((u - 0.52) * 9) ** 2 + ((v - 0.16) * 9) ** 2)));
    h -= 58 * Math.min(1, g * 1.7);
  }

  // 东南象限冲积平原：压平 + 微起伏
  {
    const plain = smoothstep(0.45, 0.85, (u + (1 - v)) / 2);
    h = h * (1 - 0.62 * plain) + (185 + 26 * fbm(u * 6, v * 6, SEED + 5, 3)) * 0.62 * plain;
  }

  return Math.max(2, Math.min(3200, h));
}

// —— 生成（ASC 行序 = 北 → 南）——
const rows = [];
let min = Infinity;
let max = -Infinity;
let sum = 0;
for (let r = 0; r < N; r++) {
  const v = r / (N - 1);
  const vals = new Array(N);
  for (let c = 0; c < N; c++) {
    const u = c / (N - 1);
    const h = Math.round(elevation(u, v) * 10) / 10;
    vals[c] = h.toFixed(1);
    if (h < min) min = h;
    if (h > max) max = h;
    sum += h;
  }
  rows.push(vals.join(" "));
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const header = [`ncols ${N}`, `nrows ${N}`, `xllcorner ${XLL}`, `yllcorner ${YLL}`, `cellsize ${CELL}`, `nodata_value -9999`];
fs.writeFileSync(OUT, header.join("\n") + "\n" + rows.join("\n") + "\n", "utf8");

const st = fs.statSync(OUT);
console.log(
  `已生成 ${OUT}\n` +
    `  网格 ${N}×${N} · cellsize ${CELL}m · 覆盖 ${((N * CELL) / 1000).toFixed(1)}km × ${((N * CELL) / 1000).toFixed(1)}km\n` +
    `  高程 ${min.toFixed(1)} … ${max.toFixed(1)} m · 均值 ${(sum / (N * N)).toFixed(1)} m · 大小 ${(st.size / 1048576).toFixed(2)} MB\n` +
    `  地物：山脊带(含垭口) / 蜿蜒河谷 / 火山口(环形山+坑底) / 三级台地 / 湖盆 / 冲积平原 / 排水坡降`,
);
