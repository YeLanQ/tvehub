// ---------------------------------------------------------------------------
// 数据化网格（MeshNode.source = "data"）：外部数据 → BufferGeometry 的管线。
//
// - 载荷（MeshDataGeometry）随节点内嵌（base64，与雕刻/DEM 同持久化手法），
//   自包含可随场景分发；预览/导出不依赖源文件；
// - 支持格式：JSON 显式网格（positions/indices/normals/uvs 数组）与
//   XYZ/CSV 规则格点（x 最快、z 行序；自动检测列数并菱形三角化）；
// - 本模块即共享单源：播放侧 src/runtime/runtime/mesh.ts 直接 import
//   parseMeshData/buildDataGeometry（损坏时把编辑器的可见报错适配为 null
//   回退占位基元），不再维护解码镜像。
// ---------------------------------------------------------------------------

import * as THREE from "three";

/** 数据化网格载荷（MeshNode.dataMesh） */
export interface MeshDataGeometry {
  /** 顶点位置 base64 Float32（xyz×vertexCount） */
  positions: string;
  /** 索引 base64 Uint32（空串 = 非索引点序） */
  indices: string;
  /** 法线 base64 Float32（空串 = 构建时 computeVertexNormals） */
  normals: string;
  /** UV base64 Float32（空串 = 无 UV） */
  uvs: string;
  vertexCount: number;
  indexCount: number;
  /** 源文件格式 */
  format: "json" | "xyz" | "csv";
  /** 源文件名（展示/溯源） */
  sourceName: string;
}

/** 顶点数上限（防御异常大文件拖垮编辑器；超过应走模型资产管线） */
const MAX_VERTICES = 200_000;

function encodeBytes(view: Float32Array | Uint32Array): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function decodeBytes(data: string, Ctor: typeof Float32Array | typeof Uint32Array): Float32Array | Uint32Array | null {
  try {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.byteLength % Ctor.BYTES_PER_ELEMENT !== 0) return null;
    return new Ctor(bytes.buffer);
  } catch {
    return null;
  }
}

/** 任意来源 → 收敛载荷（非法返回 null） */
export function parseMeshData(v: unknown): MeshDataGeometry | null {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const vc =
    typeof o.vertexCount === "number" && Number.isInteger(o.vertexCount) && o.vertexCount >= 3 && o.vertexCount <= MAX_VERTICES
      ? o.vertexCount
      : 0;
  if (!vc || typeof o.positions !== "string" || !o.positions) return null;
  const ic = typeof o.indexCount === "number" && Number.isInteger(o.indexCount) && o.indexCount >= 0 ? o.indexCount : -1;
  if (ic < 0) return null;
  const format = o.format === "json" || o.format === "xyz" || o.format === "csv" ? o.format : "json";
  return {
    positions: o.positions,
    indices: typeof o.indices === "string" ? o.indices : "",
    normals: typeof o.normals === "string" ? o.normals : "",
    uvs: typeof o.uvs === "string" ? o.uvs : "",
    vertexCount: vc,
    indexCount: ic,
    format,
    sourceName: typeof o.sourceName === "string" ? o.sourceName.slice(0, 128) : "",
  };
}

