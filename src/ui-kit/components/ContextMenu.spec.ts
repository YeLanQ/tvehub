import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import ContextMenu from "./ContextMenu.vue";
import {
  closeContextMenu,
  openContextMenu,
} from "../composables/context-menu";

function ctxEvent(): MouseEvent {
  return new MouseEvent("contextmenu", {
    clientX: 40,
    clientY: 50,
    bubbles: true,
    cancelable: true,
  });
}

const menus = (): NodeListOf<Element> =>
  document.querySelectorAll(".ctx-menu");

describe("ui-kit components/ContextMenu", () => {
  it("打开后渲染条目：标题/分隔线/快捷键/禁用态", async () => {
    mount(ContextMenu);
    openContextMenu(ctxEvent(), [
      { label: "操作", header: true },
      { label: "复制", shortcut: "Ctrl+C" },
      { separator: true },
      { label: "删除", danger: true, disabled: true },
    ]);
    await flushPromises();

    expect(menus()).toHaveLength(1);
    expect(document.querySelector(".ctx-header")?.textContent).toBe("操作");
    expect(document.querySelector(".ctx-sep")).toBeTruthy();
    const items = document.querySelectorAll(".ctx-item");
    expect(items[0]?.querySelector(".ctx-shortcut")?.textContent).toBe(
      "Ctrl+C",
    );
    expect(items[1]?.classList.contains("disabled")).toBe(true);
    expect(items[1]?.classList.contains("danger")).toBe(true);
    closeContextMenu();
  });

  it("点击普通条目执行回调并关闭整个菜单", async () => {
    const onCopy = vi.fn();
    const onDelete = vi.fn();
    mount(ContextMenu);
    openContextMenu(ctxEvent(), [
      { label: "复制", onClick: onCopy },
      { label: "删除", onClick: onDelete },
    ]);
    await flushPromises();

    document
      .querySelectorAll(".ctx-item")[0]
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(onCopy).toHaveBeenCalledOnce();
    expect(onDelete).not.toHaveBeenCalled();
    expect(document.querySelector(".ctx-layer")).toBeNull();
  });

  it("禁用条目点击不执行也不关闭", async () => {
    const onClick = vi.fn();
    mount(ContextMenu);
    openContextMenu(ctxEvent(), [{ label: "删除", disabled: true, onClick }]);
    await flushPromises();

    document
      .querySelector(".ctx-item")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(onClick).not.toHaveBeenCalled();
    expect(document.querySelector(".ctx-layer")).toBeTruthy();
    closeContextMenu();
  });

  it("Escape 关闭菜单", async () => {
    mount(ContextMenu);
    openContextMenu(ctxEvent(), [{ label: "复制" }]);
    await flushPromises();
    expect(menus()).toHaveLength(1);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(document.querySelector(".ctx-layer")).toBeNull();
  });

  it("悬停含子项的条目展开二级菜单，点击子项执行", async () => {
    const onScene = vi.fn();
    mount(ContextMenu);
    openContextMenu(ctxEvent(), [
      { label: "新建", children: [{ label: "场景", onClick: onScene }] },
    ]);
    await flushPromises();
    expect(menus()).toHaveLength(1);

    document
      .querySelector(".ctx-item")
      ?.dispatchEvent(new MouseEvent("mouseenter"));
    await flushPromises();
    expect(menus()).toHaveLength(2);
    expect(menus()[1]?.textContent).toContain("场景");

    menus()[1]
      ?.querySelector(".ctx-item")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(onScene).toHaveBeenCalledOnce();
    expect(document.querySelector(".ctx-layer")).toBeNull();
  });
});
