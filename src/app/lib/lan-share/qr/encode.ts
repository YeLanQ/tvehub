// 编码入口：版本选择 + 完整编码流程（骨架 → 码字 → 掩码评分 → 输出矩阵）。
import { createBase, dataCapacityBits } from "./function-patterns";
import { buildDataCodewords, interleaveCodewords, placeData } from "./codewords";
import { applyMask, penaltyN1, penaltyN2, penaltyN3, penaltyN4, writeFormatInfo } from "./mask";
import { charCountBits } from "./tables";
import type { QrEcc, QrMatrix, QrOptions } from "./types";

/** 最小可容纳该字节数的版本；超出版本 40 容量时抛错 */
export function pickVersion(byteLength: number, ecc: QrEcc): number {
  for (let version = 1; version <= 40; version++) {
    const needed = 4 + charCountBits(version) + byteLength * 8;
    if (needed <= dataCapacityBits(version, ecc)) return version;
  }
  throw new Error("二维码内容过长（超出版本 40 容量）");
}

/** 编码文本为二维码矩阵（UTF-8 字节模式） */
export function encodeQr(text: string, options: QrOptions = {}): QrMatrix {
  const ecc = options.ecc ?? "M";
  const bytes = new TextEncoder().encode(text);
  const version = options.version ?? pickVersion(bytes.length, ecc);
  if (version < 1 || version > 40) throw new Error(`非法二维码版本: ${version}`);
  if (bytes.length > dataCapacityBits(version, ecc) / 8) {
    throw new Error("二维码内容超出所选版本容量");
  }

  const base = createBase(version);
  const codewords = interleaveCodewords(buildDataCodewords(bytes, version, ecc), version, ecc);
  placeData(base.modules, base.reserved, base.size, codewords);

  let mask = options.mask;
  if (mask == null) {
    let best = 0;
    let bestScore = Infinity;
    for (let p = 0; p < 8; p++) {
      const trial = base.modules.slice();
      const res = base.reserved.slice();
      writeFormatInfo(trial, res, base.size, ecc, p);
      applyMask(trial, res, base.size, p);
      const score =
        penaltyN1(trial, base.size) +
        penaltyN2(trial, base.size) +
        penaltyN3(trial, base.size) +
        penaltyN4(trial);
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    mask = best;
  }

  applyMask(base.modules, base.reserved, base.size, mask);
  writeFormatInfo(base.modules, base.reserved, base.size, ecc, mask);

  return {
    version,
    size: base.size,
    ecc,
    mask,
    modules: Array.from(base.modules, (v) => v === 1),
  };
}
