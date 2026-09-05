/**
 * 节点/资产类型 SVG 图标路径定义（24×24 viewBox，随 currentColor 着色，线稿风格）。
 *
 * 单一数据源：
 * - AssetTypeIcon.vue（DOM 图标）按 kind 渲染这些 <path>；
 * - 3D 视口（SceneSynchronizer + spriteIcon）用同一批路径生成精灵贴图。
 * 新增图标只需在这里补一份路径数组。
 */

export const CAMERA_ICON_PATHS: string[] = [
  // 机身
  "M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z",
  // 镜头
  "M12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
];

export const LIGHT_ICON_PATHS: string[] = [
  // 灯泡外壳
  "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5",
  // 灯座
  "M9 18h6",
  "M10 22h4",
];

/** 依据路径数组生成完整 SVG 字符串（用于 Canvas 贴图 / 数据 URI） */
export function buildIconSvg(
  paths: string[],
  opts: { size?: number; strokeWidth?: number; stroke?: string } = {},
): string {
  const size = opts.size ?? 24;
  const stroke = opts.stroke ?? "currentColor";
  const strokeWidth = opts.strokeWidth ?? 1.6;
  const body = paths.map((d) => `<path d="${d}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}
