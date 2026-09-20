// ---------------------------------------------------------------------------
// 白板放映页样式（发布出去的站点的内联 CSS）。
//
// 颜色来自脚本生成的主题令牌（src/generated/lan-theme.ts，事实源 = ui-kit 主题变量表），
// 页面内**不写死任何色值**：分享出去的效果与应用内放映同一套配色，改主题只需改
// variables.scss 并重跑生成器（pnpm build / dev 启动都会自动重建）。
//
// 布局：顶栏/底栏都是**浮动栏**（覆盖在画布之上、圆角卡片、可收缩隐藏），画板占满整屏。
// 收缩后只剩一个小胶囊（保留标题与页码，随时能点开）。画布的可视区由 JS 按两栏的
// 实际高度写入 --tv-pad-top / --tv-pad-bottom —— 浮动栏不占布局，必须显式避让，
// 否则画板会被栏挡住（底栏在窄屏还会换行变高，所以按实测高度算而不是写死常量）。
//
// 三处刻意例外（不随主题，理由在处）：
// - 画板纸面：--tv-board 固定纯白（用户内容的载体，跟着深色主题走会失去"纸"的观感）；
// - 切页动画曲线：--tv-slide-ease 是动效参数不是颜色，与 styles/whiteboard.scss 那份同源
//   （位移量同为 --sv-dx/--sv-dy、时长同样由页面下发），改一处记得对照另一处；
// - 栏投影：rgba 半透明黑属"压暗"而非主题色，与编辑器 .sv-float-bar 取同一常量。
// ---------------------------------------------------------------------------
import { lanCssVars } from "../../generated/lan-theme";

/** 画板纸面：固定白底（见文件头说明，不随主题） */
const BOARD_PAPER = "#ffffff";

