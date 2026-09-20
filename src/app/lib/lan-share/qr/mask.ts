// 掩码与格式信息：8 种掩码公式 + 规范 N1~N4 罚分（用于自动选最优掩码），
// 以及 (15,5)/(18,6) BCH 现算的格式信息与版本信息写入。
import { ECC_FORMAT_BITS } from "./tables";
import type { QrEcc } from "./types";

// --- 掩码 ------------------------------------------------------------------

/** 掩码公式（i = 行，j = 列）：成立则该模块取反 */
function maskAt(pattern: number, i: number, j: number): boolean {
  switch (pattern) {
    case 0:
      return (i + j) % 2 === 0;
    case 1:
      return i % 2 === 0;
    case 2:
      return j % 3 === 0;
    case 3:
      return (i + j) % 3 === 0;
    case 4:
      return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5:
      return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6:
      return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    default:
      return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
  }
}

export function applyMask(modules: Uint8Array, reserved: Uint8Array, size: number, pattern: number): void {
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const at = row * size + col;
      if (reserved[at]) continue;
      if (maskAt(pattern, row, col)) modules[at] ^= 1;
    }
  }
}

/** 罚分 N1：行/列上连续同色 ≥5 的段，每段 3 +（超出 5 的长度） */
export function penaltyN1(modules: Uint8Array, size: number): number {
  let points = 0;
  for (let i = 0; i < size; i++) {
    let lastRow = -1;
    let lastCol = -1;
    let runRow = 0;
    let runCol = 0;
    for (let j = 0; j < size; j++) {
      const rowVal = modules[i * size + j];
      if (rowVal === lastRow) runRow++;
      else {
        if (runRow >= 5) points += 3 + (runRow - 5);
        lastRow = rowVal;
        runRow = 1;
      }
      const colVal = modules[j * size + i];
      if (colVal === lastCol) runCol++;
      else {
        if (runCol >= 5) points += 3 + (runCol - 5);
        lastCol = colVal;
        runCol = 1;
      }
    }
    if (runRow >= 5) points += 3 + (runRow - 5);
    if (runCol >= 5) points += 3 + (runCol - 5);
  }
  return points;
}

/** 罚分 N2：2×2 同色块，每块 3 分 */
export function penaltyN2(modules: Uint8Array, size: number): number {
  let count = 0;
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const sum =
        modules[row * size + col] +
        modules[row * size + col + 1] +
        modules[(row + 1) * size + col] +
        modules[(row + 1) * size + col + 1];
      if (sum === 0 || sum === 4) count++;
    }
  }
  return count * 3;
}

/** 罚分 N3：行/列出现 1:1:3:1:1 且两侧有 4 个浅色模块，每次 40 分 */
export function penaltyN3(modules: Uint8Array, size: number): number {
  let count = 0;
  let bitsRow = 0;
  let bitsCol = 0;
  for (let i = 0; i < size; i++) {
    bitsRow = 0;
    bitsCol = 0;
    for (let j = 0; j < size; j++) {
      bitsRow = ((bitsRow << 1) & 0x7ff) | modules[i * size + j];
      if (j >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) count++;
      bitsCol = ((bitsCol << 1) & 0x7ff) | modules[j * size + i];
      if (j >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) count++;
    }
  }
  return count * 40;
}

/** 罚分 N4：深色占比偏离 50% 每 5% 扣 10 分 */
export function penaltyN4(modules: Uint8Array): number {
  let dark = 0;
  for (const m of modules) dark += m;
  const percent = (dark * 100) / modules.length;
  const k = Math.floor(Math.abs(percent - 50) / 5);
  return k * 10;
}

// --- 格式信息 / 版本信息 ----------------------------------------------------

/** (15,5) BCH 格式信息：纠错等级 + 掩码，异或固定掩码后写入两处 */
function formatInfoBits(ecc: QrEcc, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let d = data << 10;
  const g15 = 0b10100110111;
  while (bitLength(d) - bitLength(g15) >= 0) d ^= g15 << (bitLength(d) - bitLength(g15));
  return ((data << 10) | d) ^ 0b101010000010010;
}

/** (18,6) BCH 版本信息（版本 ≥7） */
function versionInfoBits(version: number): number {
  let d = version << 12;
  const g18 = 0b1111100100101;
  while (bitLength(d) - bitLength(g18) >= 0) d ^= g18 << (bitLength(d) - bitLength(g18));
  return (version << 12) | d;
}

function bitLength(value: number): number {
  let n = 0;
  let v = value;
  while (v !== 0) {
    n++;
    v >>>= 1;
  }
  return n;
}

export function writeFormatInfo(
  modules: Uint8Array,
  reserved: Uint8Array,
  size: number,
  ecc: QrEcc,
  mask: number,
): void {
  const bits = formatInfoBits(ecc, mask);
  const set = (row: number, col: number, dark: boolean): void => {
    if (row < 0 || col < 0 || row >= size || col >= size) return;
    const at = row * size + col;
    modules[at] = dark ? 1 : 0;
    reserved[at] = 1;
  };
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1;
    if (i < 6) set(i, 8, dark);
    else if (i < 8) set(i + 1, 8, dark);
    else set(size - 15 + i, 8, dark);

    if (i < 8) set(8, size - i - 1, dark);
    else if (i < 9) set(8, 15 - i, dark);
    else set(8, 15 - i - 1, dark);
  }
  set(size - 8, 8, true); // 固定深色模块
}

export function writeVersionInfo(modules: Uint8Array, reserved: Uint8Array, size: number, version: number): void {
  const bits = versionInfoBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >> i) & 1) === 1;
    const row = Math.floor(i / 3);
    const col = (i % 3) + size - 11;
    const a = row * size + col;
    modules[a] = dark ? 1 : 0;
    reserved[a] = 1;
    const b = col * size + row;
    modules[b] = dark ? 1 : 0;
    reserved[b] = 1;
  }
}
