import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DocsWindowApp from "./DocsWindowApp.vue";

// jsdom 无 __TAURI_INTERNALS__：isTauri() 为 false，正好覆盖「浏览器直开
// docs.html」分支——frameSrc 立即指向文档站、不发起任何 Tauri 调用（take/
// listen/show 全部跳过），无需 mock @tauri-apps/api。

describe("docs-window/DocsWindowApp（浏览器直开分支）", () => {
  it("渲染标题栏与文档站 iframe，浏览器直开即刻载入默认文档页", () => {
    const w = mount(DocsWindowApp);
    expect(w.find(".title-bar-title").text()).toBe("tve 文档");
    const frame = w.find("iframe.docs-frame");
    expect(frame.exists()).toBe(true);
    expect(frame.attributes("src")).toBe("/docs/index.html");
  });

  it("iframe load 在非 Tauri 环境不触发 show()（安全空操作）", async () => {
    const w = mount(DocsWindowApp);
    await w.find("iframe.docs-frame").trigger("load");
    expect(w.find("iframe.docs-frame").exists()).toBe(true);
  });
});
