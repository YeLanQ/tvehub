// ---------------------------------------------------------------------------
// 数字地形数据源（TerrainNode.dem 的形状与烘焙管线入口）。
//
// 编辑期把 DEM/DTM/DSM/DLG 源文件解析为「归一化 0..1 高度网格」（2^k+1 边长，
// base64 Float32 内嵌节点，自包含可随场景分发——与雕刻层同一持久化手法）；
// 地形烘焙时以 node.dem 优先作为基准高度（×terrain.heightScale 垂直夸张），
// 无 dem 则回退程序化生成。播放侧镜像：runtime/terrain.ts（只解码不解析源文件）。
// ---------------------------------------------------------------------------

import {
  parseAscGrid,
  parseHgt,
  parsePgm,
  parseXyzPoints,
  type RawElevationGrid,
} from "./demFormats";
import { DEFAULT_TERRAIN_SETTINGS, TERRAIN_LIMITS } from "./types";

/** 支持的源数据格式（按扩展名分发导入） */
export type DemFormat = "asc" | "hgt" | "pgm" | "xyz";

/** DEM 数据语义标签（同一套栅格管线，仅来源语义不同；UI 展示用） */
export const DEM_TYPE_LABELS: Record<DemFormat, string> = {
  asc: "DEM/DTM/DSM（Esri ASCII Grid）",
  hgt: "DEM（SRTM HGT）",
  pgm: "高程灰度图（PGM）",
  xyz: "DLG 高程点/点云（XYZ）",
};

/** 存储网格边长上限（2^k+1 序列；512+1 —— 默认地形 segments=256 网格为 257） */
const DEM_STORED_GRID = 513;

/** 数字地形数据源（TerrainNode.dem） */
export interface TerrainDemData {
  /** 归一化网格边长（2^k+1；行主序 gridN²） */
  gridN: number;
  /** 归一化高度 0..1 的 base64 Float32 */
  data: string;
  /** 源文件格式 */
  format: DemFormat;
  /** 源文件名（展示/溯源） */
  sourceName: string;
  /** 源网格列/行数 */
  sourceCols: number;
  sourceRows: number;
  /** 源高程范围（原单位；展示） */
  sourceMin: number;
  sourceMax: number;
  /** 源单格边长（米；0 = 无地理参考，pgm/xyz） */
  sourceCellSize: number;
}

function isDemFormat(v: unknown): v is DemFormat {
  return v === "asc" || v === "hgt" || v === "pgm" || v === "xyz";
}

/** 任意来源 → 收敛的 DEM 数据源（非法返回 null；data 长度与 gridN 匹配才收） */
export function parseTerrainDem(v: unknown): TerrainDemData | null {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const gridN =
    typeof o.gridN === "number" && Number.isInteger(o.gridN) && o.gridN >= 2 && o.gridN <= 1024 ? o.gridN : 0;
  if (!gridN || typeof o.data !== "string" || !o.data) return null;
  return {
    gridN,
    data: o.data,
    format: isDemFormat(o.format) ? o.format : "asc",
    sourceName: typeof o.sourceName === "string" ? o.sourceName.slice(0, 128) : "",
    sourceCols: typeof o.sourceCols === "number" && o.sourceCols > 0 ? o.sourceCols : 0,
    sourceRows: typeof o.sourceRows === "number" && o.sourceRows > 0 ? o.sourceRows : 0,
    sourceMin: typeof o.sourceMin === "number" && Number.isFinite(o.sourceMin) ? o.sourceMin : 0,
    sourceMax: typeof o.sourceMax === "number" && Number.isFinite(o.sourceMax) ? o.sourceMax : 0,
    sourceCellSize: typeof o.sourceCellSize === "number" && Number.isFinite(o.sourceCellSize) && o.sourceCellSize > 0 ? o.sourceCellSize : 0,
  };
}

