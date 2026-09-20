import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import TitleBar from "./TitleBar.vue";
import WindowControls from "./WindowControls.vue";

// jsdom 无 __TAURI_INTERNALS__：isTauri() 为 false，正好覆盖「浏览器直开」分支
// （所有窗口动作都是守卫后的空操作），无需 mock @tauri-apps/api。

describe("ui-kit components/WindowControls（浏览器直开分支）", () => {
  it("按 props 渲染窗口按钮", () => {
    expect(mount(WindowControls).findAll("button")).toHaveLength(3);
    const none = mount(WindowControls, {
      props: { closable: false, minimizable: false, maximizable: false },
    });
    expect(none.findAll("button")).toHaveLength(0);
  });

  it("非 Tauri 环境点击动作是安全空操作（不抛错）", async () => {
    const w = mount(WindowControls);
    const buttons = w.findAll("button");
    for (const b of buttons) {
      await b.trigger("click");
    }
    expect(buttons[buttons.length - 1]?.attributes("title")).toBe("关闭");
  });

  it("最大化按钮标题默认为「最大化」", () => {
    const w = mount(WindowControls);
    expect(
      w.findAll("button").find((b) => b.classes().includes("title-btn-max"))
        ?.attributes("title"),
    ).toBe("最大化");
  });
});

describe("ui-kit components/TitleBar（浏览器直开分支）", () => {
  it("渲染标题并向 WindowControls 透传 props", () => {
    const w = mount(TitleBar, { props: { title: "主编辑器", closable: false } });
    expect(w.find(".title-bar-title").text()).toBe("主编辑器");
    expect(w.findComponent(WindowControls).props("closable")).toBe(false);
    // closable=false → 只剩最小化 + 最大化
    expect(w.findAll("button")).toHaveLength(2);
  });

  it("拖拽区域 mousedown / 双击在非 Tauri 环境不触发窗口动作", async () => {
    const w = mount(TitleBar, { props: { title: "x" } });
    const drag = w.find(".title-bar-drag");
    await drag.trigger("mousedown", { button: 0 });
    await drag.trigger("dblclick");
    expect(w.findComponent(WindowControls).exists()).toBe(true);
  });

  it("空标题不渲染标题文本", () => {
    const w = mount(TitleBar);
    expect(w.find(".title-bar-title").exists()).toBe(false);
  });
});
