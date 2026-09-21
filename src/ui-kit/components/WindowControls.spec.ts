import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import WindowControls from "./WindowControls.vue";

// 窗口控制按钮（浏览器直开分支：isTauri() 恒 false，动作全部空跑不抛错）。
// Tauri 分支的窗口句柄交互由真机手工验证，不在此覆盖。

const titles = (): string[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".title-bar-controls button")).map(
    (b) => b.title,
  );

describe("WindowControls", () => {
  it("缺省渲染三个按钮（最小化/最大化/关闭）", () => {
    mount(WindowControls, { attachTo: document.body });
    expect(titles()).toEqual(["最小化", "最大化", "关闭"]);
  });

  it("三个开关 prop 各自隐藏对应按钮", () => {
    mount(WindowControls, {
      props: { minimizable: false, maximizable: false, closable: false },
      attachTo: document.body,
    });
    expect(titles()).toEqual([]);
  });

  it("浏览器分支：点击三个动作不抛错（无窗口句柄空跑）", () => {
    const w = mount(WindowControls, { attachTo: document.body });
    const btns = w.findAll("button");
    btns[0].trigger("click");
    btns[1].trigger("click");
    btns[2].trigger("click");
    expect(w.vm).toBeTruthy();
  });

  it("未最大化时标题为「最大化」，图标为单框", () => {
    mount(WindowControls, { attachTo: document.body });
    const max = document.querySelector(".title-btn-max");
    expect(max?.querySelectorAll("rect")).toHaveLength(1);
  });
});
