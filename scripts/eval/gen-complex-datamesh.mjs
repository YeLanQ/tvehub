// 合成复杂"数据化网格"生成器：(3,7) 环面纽结管体（闭合流形，索引化）。
//   - 曲线：环面结 (p=3, q=7)，中心线严格周期闭合；
//   - 管体：沿曲线扫掠圆环，帧 = 环面表面法向 N（与切向恒正交，天然无扭转/
//     无和乐闭合误差，接缝零错位）+ B = T×N；管径沿程调制（整数频率谐波，闭合）；
//   - 输出：positions/indices/normals/uvs 全量数组（仓库 MeshNode source=data
//     的 .json 显式网格格式，法线解析提供、UV 全铺）。
//   用法：node scripts/eval/gen-complex-datamesh.mjs [输出路径]
//   默认输出 .tmp/res/complex-mesh.json
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = process.argv[2] ?? ".tmp/res/complex-mesh.json";
const P = 3; // 环面结绕轴圈数
const Q = 7; // 环面结绕管芯圈数
const SEGMENTS = 720; // 沿曲线环数
const RING = 36; // 每环顶点数
const MAJOR = 10; // 环面主半径
const MINOR = 4.2; // 环面管芯半径
const TUBE = 1.5; // 基础管径
const DEC = 3; // 坐标小数位

const V = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

/** 环面结中心线（t ∈ [0,2π)，严格周期） */
function centerline(t) {
  const th = P * t;
  const ph = Q * t;
  const w = MAJOR + MINOR * Math.cos(ph);
  return [w * Math.cos(th), w * Math.sin(th), MINOR * Math.sin(ph) * 1.15];
}

/** 环面表面单位法向（曲线恒在该面上 → 与切向正交；周期函数 → 帧闭合无缝） */
function frameNormal(t) {
  const th = P * t;
  const ph = Q * t;
  return V.norm([Math.cos(ph) * Math.cos(th), Math.cos(ph) * Math.sin(th), Math.sin(ph)]);
}

/** 管径调制（整数频率谐波 → 闭合；min 护栏防自交） */
function tubeRadius(t) {
  const r = TUBE * (1 + 0.26 * Math.sin(9 * t) + 0.16 * Math.sin(23 * t + 1.3) + 0.1 * Math.sin(5 * t + 0.4));
  return Math.max(0.55, r);
}

const positions = [];
const normals = [];
const uvs = [];
const indices = [];
const TWO_PI = Math.PI * 2;

for (let s = 0; s < SEGMENTS; s++) {
  const t = (s / SEGMENTS) * TWO_PI;
  const eps = 1e-4;
  const T = V.norm(V.sub(centerline(t + eps), centerline(t - eps)));
  const N = frameNormal(t);
  const B = V.norm(V.cross(T, N)); // 右手系 N×B=T（管面向外的绕向依据）
  const C = centerline(t);
  const rho = tubeRadius(t);
  for (let j = 0; j < RING; j++) {
    const psi = (j / RING) * TWO_PI;
    const radial = V.add(V.scale(N, Math.cos(psi)), V.scale(B, Math.sin(psi)));
    const p = V.add(C, V.scale(radial, rho));
    positions.push(p[0], p[1], p[2]);
    normals.push(radial[0], radial[1], radial[2]);
    uvs.push(Number((s / SEGMENTS).toFixed(4)), Number((j / RING).toFixed(4)));
  }
}

const r3 = (x) => Number(x.toFixed(DEC));
for (let i = 0; i < positions.length; i++) positions[i] = r3(positions[i]);
for (let i = 0; i < normals.length; i++) normals[i] = r3(normals[i]);

// 索引：相邻环四边形 ×2 三角形；环向/纵向均取模闭合（绕向外侧，见帧构造）
for (let s = 0; s < SEGMENTS; s++) {
  const s2 = (s + 1) % SEGMENTS;
  for (let j = 0; j < RING; j++) {
    const j2 = (j + 1) % RING;
    const a = s * RING + j;
    const b = s2 * RING + j;
    const c = s2 * RING + j2;
    const d = s * RING + j2;
    indices.push(a, d, c, a, c, b);
  }
}

const vc = SEGMENTS * RING;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ positions, indices, normals, uvs }));
const st = fs.statSync(OUT);
let mn = [Infinity, Infinity, Infinity];
let mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < vc; i++) {
  for (let k = 0; k < 3; k++) {
    const v = positions[i * 3 + k];
    if (v < mn[k]) mn[k] = v;
    if (v > mx[k]) mx[k] = v;
  }
}
console.log(
  `已生成 ${OUT}\n` +
    `  顶点 ${vc} · 三角形 ${indices.length / 3} · 环 ${SEGMENTS}×${RING} · 大小 ${(st.size / 1048576).toFixed(2)} MB\n` +
    `  包围盒 x ${mn[0]}..${mx[0]} · y ${mn[1]}..${mx[1]} · z ${mn[2]}..${mx[2]}\n` +
    `  导入：选中网格节点 → 检查器「Data Mesh」→ 导入数据网格（.json）`,
);
