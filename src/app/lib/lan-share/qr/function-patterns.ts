// 符号骨架：定位/分隔/定时/对齐图案 + 格式信息占位（功能图案一经画定即为保留区，
// 数据只能落在保留区之外），并由保留区反推每版本的数据区容量（不查容量表）。
import { EC_CODEWORDS_TABLE, ECC_COL, alignmentPositions, isFinderArea, symbolSize } from "./tables";
import { writeFormatInfo, writeVersionInfo } from "./mask";
import type { QrEcc } from "./types";

export interface Base {
  version: number;
  size: number;
  /** 功能图案（含格式/版本信息占位）标记：1 = 数据区之外 */
  reserved: Uint8Array;
  /** 已画好的功能图案 */
  modules: Uint8Array;
  /** 数据区模块数 / 8 = 符号总码字数 */
  totalCodewords: number;
}

/** 建构某版本的空白符号：定位/分隔/定时/对齐/格式占位/版本信息，并统计数据区 */
export function createBase(version: number): Base {
  const size = symbolSize(version);
  const n = size * size;
  const reserved = new Uint8Array(n);
  const modules = new Uint8Array(n);
  const set = (row: number, col: number, dark: boolean, mark = true): void => {
    if (row < 0 || col < 0 || row >= size || col >= size) return;
    const i = row * size + col;
    if (dark) modules[i] = 1;
    if (mark) reserved[i] = 1;
  };

  // 定位图案 + 分隔符（-1..7 窗口同时画出分隔符白边）
  const finders: [number, number][] = [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ];
  for (const [row0, col0] of finders) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const onRing = r >= 0 && r <= 6 && (c === 0 || c === 6);
        const onRing2 = c >= 0 && c <= 6 && (r === 0 || r === 6);
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(row0 + r, col0 + c, onRing || onRing2 || inCore);
      }
    }
  }

  // 定时图案
  for (let r = 8; r < size - 8; r++) {
    set(r, 6, r % 2 === 0);
    set(6, r, r % 2 === 0);
  }

  // 对齐图案
  const positions = alignmentPositions(version);
  for (const row of positions) {
    for (const col of positions) {
      if (isFinderArea(row, col, size)) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const edge = r === -2 || r === 2 || c === -2 || c === 2;
          set(row + r, col + c, edge || (r === 0 && c === 0));
        }
      }
    }
  }

  // 格式信息占位（掩码 0）：先把这 31 个模块划为功能区，避免被掩码/数据覆盖
  writeFormatInfo(modules, reserved, size, "M", 0);
  if (version >= 7) writeVersionInfo(modules, reserved, size, version);

  let dataModules = 0;
  for (let i = 0; i < n; i++) if (!reserved[i]) dataModules++;
  return {
    version,
    size,
    reserved,
    modules,
    totalCodewords: Math.floor(dataModules / 8),
  };
}

/** 各版本总码字数（结构推导，懒算缓存） */
const totalCodewordsCache: number[] = [];
export function totalCodewords(version: number): number {
  if (totalCodewordsCache[version] == null) {
    totalCodewordsCache[version] = createBase(version).totalCodewords;
  }
  return totalCodewordsCache[version];
}

/** 数据区可容纳的比特数 */
export function dataCapacityBits(version: number, ecc: QrEcc): number {
  return (totalCodewords(version) - EC_CODEWORDS_TABLE[(version - 1) * 4 + ECC_COL[ecc]]) * 8;
}
