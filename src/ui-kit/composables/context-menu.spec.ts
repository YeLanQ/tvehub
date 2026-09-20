import { describe, expect, it, vi } from "vitest";
import {
  clampMenuX,
  clampMenuY,
  closeContextMenu,
  ctxMenu,
  menuSeparator,
  openContextMenu,
  pickSubmenuX,
  MENU_EDGE_MARGIN,
} from "./context-menu";

function fakeClick(x: number, y: number): MouseEvent {
  return {
    clientX: x,
    clientY: y,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as MouseEvent;
}

describe("ui-kit composables/context-menu", () => {
  it("openContextMenu 记录坐标与条目并打开", () => {
    const e = fakeClick(30, 40);
    const items = [{ label: "复制" }, menuSeparator()];
    openContextMenu(e, items);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(e.stopPropagation).toHaveBeenCalledOnce();
    expect(ctxMenu.open).toBe(true);
    expect(ctxMenu.x).toBe(30);
    expect(ctxMenu.y).toBe(40);
    // reactive 代理会包一层，按结构比较而非引用
    expect(ctxMenu.items).toStrictEqual(items);
    closeContextMenu();
    expect(ctxMenu.open).toBe(false);
  });

  it("clampMenuX/Y 把菜单钳回视口内（留边缘距）", () => {
    expect(clampMenuX(-50, 100, 1024)).toBe(MENU_EDGE_MARGIN);
    expect(clampMenuX(500, 100, 1024)).toBe(500);
    expect(clampMenuX(2000, 100, 1024)).toBe(1024 - 100 - MENU_EDGE_MARGIN);
    expect(clampMenuY(-50, 100, 768)).toBe(MENU_EDGE_MARGIN);
    expect(clampMenuY(2000, 100, 768)).toBe(768 - 100 - MENU_EDGE_MARGIN);
  });

  it("pickSubmenuX：右侧放得下且不遮祖先时优先右侧", () => {
    const x = pickSubmenuX({
      anchorRight: 300,
      parentLeft: 200,
      width: 100,
      windowWidth: 1024,
      ancestorRanges: [],
    });
    expect(x).toBe(300);
  });

  it("右侧与祖先菜单重叠时改用左侧（保留 2px 唇距）", () => {
    const x = pickSubmenuX({
      anchorRight: 300,
      parentLeft: 200,
      width: 100,
      windowWidth: 1024,
      ancestorRanges: [[250, 600]],
    });
    expect(x).toBe(200 - 100 + 2);
  });

  it("两侧都放不下时回退为右钳位", () => {
    const x = pickSubmenuX({
      anchorRight: 50,
      parentLeft: 10,
      width: 100,
      windowWidth: 100,
      ancestorRanges: [],
    });
    expect(x).toBe(MENU_EDGE_MARGIN);
  });
});
