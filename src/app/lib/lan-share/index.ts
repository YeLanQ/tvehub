// ---------------------------------------------------------------------------
// 局域网共享（前端门面）：状态层 + 地址/文案 + 二维码编码。
// 组件只从这里 import，不直接碰 lib/api 的类型与状态实现。
// ---------------------------------------------------------------------------
export {
  addLanDirShare,
  findShare,
  findShareBySource,
  lanShare,
  lanShares,
  patchLanShareConfig,
  publishLanSite,
  refreshLanShare,
  removeLanShare,
  setLanShareEnabled,
  setLanShareItemEnabled,
} from "./state";

export {
  accessSummary,
  humanSize,
  indexLink,
  kindLabel,
  primaryUrl,
  relativeTime,
  serviceSummary,
  shareLink,
} from "./links";

export { encodeQr, qrSvg, type QrEcc, type QrMatrix } from "./qr";
