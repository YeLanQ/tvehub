// ---------------------------------------------------------------------------
// 数字地形源数据格式解析（framework 层，纯逻辑，无 DOM/引擎依赖）。
//
// 支持 DEM/DTM/DSM/DLG 常见导出格式的字节/文本 → 规则高度网格：
// - .asc   Esri ASCII Grid（DEM/DTM/DSM 标准交换格式；带 nodata）
// - .hgt   SRTM 裸高程（大端 int16 方阵；void = -32768）
// - .pgm   灰度高程图（P5 二进制/P2 文本；maxval>255 为 2 字节大端）
// - .xyz/.csv  XYZ 点云/高程点（DLG 高程点/等高线采样导出；散点桶平均栅格化）
// 播放侧不解析源文件（编辑期已烘焙为归一化网格内嵌节点，见 dem.ts）。
// ---------------------------------------------------------------------------

/** 源数据解析产物：规则网格（行主序 [row*cols+col]；row=0 为 z 最小侧） */
export interface RawElevationGrid {
  cols: number;
  rows: number;
  /** 高程值（原单位；nodata 已替换为 NaN） */
  heights: Float32Array;
  /** 有效值统计（NaN 除外） */
  min: number;
  max: number;
  /** 数据语义为 0..1 归一化高程图（pgm），不按 min..max 重归一 */
  normalized: boolean;
  /** 单格边长（米；未知为 0——pgm/xyz 无地理参考） */
  cellSize: number;
}

function statsOf(h: Float32Array): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < h.length; i++) {
    const v = h[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min > max) return { min: 0, max: 0 };
  return { min, max };
}

/** Esri ASCII Grid：表头键值行 + 空白分隔的高程矩阵（ASC 行序 = 北→南，翻转成 z 升序） */
export function parseAscGrid(text: string): RawElevationGrid {
  const tokens = text.trim().split(/\s+/);
  const header: Record<string, number> = {};
  let i = 0;
  while (i < tokens.length && /^[a-z_]+$/i.test(tokens[i])) {
    const key = tokens[i].toLowerCase();
    const val = Number(tokens[i + 1]);
    if (!Number.isFinite(val)) break;
    header[key] = val;
    i += 2;
  }
  const cols = header.ncols ?? 0;
  const rows = header.nrows ?? 0;
  if (cols < 2 || rows < 2 || cols * rows > 4_000_000) throw new Error(`ASC 表头非法: ncols=${cols} nrows=${rows}`);
  if (tokens.length - i < cols * rows) throw new Error("ASC 数据不足（表头声明的网格大于正文）");
  const nodata = Number.isFinite(header.nodata_value) ? header.nodata_value : NaN;
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const srcRow = rows - 1 - r; // 翻转行序：ASC 首行 = 北（z 最大）
    for (let c = 0; c < cols; c++) {
      const v = Number(tokens[i + srcRow * cols + c]);
      heights[r * cols + c] = Number.isFinite(v) && v !== nodata ? v : NaN;
    }
  }
  return { cols, rows, heights, ...statsOf(heights), normalized: false, cellSize: header.cellsize ?? 0 };
}

/** SRTM .hgt：大端 int16 方阵（side = √(len/2)；1201/3601/4801 等）；-32768 为 void */
export function parseHgt(buffer: ArrayBuffer): RawElevationGrid {
  const side = Math.sqrt(buffer.byteLength / 2);
  const n = Math.round(side);
  if (n < 2 || n * n * 2 !== buffer.byteLength) {
    throw new Error(`HGT 尺寸非法: ${buffer.byteLength} 字节（应为 2×side²）`);
  }
  const view = new DataView(buffer);
  const heights = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = view.getInt16((r * n + c) * 2, false);
      heights[r * n + c] = v === -32768 ? NaN : v;
    }
  }
  return { cols: n, rows: n, heights, ...statsOf(heights), normalized: false, cellSize: 30 }; // SRTM 1″≈30m
}

