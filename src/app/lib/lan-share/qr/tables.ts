// 规范表数据与纯查表工具（ISO/IEC 18004）。
// 只有「每版本纠错码字总数」与「每版本分块数」需要查表（表 9）；
// 其余容量一律由矩阵结构推导（见 function-patterns.ts），少抄一份表就少一处出错点。
import type { QrEcc } from "./types";

/** 表的列序：L M Q H */
export const ECC_COL: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** 格式信息里的纠错等级编码位（L=01 M=00 Q=11 H=10；与表内列序无关） */
export const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** 每版本纠错码字总数（ISO/IEC 18004 表 9；行 = 版本 1~40，列 = L M Q H） */
export const EC_CODEWORDS_TABLE: number[] = [
  7, 10, 13, 17, 10, 16, 22, 28, 15, 26, 36, 44, 20, 36, 52, 64, 26, 48, 72, 88, 36, 64, 96, 112,
  40, 72, 108, 130, 48, 88, 132, 156, 60, 110, 160, 192, 72, 130, 192, 224, 80, 150, 224, 264, 96,
  176, 260, 308, 104, 198, 288, 352, 120, 216, 320, 384, 132, 240, 360, 432, 144, 280, 408, 480,
  168, 308, 448, 532, 180, 338, 504, 588, 196, 364, 546, 650, 224, 416, 600, 700, 224, 442, 644,
  750, 252, 476, 690, 816, 270, 504, 750, 900, 300, 560, 810, 960, 312, 588, 870, 1050, 336, 644,
  952, 1110, 360, 700, 1020, 1200, 390, 728, 1050, 1260, 420, 784, 1140, 1350, 450, 812, 1200, 1440,
  480, 868, 1290, 1530, 510, 924, 1350, 1620, 540, 980, 1440, 1710, 570, 1036, 1530, 1800, 570,
  1064, 1590, 1890, 600, 1120, 1680, 1980, 630, 1204, 1770, 2100, 660, 1260, 1860, 2220, 720, 1316,
  1950, 2310, 750, 1372, 2040, 2430,
];

/** 每版本纠错分块数（ISO/IEC 18004 表 9；行 = 版本 1~40，列 = L M Q H） */
export const EC_BLOCKS_TABLE: number[] = [
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 1, 2, 2, 4, 1, 2, 4, 4, 2, 4, 4, 4, 2, 4, 6, 5, 2, 4, 6, 6,
  2, 5, 8, 8, 4, 5, 8, 8, 4, 5, 8, 11, 4, 8, 10, 11, 4, 9, 12, 16, 4, 9, 16, 16, 6, 10, 12, 18, 6,
  10, 17, 16, 6, 11, 16, 19, 6, 13, 18, 21, 7, 14, 21, 25, 8, 16, 20, 25, 8, 17, 23, 25, 9, 17, 23,
  34, 9, 18, 25, 30, 10, 20, 27, 32, 12, 21, 29, 35, 12, 23, 34, 37, 12, 25, 34, 40, 13, 26, 35,
  42, 14, 28, 38, 45, 15, 29, 40, 48, 16, 31, 43, 51, 17, 33, 45, 54, 18, 35, 48, 57, 19, 37, 51,
  60, 19, 38, 53, 63, 20, 40, 56, 66, 21, 43, 59, 70, 22, 45, 62, 74, 24, 47, 65, 77, 25, 49, 68,
  81,
];

/** 符号边长（模块数）= 版本 * 4 + 17 */
export function symbolSize(version: number): number {
  return version * 4 + 17;
}

/**
 * 对齐图案中心坐标（版本 <2 无对齐图案）。
 * 与规范一致：末位恒为 size-7、首位恒为 6，中间按 2 的倍数等距内缩。
 */
export function alignmentPositions(version: number): number[] {
  if (version < 2) return [];
  const count = Math.floor(version / 7) + 2;
  const size = symbolSize(version);
  // 版本 32（size 145）间距为定值 26，其余取等分后向上取偶数
  const step = size === 145 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2;
  const pos = [size - 7];
  for (let i = 1; i < count - 1; i++) pos.push(pos[i - 1] - step);
  pos.push(6);
  return pos.reverse();
}

/**
 * 是否落在三个定位图案（含分隔符）范围内。
 * 对齐图案坐标里只有三个角落会与定位图案重叠，正是这三个组合需要跳过；
 * 其它坐标（含 row=6 / col=6 与定时图案重叠的那两个）都要画。
 */
export function isFinderArea(row: number, col: number, size: number): boolean {
  return (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8);
}

/** 每块纠错码字数（同版本同等级下各块相同） */
export function eccPerBlock(version: number, ecc: QrEcc): number {
  const blocks = EC_BLOCKS_TABLE[(version - 1) * 4 + ECC_COL[ecc]];
  return EC_CODEWORDS_TABLE[(version - 1) * 4 + ECC_COL[ecc]] / blocks;
}

/** 字节模式的字符计数指示符位宽：版本 1~9 为 8 位，10~40 为 16 位 */
export function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}
