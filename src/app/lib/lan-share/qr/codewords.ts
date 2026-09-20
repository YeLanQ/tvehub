// 码字流水线：数据比特（模式 + 字符计数 + 内容 + 终止符 + 填充）→ 分块 RS 纠错 →
// 交织成最终序列 → 之字形写入数据区。
import { EC_BLOCKS_TABLE, ECC_COL, charCountBits, eccPerBlock } from "./tables";
import { rsEncode, rsGeneratorPoly } from "./galois";
import { dataCapacityBits } from "./function-patterns";
import type { QrEcc } from "./types";

// --- 比特缓冲 ---------------------------------------------------------------

class BitBuffer {
  readonly bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length(): number {
    return this.bits.length;
  }
}

/** 数据码字序列：模式指示符 + 字符计数 + 数据 + 终止符 + 补齐 + 填充码字 */
export function buildDataCodewords(bytes: Uint8Array, version: number, ecc: QrEcc): Uint8Array {
  const capacity = dataCapacityBits(version, ecc);
  const buf = new BitBuffer();
  buf.put(0b0100, 4); // 字节模式
  buf.put(bytes.length, charCountBits(version));
  for (const b of bytes) buf.put(b, 8);

  if (buf.length + 4 <= capacity) buf.put(0, 4); // 终止符（最多 4 位）
  while (buf.length % 8 !== 0) buf.put(0, 1); // 补齐到字节边界

  const out = new Uint8Array(capacity / 8);
  for (let i = 0; i < buf.length; i++) {
    if (buf.bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  }
  // 交替填充码字 0xEC / 0x11
  for (let i = buf.length / 8, k = 0; i < out.length; i++, k++) {
    out[i] = k % 2 === 0 ? 0xec : 0x11;
  }
  return out;
}

/** 分块 → RS 纠错 → 交织，得到最终码字序列 */
export function interleaveCodewords(data: Uint8Array, version: number, ecc: QrEcc): Uint8Array {
  const blocks = EC_BLOCKS_TABLE[(version - 1) * 4 + ECC_COL[ecc]];
  const ecLen = eccPerBlock(version, ecc);
  const gen = rsGeneratorPoly(ecLen);

  // 分组顺序按规范：先放较短的块（组 1），再放多一个数据码字的块（组 2）。
  // 顺序决定交织结果，解码端按同一顺序还原，放反了后面所有码字都会错位。
  const longCount = data.length % blocks;
  const shortCount = blocks - longCount;
  const shortLen = Math.floor(data.length / blocks);

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let b = 0; b < blocks; b++) {
    const len = shortLen + (b < shortCount ? 0 : 1);
    const block = data.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecLen, gen));
  }

  const maxLen = shortLen + (longCount > 0 ? 1 : 0);
  const out = new Uint8Array(data.length + blocks * ecLen);
  let index = 0;
  for (let i = 0; i < maxLen; i++) {
    for (const block of dataBlocks) if (i < block.length) out[index++] = block[i];
  }
  for (let i = 0; i < ecLen; i++) {
    for (const block of ecBlocks) out[index++] = block[i];
  }
  return out;
}

/** 之字形把码字写入数据区（跳过功能区；每列对自下而上/自上而下交替） */
export function placeData(modules: Uint8Array, reserved: Uint8Array, size: number, codewords: Uint8Array): void {
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // 跳过纵向定时图案所在列
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const at = row * size + (col - c);
        if (!reserved[at]) {
          let dark = false;
          if (byteIndex < codewords.length) {
            dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
          }
          modules[at] = dark ? 1 : 0;
          bitIndex--;
          if (bitIndex === -1) {
            byteIndex++;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || row >= size) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
}