/** 内容签名（几何重建门控；与基元/DEM 签名同用途；含载荷长度，任何长度变化可检） */
export function meshDataSig(d: MeshDataGeometry | null): string {
  if (!d) return "nodata";
  let h = 5381;
  for (const s of [d.positions, d.indices]) {
    for (let i = 0; i < s.length; i += 8) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return `data:${d.format}:${d.vertexCount}:${d.indexCount}:${d.positions.length}:${d.indices.length}:${h.toString(36)}`;
}

/** 载荷 → BufferGeometry（法线缺省自动计算；数据损坏抛错由调用方兜底） */
export function buildDataGeometry(d: MeshDataGeometry): THREE.BufferGeometry {
  const pos = decodeBytes(d.positions, Float32Array) as Float32Array | null;
  if (!pos || pos.length !== d.vertexCount * 3) throw new Error(`网格位置数据损坏（${d.sourceName}）`);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  if (d.indexCount > 0) {
    const idx = decodeBytes(d.indices, Uint32Array) as Uint32Array | null;
    if (!idx || idx.length !== d.indexCount) throw new Error(`网格索引数据损坏（${d.sourceName}）`);
    geometry.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (d.normals) {
    const nrm = decodeBytes(d.normals, Float32Array) as Float32Array | null;
    if (nrm && nrm.length === d.vertexCount * 3) {
      geometry.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    }
  }
  if (d.uvs) {
    const uv = decodeBytes(d.uvs, Float32Array) as Float32Array | null;
    if (uv && uv.length === d.vertexCount * 2) {
      geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    }
  }
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  return geometry;
}

/** 载荷解码供检查器展示（包围盒；损坏返回 null） */
export function meshDataBounds(d: MeshDataGeometry): { min: [number, number, number]; max: [number, number, number] } | null {
  try {
    const g = buildDataGeometry(d);
    g.computeBoundingBox();
    const b = g.boundingBox!;
    const out = { min: [b.min.x, b.min.y, b.min.z] as [number, number, number], max: [b.max.x, b.max.y, b.max.z] as [number, number, number] };
    g.dispose();
    return out;
  } catch {
    return null;
  }
}

/** XYZ/CSV 规则格点 → 网格载荷（x 最快、遇 x 回绕计列数；菱形三角化同地形网格） */
function importXyzGrid(name: string, format: "xyz" | "csv", text: string): MeshDataGeometry {
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^(-?[\d.eE+]+)[\s,;]+(-?[\d.eE+]+)[\s,;]+(-?[\d.eE+]+)/);
    if (!m) continue;
    const x = Number(m[1]);
    const y = Number(m[2]);
    const z = Number(m[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    xs.push(x);
    ys.push(y);
    zs.push(z);
  }
  if (xs.length < 9) throw new Error(`格点数不足: ${xs.length}（至少 3×3）`);
  // 列数检测：x 序列首次回绕（x[i] <= x[i-1] 且此前严格递增）
  let cols = 0;
  for (let i = 1; i < xs.length && !cols; i++) {
    if (xs[i] <= xs[i - 1]) cols = i;
  }
  if (!cols || xs.length % cols !== 0) throw new Error("格点非规则网格（x 应逐行最快变化；散点请先栅格化）");
  const rows = xs.length / cols;
  if (rows < 3) throw new Error(`格点行数不足: ${rows}`);
  const positions = new Float32Array(xs.length * 3);
  for (let i = 0; i < xs.length; i++) {
    positions[i * 3] = xs[i];
    positions[i * 3 + 1] = ys[i];
    positions[i * 3 + 2] = zs[i];
  }
  // UV：格点索引归一化（0..1）
  const uvs = new Float32Array(xs.length * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      uvs[i * 2] = cols > 1 ? c / (cols - 1) : 0;
      uvs[i * 2 + 1] = rows > 1 ? 1 - r / (rows - 1) : 0;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const cc = a + cols;
      const dd = cc + 1;
      if ((c + r) % 2 === 0) idx.push(a, cc, b, b, cc, dd);
      else idx.push(a, cc, dd, a, dd, b);
    }
  }
  return {
    positions: encodeBytes(positions),
    indices: encodeBytes(new Uint32Array(idx)),
    normals: "",
    uvs: encodeBytes(uvs),
    vertexCount: xs.length,
    indexCount: idx.length,
    format,
    sourceName: name.slice(0, 128),
  };
}

/** JSON 显式网格 → 载荷（positions 必填；indices/normals/uvs 可选数组） */
function importJsonMesh(name: string, text: string): MeshDataGeometry {
  const doc = JSON.parse(text) as Record<string, unknown>;
  const positions = Array.isArray(doc.positions) ? doc.positions : null;
  if (!positions || positions.length < 9 || positions.length % 3 !== 0) {
    throw new Error("JSON 网格缺 positions（xyz×N 数组，至少 3 顶点）");
  }
  const vertexCount = positions.length / 3;
  if (vertexCount > MAX_VERTICES) throw new Error(`顶点数超上限: ${vertexCount}（> ${MAX_VERTICES}，请走模型资产）`);
  const toF32 = (v: unknown): Float32Array => {
    const arr = new Float32Array(v as number[]);
    if (arr.some((n) => !Number.isFinite(n))) throw new Error("网格数据含非有限值");
    return arr;
  };
  const pos = toF32(positions);
  const indices = Array.isArray(doc.indices) ? new Uint32Array(doc.indices as number[]) : new Uint32Array(0);
  const normals = Array.isArray(doc.normals) ? toF32(doc.normals) : null;
  const uvs = Array.isArray(doc.uvs) ? toF32(doc.uvs) : null;
  if (indices.length && indices.some((i) => i >= vertexCount)) throw new Error("索引越界（>= vertexCount）");
  if (normals && normals.length !== vertexCount * 3) throw new Error("normals 长度应为 vertexCount×3");
  if (uvs && uvs.length !== vertexCount * 2) throw new Error("uvs 长度应为 vertexCount×2");
  return {
    positions: encodeBytes(pos),
    indices: indices.length ? encodeBytes(indices) : "",
    normals: normals ? encodeBytes(normals) : "",
    uvs: uvs ? encodeBytes(uvs) : "",
    vertexCount,
    indexCount: indices.length,
    format: "json",
    sourceName: name.slice(0, 128),
  };
}

/** 按扩展名分发导入（失败抛错，UI 捕获提示） */
export function importMeshDataFile(name: string, ext: string, text: string): MeshDataGeometry {
  const e = ext.toLowerCase();
  if (e === ".json" || e === ".mesh.json") return importJsonMesh(name, text);
  if (e === ".xyz" || e === ".csv" || e === ".txt") return importXyzGrid(name, e === ".txt" ? "xyz" : (e.slice(1) as "xyz" | "csv"), text);
  throw new Error(`不支持的数据网格格式: ${ext}（支持 .json/.xyz/.csv）`);
}