export const VIEWER_CSS = `
:root {
${lanCssVars("--tv")}
  color-scheme: dark;
  --tv-board: ${BOARD_PAPER};
  --tv-slide-ease: cubic-bezier(0.22, 0.61, 0.36, 1);
  /* 浮动栏与画布的贴合间距（栏外沿到视口边缘） */
  --tv-bar-gap: 12px;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--tv-bg);
  color: var(--tv-text);
  font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  overflow: hidden;
  -webkit-tap-highlight-color: transparent;
}

/* ---------------------------------------------------------------------------
   画布区：整块可点（左半上一页 / 右半下一页），也支持左右滑。
   全屏铺满，靠 --tv-pad-* 给上下浮动栏让出位置（由 JS 实测写入）。
   --------------------------------------------------------------------------- */
.tv-stage {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--tv-pad-top, 56px) 12px var(--tv-pad-bottom, 56px);
  touch-action: pan-y;
}
.tv-stage > svg {
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  background: var(--tv-board);
  border-radius: 6px;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.45);
}

/* 图层可见性：JS 未接管前一律隐藏，避免多页同时铺在眼前闪一下 */
.tv-stage g[data-tve-layer] { visibility: hidden; }
.tv-stage.tv-ready g[data-tve-layer] { visibility: visible; }

/* ---------------------------------------------------------------------------
   浮动栏（顶/底）：覆盖在画布之上，可收缩
   --------------------------------------------------------------------------- */
.tv-bar {
  position: absolute;
  left: var(--tv-bar-gap);
  right: var(--tv-bar-gap);
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--tv-panel);
  border: 1px solid var(--tv-border);
  border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
}
.tv-bar-top { top: var(--tv-bar-gap); }
.tv-bar-foot {
  bottom: var(--tv-bar-gap);
  flex-wrap: wrap;
}

/* 收缩态：收成居中胶囊，只留把手与关键信息（标题 / 页码） */
.tv-bar.collapsed {
  left: 50%;
  right: auto;
  transform: translateX(-50%);
  max-width: calc(100% - 2 * var(--tv-bar-gap));
  padding: 6px 12px;
}
.tv-bar.collapsed .tv-bar-body { display: none; }
.tv-bar:not(.collapsed) .tv-mini { display: none; }

/* 收缩把手：图标按钮，展开时箭头指"收起方向"，收缩后翻转 */
.tv-handle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--tv-text-dim);
  cursor: pointer;
}
.tv-handle:hover { background: var(--tv-hover); color: var(--tv-text); }
.tv-handle svg { display: block; }
.tv-bar.collapsed .tv-handle svg { transform: rotate(180deg); }

/* 收缩后仍可见的摘要（标题 / 页码） */
.tv-mini {
  font-size: 13px;
  color: var(--tv-text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tv-bar-foot .tv-mini { font-variant-numeric: tabular-nums; }

.tv-bar-body {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.tv-bar-foot .tv-bar-body { justify-content: center; }
.tv-title {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-sub { color: var(--tv-text-dim); font-size: 12px; white-space: nowrap; }
.tv-spacer { flex: 1; }
.tv-tip { color: var(--tv-text-dim); font-size: 12px; }

.tv-btn {
  padding: 5px 11px;
  border-radius: 8px;
  border: 1px solid var(--tv-border);
  background: var(--tv-panel-2);
  color: var(--tv-text);
  font-size: 13px;
  cursor: pointer;
}
.tv-btn:hover:not(:disabled) { background: var(--tv-hover); }
.tv-btn:disabled { opacity: 0.45; cursor: default; }
/* 开启态用主题强调色 + 深色前景（强调色是中性灰，对比度足够） */
.tv-btn.on {
  background: var(--tv-accent);
  border-color: var(--tv-accent);
  color: var(--tv-bg);
  font-weight: 600;
}
.tv-page {
  min-width: 68px;
  text-align: center;
  font-size: 13px;
  color: var(--tv-text-dim);
  font-variant-numeric: tabular-nums;
}
.tv-name {
  font-size: 12px;
  color: var(--tv-text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 32vw;
}

/* ---------------------------------------------------------------------------
   切页动画：位移量 --sv-dx/--sv-dy 与时长/曲线由页面下发（与编辑器同一套）
   --------------------------------------------------------------------------- */
@keyframes tv-slide-in-x {
  from { transform: translate(var(--sv-dx, 100%), 0); }
  to { transform: translate(0, 0); }
}
@keyframes tv-slide-out-x {
  from { transform: translate(0, 0); }
  to { transform: translate(calc(-1 * var(--sv-dx, 100%)), 0); }
}
@keyframes tv-slide-in-y {
  from { transform: translate(0, var(--sv-dy, 100%)); }
  to { transform: translate(0, 0); }
}
@keyframes tv-slide-out-y {
  from { transform: translate(0, 0); }
  to { transform: translate(0, calc(-1 * var(--sv-dy, 100%))); }
}
@keyframes tv-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes tv-fade-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes tv-stack-out {
  from { transform: scale(1); opacity: 1; }
  to { transform: scale(0.9); opacity: 0.45; }
}

.tv-stage .tv-in-x, .tv-stage .tv-out-x,
.tv-stage .tv-in-y, .tv-stage .tv-out-y,
.tv-stage .tv-fade-in, .tv-stage .tv-fade-out,
.tv-stage .tv-stack-out {
  animation-duration: var(--tv-dur, 520ms);
  animation-timing-function: var(--tv-slide-ease);
  animation-fill-mode: both;
}
.tv-stage .tv-in-x { animation-name: tv-slide-in-x; }
.tv-stage .tv-out-x { animation-name: tv-slide-out-x; }
.tv-stage .tv-in-y { animation-name: tv-slide-in-y; }
.tv-stage .tv-out-y { animation-name: tv-slide-out-y; }
.tv-stage .tv-fade-in { animation-name: tv-fade-in; }
.tv-stage .tv-fade-out { animation-name: tv-fade-out; }
.tv-stage .tv-stack-out {
  transform-box: fill-box;
  transform-origin: center;
  animation-name: tv-stack-out;
}

/* 动效偏好：系统开启「减少动态效果」时不做位移动画（可读性优先） */
@media (prefers-reduced-motion: reduce) {
  .tv-stage .tv-in-x, .tv-stage .tv-out-x,
  .tv-stage .tv-in-y, .tv-stage .tv-out-y,
  .tv-stage .tv-stack-out { animation-name: tv-fade-in; }
  .tv-stage .tv-out-x, .tv-stage .tv-out-y { animation-name: tv-fade-out; }
}

/* 手机竖屏：栏更紧凑，键盘提示无意义（隐藏），画板尽量大 */
@media (max-width: 640px) {
  :root { --tv-bar-gap: 8px; }
  .tv-bar { padding: 6px 10px; }
  .tv-stage { padding-left: 8px; padding-right: 8px; }
  .tv-title { font-size: 13px; }
  .tv-sub { display: none; }
  .tv-tip { display: none; }
}
`;
