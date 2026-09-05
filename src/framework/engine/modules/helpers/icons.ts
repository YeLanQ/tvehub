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

/** 点光源：灯泡（点状光源） */
export const LIGHT_POINT_ICON_PATHS: string[] = [
  "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5",
  "M9 18h6",
  "M10 22h4",
];

/** 平行光：太阳（平行光线） */
export const LIGHT_DIRECTIONAL_ICON_PATHS: string[] = [
  "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
  "M12 2.5v2.5",
  "M12 19v2.5",
  "M4.3 4.3l1.8 1.8",
  "M17.9 17.9l1.8 1.8",
  "M2.5 12H5",
  "M19 12h2.5",
  "m4.3 19.7 1.8-1.8",
  "m17.9 6.1 1.8-1.8",
];

/** 环境光：球体（来自四面八方，无方向） */
export const LIGHT_AMBIENT_ICON_PATHS: string[] = [
  "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z",
  "M2 12h20",
  "M12 2a14.5 14.5 0 0 1 0 20 14.5 14.5 0 0 1 0-20z",
];

/** 聚光灯：灯珠 + 圆锥光束 */
export const LIGHT_SPOT_ICON_PATHS: string[] = [
  "M12 2.5v4",
  "M5 21.5l3.6-9.8h6.8L19 21.5H5z",
  "M8.6 15h6.8",
];

/** 兼容别名：通用“灯光”默认按点光源灯泡渲染 */
export const LIGHT_ICON_PATHS: string[] = LIGHT_POINT_ICON_PATHS;

/** 网格节点：三维线框立方体 */
export const MESH_ICON_PATHS: string[] = [
  "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z",
  "m3.3 7 8.7 5 8.7-5",
  "M12 22V12",
];

/** 空节点 / 组：层叠块 */
export const GROUP_ICON_PATHS: string[] = [
  "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z",
  "M22 17.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65",
  "M22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65",
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