/** PGM 灰度高程图（P5 二进制 / P2 文本；maxval>255 → 2 字节大端）；值域天然 0..maxval */
export function parsePgm(buffer: ArrayBuffer): RawElevationGrid {
  const bytes = new Uint8Array(buffer);
  let pos = 0;
  const readToken = (): string => {
    while (pos < bytes.length && /\s/.test(String.fromCharCode(bytes[pos]))) pos++;
    if (bytes[pos] === 35 /* # */) {
      while (pos < bytes.length && bytes[pos] !== 10) pos++;
      return readToken();
    }
    let s = "";
    while (pos < bytes.length && !/\s/.test(String.fromCharCode(bytes[pos]))) s += String.fromCharCode(bytes[pos++]);
    return s;
  };
  const magic = readToken();
  if (magic !== "P5" && magic !== "P2") throw new Error(`PGM 魔数非法: ${magic || "(空)"}`);
  const cols = Number(readToken());
  const rows = Number(readToken());
  const maxval = Number(readToken());
  if (cols < 2 || rows < 2 || cols * rows > 4_000_000 || maxval < 1 || maxval > 65535) {
    throw new Error(`PGM 表头非法: ${cols}×${rows} maxval=${maxval}`);
  }
  pos++; // 表头后单个空白符
  const heights = new Float32Array(cols * rows);
  const wide = maxval > 255;
  if (magic === "P5") {
    const need = cols * rows * (wide ? 2 : 1);
    if (bytes.length - pos < need) throw new Error("PGM 数据不足");
    const view = new DataView(buffer);
    for (let i = 0; i < cols * rows; i++) {
      heights[i] = wide ? view.getUint16(pos + i * 2, false) : bytes[pos + i];
    }
  } else {
    for (let i = 0; i < cols * rows; i++) heights[i] = Number(readToken());
  }
  return { cols, rows, heights, ...statsOf(heights), normalized: true, cellSize: 0 };
}

/**
 * XYZ 点云（x y z 每行；.xyz/.csv/.txt）：散点桶平均栅格化。
 * 目标网格边长按点数密度取 65..513（2^k+1）；空桶用全局均值回填 + 一趟盒式
 * 平滑抑制空洞斑点（稀疏等高线采样也可出连续地形）。
 */
export function parseXyzPoints(text: string): RawElevationGrid {
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
  if (zs.length < 9) throw new Error(`XYZ 点数不足: ${zs.length}（至少 9 点）`);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < zs.length; i++) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  let n = Math.max(65, Math.min(513, Math.round(Math.sqrt(zs.length))));
  n = 2 ** Math.round(Math.log2(n - 1)) + 1; // 2^k+1
  const spanX = Math.max(1e-9, maxX - minX);
  const spanY = Math.max(1e-9, maxY - minY);
  const acc = new Float64Array(n * n);
  const cnt = new Uint32Array(n * n);
  for (let i = 0; i < zs.length; i++) {
    const cx = Math.min(n - 1, Math.floor(((xs[i] - minX) / spanX) * (n - 1)));
    const cy = Math.min(n - 1, Math.floor(((ys[i] - minY) / spanY) * (n - 1)));
    const idx = cy * n + cx;
    acc[idx] += zs[i];
    cnt[idx]++;
  }
  const st = statsOf(Float32Array.from(zs));
  const heights = new Float32Array(n * n);
  for (let i = 0; i < heights.length; i++) heights[i] = cnt[i] ? acc[i] / cnt[i] : (st.min + st.max) / 2;
  // 一趟盒式平滑（含自身 3×3 邻域均值），空桶与实桶边界过渡
  const out = new Float32Array(heights.length);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
          sum += heights[yy * n + xx];
          k++;
        }
      }
      out[y * n + x] = sum / Math.max(1, k);
    }
  }
  return { cols: n, rows: n, heights: out, ...statsOf(out), normalized: false, cellSize: 0 };
}
