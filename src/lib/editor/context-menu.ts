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