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

export const MENU_EDGE_MARGIN = 8;
export const SUBMENU_LIP = 2;

export function clampMenuX(x: number, width: number, windowWidth: number): number {
  return Math.max(
    MENU_EDGE_MARGIN,
    Math.min(x, windowWidth - width - MENU_EDGE_MARGIN),
  );
}

export function clampMenuY(y: number, height: number, windowHeight: number): number {
  return Math.max(
    MENU_EDGE_MARGIN,
    Math.min(y, windowHeight - height - MENU_EDGE_MARGIN),
  );
}

export interface SubmenuPlacement {
  anchorRight: number;
  parentLeft: number;
  width: number;
  windowWidth: number;
  ancestorRanges: [number, number][];
}

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