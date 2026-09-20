// ---------------------------------------------------------------------------
// 局域网共享的地址与文案：base URL 选择、分享链接拼接、体积/时间格式化。
// 纯函数，不持有状态——状态在 state.ts，组件只从这里取展示用的字符串。
// ---------------------------------------------------------------------------
import type { LanShareEntry, LanShareStatus, LanShareUrl } from "../../../lib/api";

/** 首选访问地址：默认路由那条优先，其次第一条（无网卡时会拿到回环兜底） */
export function primaryUrl(status: LanShareStatus | null): LanShareUrl | null {
  if (!status || status.urls.length === 0) return null;
  return status.urls.find((u) => u.primary) ?? status.urls[0];
}

/** 分享直链：`<base>/s/<id>/`（id 为短 base36，无需转义） */
export function shareLink(status: LanShareStatus | null, id: string, ip?: string): string {
  const base = ip ? status?.urls.find((u) => u.ip === ip) ?? primaryUrl(status) : primaryUrl(status);
  if (!base) return "";
  const root = base.url.endsWith("/") ? base.url : `${base.url}/`;
  return `${root}s/${id}/`;
}

/** 站点首页链接（手机扫码后进入的共享列表） */
export function indexLink(url: LanShareUrl): string {
  return url.url;
}

/** 字节数 → 人类可读 */
export function humanSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 相对时间（列表展示「3 分钟前」；时间戳为 0 表示从未被访问） */
export function relativeTime(ms: number, now = Date.now()): string {
  if (!ms) return "从未访问";
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 产物类型 → 中文标签 */
export function kindLabel(kind: string): string {
  switch (kind) {
    case "whiteboard":
      return "白板";
    case "folder":
      return "目录";
    default:
      return "网页";
  }
}

/** 服务状态 → 一句话描述（状态条与卡片标题共用） */
export function serviceSummary(status: LanShareStatus | null): string {
  if (!status) return "未载入";
  if (!status.running) return "未开启";
  const url = primaryUrl(status);
  return url ? `已开启 · ${url.url}` : "已开启";
}

/** 某条共享的访问统计文案 */
export function accessSummary(share: LanShareEntry): string {
  if (!share.hits) return "还没有人访问";
  const who = share.lastClient ? ` · 最近来自 ${share.lastClient}` : "";
  return `${share.hits} 次访问 · ${relativeTime(share.lastAccess)}${who}`;
}
