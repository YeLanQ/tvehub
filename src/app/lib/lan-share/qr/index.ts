// ---------------------------------------------------------------------------
// 二维码编码器（纯 TS，零依赖）：局域网共享地址要在桌面端当场画出来给手机扫，
// 编码只发生在渲染层，不值得为它引一个运行时依赖，故自带一份实现。
//
// 实现范围：字节模式（UTF-8）+ 纠错等级 L/M/Q/H + 版本 1~40 + 8 种掩码自动评分。
// 依据 ISO/IEC 18004：容量结构推导、格式/版本信息用 BCH 码现算、掩码按 N1~N4 罚分选。
//
// 子模块：tables（规范表与几何）/ galois（GF(256) 与 RS）/ matrix（建构与编码）/
// render（SVG 输出）；本文件只负责对外出口。
//
// 正确性由 npm run qr:check 对照参考实现逐模块比对 + 独立解码器解码校验。
// ---------------------------------------------------------------------------

export type { QrEcc, QrMatrix, QrOptions, QrRenderOptions } from "./types";
export { encodeQr, pickVersion } from "./encode";
export { qrModuleAt, qrSvg } from "./render";