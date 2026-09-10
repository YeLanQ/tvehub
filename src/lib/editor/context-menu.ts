import { reactive } from "vue";

export interface CtxMenuItem {
  label?: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  header?: boolean;
  children?: CtxMenuItem[];
  onClick?: () => void;
}

export interface CtxMenuState {
  open: boolean;
  x: number;
  y: number;
  items: CtxMenuItem[];
}

export const ctxMenu = reactive<CtxMenuState>({
  open: false,
  x: 0,
  y: 0,
  items: [],
});

export function openContextMenu(e: MouseEvent, items: CtxMenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  ctxMenu.x = e.clientX;
  ctxMenu.y = e.clientY;
  ctxMenu.items = items;
  ctxMenu.open = true;
}

export function closeContextMenu() {
  ctxMenu.open = false;
}

export function menuSeparator(): CtxMenuItem {
  return { separator: true };
}

// ---------------------------------------------------------------------------
// 菜单定位（纯几何，便于测试）：菜单渲染后按实测尺寸收敛到窗口内；
// 子菜单默认贴父菜单右侧，放不下或会覆盖其它已展开层级时翻到父菜单左侧
// —— 子菜单永远不盖住它的上一级（只允许 lip 的边缘贴合重叠）。
// ---------------------------------------------------------------------------

/** 菜单与窗口边缘的最小间距 */
export const MENU_EDGE_MARGIN = 8;
/** 子菜单与父菜单的边缘贴合重叠量（避免出现缝隙） */
export const SUBMENU_LIP = 2;

/** 根级/水平收拢：把 x 收进 [margin, windowWidth - width - margin] */
export function clampMenuX(x: number, width: number, windowWidth: number): number {
  return Math.max(
    MENU_EDGE_MARGIN,
    Math.min(x, windowWidth - width - MENU_EDGE_MARGIN),
  );
}

/** 垂直收拢：贴锚点，越出窗口下/上边则收回窗口内 */
export function clampMenuY(y: number, height: number, windowHeight: number): number {
  return Math.max(
    MENU_EDGE_MARGIN,
    Math.min(y, windowHeight - height - MENU_EDGE_MARGIN),
  );
}

export interface SubmenuPlacement {
  /** 贴父菜单右侧时的左边缘（通常 = 父项右边缘 - SUBMENU_LIP） */
  anchorRight: number;
  /** 父菜单左边缘（翻到左侧时的基准） */
  parentLeft: number;
  /** 子菜单实测宽度 */
  width: number;
  windowWidth: number;
  /** 其它已展开层级（不含直接父级）的水平区间 [left, right] */
  ancestorRanges: [number, number][];
}

/**
 * 子菜单水平位置：在「贴父菜单右侧 / 翻到父菜单左侧」两个候选间优选——
 * ①不越出窗口且不覆盖其它已展开层级的一侧；②仅不越出窗口的一侧；③窗口内收拢兜底。
 */
export function pickSubmenuX(p: SubmenuPlacement): number {
  const maxX = p.windowWidth - p.width - MENU_EDGE_MARGIN;
  const right = p.anchorRight;
  const left = p.parentLeft - p.width + SUBMENU_LIP;
  const fits = (x: number): boolean => x >= MENU_EDGE_MARGIN && x <= maxX;
  const overlapsOthers = (x: number): boolean =>
    p.ancestorRanges.some(([l, r]) => x < r - SUBMENU_LIP && x + p.width > l + SUBMENU_LIP);
  if (fits(right) && !overlapsOthers(right)) return right;
  if (fits(left) && !overlapsOthers(left)) return left;
  if (fits(right)) return right;
  if (fits(left)) return left;
  return Math.max(MENU_EDGE_MARGIN, Math.min(right, maxX));
}