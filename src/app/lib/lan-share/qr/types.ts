// 二维码编码器的公共类型（各子模块共用的最小集合，不依赖任何实现）。
/** 纠错等级：L≈7% / M≈15% / Q≈25% / H≈30% 可恢复码字 */
export type QrEcc = "L" | "M" | "Q" | "H";

export interface QrMatrix {
  /** 版本号 1~40 */
  version: number;
  /** 边长（模块数）= version * 4 + 17 */
  size: number;
  ecc: QrEcc;
  /** 选中的掩码号 0~7 */
  mask: number;
  /** 行优先的模块数组，true = 深色 */
  modules: boolean[];
}

export interface QrOptions {
  /** 纠错等级（默认 M，兼顾容量与容错） */
  ecc?: QrEcc;
  /** 固定版本（默认自动选最小可容纳版本） */
  version?: number;
  /** 固定掩码 0~7（默认按罚分自动选） */
  mask?: number;
}

export interface QrRenderOptions {
  /** 每个模块的像素边长（默认 8） */
  scale?: number;
  /** 静区宽度（模块数，默认 4；规范要求 ≥4） */
  quiet?: number;
  /** 深色 / 浅色（浅色传 "none" 可得到透明底） */
  dark?: string;
  light?: string;
}
