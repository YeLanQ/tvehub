// ---------------------------------------------------------------------------
// 白板工具图标（内联 SVG，Feather 风格描边，stroke: currentColor / 白芯深边）：
// - TOOL_ICONS：工具条按钮用（18px 描边图标）+ 光标字形共用；
// - toolCursorCss：把工具图标转成 CSS 光标（data-URL SVG）。热点 (2,2) = 落笔点，
//   铅笔字形旋转 90° 使笔尖落在热点、钢笔笔尖本就在 (2,2)；图标以深色描边垫底 +
//   白色描边上层渲染，深浅底均可见；另绘一个小圆点标记精确落笔位置。
// - HANDLE_CURSOR：句柄拖拽光标（蓝芯白环圆点，与句柄同形）。
// ---------------------------------------------------------------------------

export type ToolIconKey =
  | "select"
  | "rect"
  | "ellipse"
  | "line"
  | "pencil"
  | "pen"
  | "text"
  | "fit";

export const TOOL_ICONS: Record<ToolIconKey, string> = {
  select: `<path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51z"/><path d="M13 13l6 6"/>`,
  rect: `<rect x="4" y="5" width="16" height="14" rx="1.5"/>`,
  ellipse: `<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>`,
  line: `<path d="M5 19L19 5"/>`,
  pencil: `<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 3 21l.5-4.5L17 3z"/>`,
  pen: `<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><circle cx="11" cy="11" r="2"/>`,
  text: `<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>`,
  fit: `<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>`,
};

/** 幻灯片浮动工具：放映/停止、上一页/下一页、设置行展开/收起 */
export const PLAY_ICON = `<polygon points="6 4 20 12 6 20 6 4"/>`;
export const STOP_ICON = `<rect x="6" y="6" width="12" height="12" rx="1.5"/>`;
export const PREV_ICON = `<polygon points="17 5 8 12 17 19 17 5"/><line x1="5" y1="5" x2="5" y2="19"/>`;
export const NEXT_ICON = `<polygon points="7 5 16 12 7 19 7 5"/><line x1="19" y1="5" x2="19" y2="19"/>`;
export const CHEVRON_UP_ICON = `<path d="M6 15l6-6 6 6"/>`;
export const CHEVRON_DOWN_ICON = `<path d="M6 9l6 6 6-6"/>`;

/** 图层面板：眼睛（可见）/ 带斜线的眼睛（隐藏）、锁 / 开锁 */
export const EYE_ICON = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;export const EYE_OFF_ICON = `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`;
export const LOCK_ICON = `<rect x="4.5" y="11" width="15" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`;
export const UNLOCK_ICON = `<rect x="4.5" y="11" width="15" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.83-1.3"/>`;

/** 句柄拖拽光标：蓝芯白环圆点（与句柄同形，热点居中），比十字线明显 */
export const HANDLE_CURSOR = (() => {
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 14 14'>" +
    "<circle cx='7' cy='7' r='4.5' fill='#4a9eff' stroke='#ffffff' stroke-width='2'/>" +
    "</svg>";
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 7 7, crosshair`;
})();

/** 光标字形：默认用工具图标本身；铅笔旋转 90° 使笔尖位于左上热点处 */
const CURSOR_GLYPHS: Partial<Record<ToolIconKey, string>> = {
  pencil: `<g transform="rotate(90 12 12)">${TOOL_ICONS.pencil}</g>`,
};

/** 工具光标 CSS：热点 (2,2)，深边白芯双层描边 + 落笔点圆点 */
export function toolCursorCss(tool: string): string {
  const glyph =
    CURSOR_GLYPHS[tool as ToolIconKey] ?? TOOL_ICONS[tool as ToolIconKey];
  if (!glyph) return "crosshair";
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>` +
    `<g fill='none' stroke='#141414' stroke-width='3.4' stroke-linecap='round' stroke-linejoin='round' opacity='0.5'>${glyph}</g>` +
    `<g fill='none' stroke='#ffffff' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'>${glyph}</g>` +
    `<circle cx='2.5' cy='2.5' r='1.5' fill='#141414' opacity='0.55'/>` +
    `<circle cx='2.5' cy='2.5' r='0.85' fill='#ffffff'/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 2 2, crosshair`;
}