/** Float32 → base64（与雕刻层同手法） */
export function encodeDemData(norm: Float32Array): string {
  const bytes = new Uint8Array(norm.buffer, norm.byteOffset, norm.byteLength);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** base64 → Float32（损坏返回 null） */
export function decodeDemData(data: string): Float32Array | null {
  try {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.byteLength % 4 === 0 ? new Float32Array(bytes.buffer) : null;
  } catch {
    return null;
  }
}

/** 双线性重采样（行主序 src 边长 srcN → 目标 targetN；越界钳边） */
export function resampleGrid(src: Float32Array, srcN: number, targetN: number): Float32Array {
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

/** 解码并按地形网格分辨率产出基准高度（归一化 × heightScale；损坏返回 null） */
export function demBaseHeights(dem: TerrainDemData, heightScale: number, targetN: number): Float32Array | null {
  const norm = decodeDemData(dem.data);
  if (!norm || norm.length !== dem.gridN * dem.gridN) return null;
  const sampled = resampleGrid(norm, dem.gridN, targetN);
  const out = new Float32Array(sampled.length);
  for (let i = 0; i < sampled.length; i++) out[i] = sampled[i] * heightScale;
  return out;
}

/** 内容签名（几何重建门控用；同数据同签名） */
export function demSig(dem: TerrainDemData | null): string {
  if (!dem) return "nodem";
  return `${dem.format}:${dem.gridN}:${dem.sourceCols}x${dem.sourceRows}:${dem.data.length}:${dem.sourceName}`;
}

/** 源网格 → 归一化 0..1（pgm 已归一化则直通） */
function normalizeGrid(raw: RawElevationGrid): Float32Array {
  const out = new Float32Array(raw.heights.length);
  if (raw.normalized || raw.max - raw.min < 1e-9) {
    const s = raw.normalized ? 1 / Math.max(1, raw.max) : 0;
    for (let i = 0; i < out.length; i++) out[i] = raw.heights[i] * s;
    return out;
  }
  const inv = 1 / (raw.max - raw.min);
  for (let i = 0; i < out.length; i++) out[i] = (raw.heights[i] - raw.min) * inv;
  return out;
}

/**
 * 导入时的比例自动适配（数字地形的正确口径：保持源数据的真实比例感）。
 * 归一化把源高程压到 0..1，若沿用程序化地形的默认 Height Scale，源数据全量程
 * （如 233..1666m）会吃满默认 65m——细微地物（火山口/河谷）被压没，山体比例失真。
 * 规则：仅当对应字段仍是程序化默认值（用户未定制）时才自动改写——
 * - heightScale ← 源数据真实起伏（sourceMax-sourceMin）；
 * - size ← 源地理覆盖（sourceCols × cellSize），钳进取值域（超上限时在提示里说明）。
 * 返回应应用的补丁与人类可读的提示（无适配时 advisory 为空串）。
 */
export function demTerrainFit(
  dem: TerrainDemData,
  terrain: { heightScale: number; size: number },
): { heightScale?: number; size?: number; advisory: string } {
  const notes: string[] = [];
  const fit: { heightScale?: number; size?: number; advisory: string } = { advisory: "" };
  const untouchedHs = Math.abs(terrain.heightScale - DEFAULT_TERRAIN_SETTINGS.heightScale) < 1e-6;
  if (untouchedHs) {
    const relief = Math.max(1, dem.sourceMax - dem.sourceMin);
    fit.heightScale = Math.round(relief * 10) / 10;
    notes.push(`Height Scale 按源数据起伏自动设为 ${fit.heightScale}m`);
  }
  const untouchedSize = Math.abs(terrain.size - DEFAULT_TERRAIN_SETTINGS.size) < 1e-6;
  if (untouchedSize && dem.sourceCellSize > 0) {
    const want = dem.sourceCols * dem.sourceCellSize;
    fit.size = Math.round(Math.min(TERRAIN_LIMITS.size.max, Math.max(TERRAIN_LIMITS.size.min, want)));
    if (want > TERRAIN_LIMITS.size.max) {
      notes.push(
        `源覆盖 ${(want / 1000).toFixed(1)}km 超出地形尺寸上限（${TERRAIN_LIMITS.size.max}m），水平范围按 ${fit.size}m 收纳（坡度比例偏陡）`,
      );
    } else {
      notes.push(`地形尺寸按源覆盖自动设为 ${fit.size}m`);
    }
  }
  fit.advisory = notes.join("；");
  return fit;
}

/** 按扩展名分发解析源文件 → 内嵌数据源（解析失败抛错，UI 层捕获提示） */
export function importDemFile(name: string, ext: string, text: () => string, bytes: () => ArrayBuffer): TerrainDemData {
  const e = ext.toLowerCase();
  let raw: RawElevationGrid;
  if (e === ".asc" || e === ".txt") raw = parseAscGrid(text());
  else if (e === ".hgt") raw = parseHgt(bytes());
  else if (e === ".pgm") raw = parsePgm(bytes());
  else if (e === ".xyz" || e === ".csv") raw = parseXyzPoints(text());
  else throw new Error(`不支持的地形数据格式: ${ext}（支持 .asc/.hgt/.pgm/.xyz/.csv）`);
  const norm = normalizeGrid(raw);
  const gridN = Math.min(DEM_STORED_GRID, 2 ** Math.ceil(Math.log2(Math.max(4, raw.cols - 1))) + 1);
  const stored = resampleGrid(norm, raw.cols, gridN);
  return {
    gridN,
    data: encodeDemData(stored),
    format: e === ".txt" ? "asc" : e === ".csv" ? "xyz" : (e.slice(1) as DemFormat),
    sourceName: name.slice(0, 128),
    sourceCols: raw.cols,
    sourceRows: raw.rows,
    sourceMin: raw.min,
    sourceMax: raw.max,
    sourceCellSize: raw.cellSize,
  };
}
