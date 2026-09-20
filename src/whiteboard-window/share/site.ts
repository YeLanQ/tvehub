// ---------------------------------------------------------------------------
// 白板分享站点组装：把一份文档打成可以直接在浏览器里放映的一组文件。
//
// 产物（发布到局域网托管站点，目录由 Rust 侧管理）：
// - `index.html`：自包含放映页——SVG 直接内联，无外部请求，手机离线收藏也能看；
// - `board.svg`：文档原样（与白板保存的格式完全一致，可再导入编辑器，也能单独打开看动画）；
// - `board.json`：放映元信息（标题/尺寸/页序/动画设置），给放映页与其它工具读。
//
// 页 = 可见图层（与编辑器放映一致）；`hidden` 图层不进页序，但仍留在 SVG 与文档里，
// 重新导入时不丢内容。
// ---------------------------------------------------------------------------
import { serializeDoc, type SvgDoc } from "../svg-doc";
import { VIEWER_CSS } from "./viewer-css";
import { VIEWER_JS } from "./viewer-js";

/** 发布时可选的放映设置（来自编辑器当前的放映偏好） */
export interface BoardShareOptions {
  /** 标题（分享站点的标题与页面标题） */
  title: string;
  /** 备注（发布记录里保存，页面不显示） */
  note: string;
  /** 切页方式：pushX | pushY | fade | stack */
  transition: string;
  /** 缓动曲线（CSS timing-function） */
  easing: string;
  /** 是否自动播放 */
  auto: boolean;
  /** 自动播放间隔（秒） */
  interval: number;
  /** 打开时停在的页序号（发布时作者正在看的那一页） */
  start: number;
  /** 是否在页面里放「下载源文件」入口 */
  download: boolean;
}

/** 文档里参与放映的页（可见图层，顺序 = 绘制序） */
export function boardPages(doc: SvgDoc): { id: string; name: string }[] {
  return doc.layers.filter((l) => l.visible).map((l) => ({ id: l.id, name: l.name }));
}

/** 当前活动图层在放映页序里的下标（不在页序里则 0） */
export function boardStartPage(doc: SvgDoc, activeLayerId: string | null): number {
  const idx = boardPages(doc).findIndex((p) => p.id === activeLayerId);
  return idx >= 0 ? idx : 0;
}

/** 内联 JSON 的转义：防止图层名里的 `</script>` 之类提前结束脚本块 */
function safeInlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");
}

function escHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 放映页 HTML：内联 SVG + 内联样式/脚本，无任何外部资源 */
function viewerHtml(doc: SvgDoc, options: BoardShareOptions): string {
  const pages = boardPages(doc);
  const svg = serializeDoc(doc, true);
  const meta = {
    title: options.title,
    w: doc.w,
    h: doc.h,
    pages,
    transition: options.transition,
    easing: options.easing,
    auto: options.auto,
    interval: options.interval,
    start: pages.length ? Math.min(options.start, pages.length - 1) : 0,
  };
  const download = options.download
    ? `<a class="tv-btn" href="board.svg" download>下载源文件</a>`
    : "";
  // 收缩把手：一个 SVG 靠 CSS 翻转，省一份重复标记；收缩后按钮语义由 JS 改写 aria-label
  const chevron = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>${escHtml(options.title)}</title>
<style>${VIEWER_CSS}</style>
</head>
<body>
<!-- 顶栏：浮动可收缩（收缩后只剩把手 + 标题，随时点开） -->
<header class="tv-bar tv-bar-top" id="tv-topbar">
  <button class="tv-handle" id="tv-toggle-top" type="button" aria-expanded="true" aria-label="收起标题栏" title="收起/展开标题栏（H）">${chevron}</button>
  <span class="tv-mini" id="tv-mini-top">${escHtml(options.title)}</span>
  <div class="tv-bar-body">
    <span class="tv-title">${escHtml(options.title)}</span>
    <span class="tv-sub">${doc.w}×${doc.h} · ${pages.length} 页</span>
    <span class="tv-spacer"></span>
    <span class="tv-tip">← → 翻页 · 空格前进 · F 全屏 · P 暂停动画 · H 收起栏</span>
  </div>
</header>

<main class="tv-stage" id="tv-stage">
${svg}
</main>

<!-- 底栏：浮动可收缩（收缩后只留把手 + 页码） -->
<footer class="tv-bar tv-bar-foot" id="tv-footbar">
  <button class="tv-handle" id="tv-toggle-foot" type="button" aria-expanded="true" aria-label="收起播放栏" title="收起/展开播放栏（H）">${chevron}</button>
  <span class="tv-mini" id="tv-mini-foot">1 / ${pages.length}</span>
  <div class="tv-bar-body">
    <button class="tv-btn" id="tv-prev">上一页</button>
    <span class="tv-page" id="tv-page">1 / ${pages.length}</span>
    <button class="tv-btn" id="tv-next">下一页</button>
    <span class="tv-name" id="tv-name"></span>
    <span class="tv-spacer"></span>
    <button class="tv-btn" id="tv-auto">自动播放</button>
    <button class="tv-btn" id="tv-pause">暂停动画</button>
    <button class="tv-btn" id="tv-full">全屏</button>
    ${download}
  </div>
</footer>

<script>window.__TVE_BOARD__ = ${safeInlineJson(meta)};</script>
<script>${VIEWER_JS}</script>
</body>
</html>
`;
}

/**
 * 组装分享站点的全部文件。
 * 返回「相对路径 → 文本内容」，直接交给 `lanSharePublishSite` 发布。
 */
export function buildBoardSite(doc: SvgDoc, options: BoardShareOptions): Record<string, string> {
  const pages = boardPages(doc);
  const meta = {
    title: options.title,
    note: options.note,
    w: doc.w,
    h: doc.h,
    pages,
    transition: options.transition,
    easing: options.easing,
    auto: options.auto,
    interval: options.interval,
    start: pages.length ? Math.min(options.start, pages.length - 1) : 0,
  };
  return {
    "index.html": viewerHtml(doc, options),
    // 与「保存白板」写出的格式完全一致：既是放映素材，也是可再导入的源文件
    "board.svg": serializeDoc(doc, true),
    "board.json": `${JSON.stringify(meta, null, 2)}\n`,
  };
}
