// GF(256) 有限域与 Reed-Solomon 纠错：本原多项式 0x11D，生成多项式 ∏(x − α^i)。

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/**
 * 生成多项式 ∏(x − α^i)，次数 = 纠错码字数。
 * 系数降幂存储（下标 0 = 最高次），且首项恒为 1（首一多项式）。
 */
export function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const term = new Uint8Array([1, GF_EXP[i]]); // x + α^i（降幂）
    const next = new Uint8Array(poly.length + term.length - 1);
    for (let a = 0; a < poly.length; a++) {
      for (let b = 0; b < term.length; b++) next[a + b] ^= gfMul(poly[a], term[b]);
    }
    poly = next;
  }
  return poly;
}

/**
 * 对单个数据块求纠错码字（GF(256) 上的多项式除法取余，移位寄存器实现）。
 * 寄存器与生成多项式同为降幂：ec[i] 对应 x^(ecLen-1-i)。
 * 每步 R ← (R·x + d·x^ecLen) mod gen，把 x^ecLen 用 gen 的首一关系约掉后，
 * 回代项落在寄存器下标 i 上、系数为 gen[i+1]（gen[0] 是省略的首一项）。
 */
export function rsEncode(data: Uint8Array, ecLen: number, gen: Uint8Array): Uint8Array {
  const ec = new Uint8Array(ecLen);
  for (const byte of data) {
    const factor = byte ^ ec[0];
    ec.copyWithin(0, 1);
    ec[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i++) ec[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return ec;
}
