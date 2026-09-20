import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ToastHost from "./ToastHost.vue";
import { dismissAll, toast, toastInfo, toastWarn } from "../composables/toast";

describe("ui-kit components/ToastHost", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dismissAll();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const mountHost = () => mount(ToastHost);
  const items = (): NodeListOf<Element> =>
    document.querySelectorAll(".toast-item");

  it("渲染队列与级别配色类", async () => {
    mountHost();
    toastWarn("警告");
    toastInfo("提示");
    await nextTick();
    const list = items();
    expect(list).toHaveLength(2);
    expect(list[0]?.classList.contains("warn")).toBe(true);
    expect(list[1]?.classList.contains("info")).toBe(true);
    expect(list[1]?.textContent).toContain("提示");
  });

  it("点击气泡立即关闭", async () => {
    mountHost();
    toastInfo("点我");
    await nextTick();
    items()[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(items()).toHaveLength(0);
  });

  it("action 按钮执行回调并关闭气泡", async () => {
    const run = vi.fn();
    mountHost();
    toast("ok", "已导出", { action: { label: "打开目录", run } });
    await nextTick();
    items()[0]
      ?.querySelector(".toast-action")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(run).toHaveBeenCalledOnce();
    expect(items()).toHaveLength(0);
  });

  it("填充条走完（animationend）触发离场并移除", async () => {
    mountHost();
    toastInfo("hi");
    await nextTick();
    items()[0]
      ?.querySelector(".toast-fill")
      ?.dispatchEvent(new Event("animationend")); // 监听绑在填充条上
    await nextTick(); // leaving 进了响应式状态，等一拍渲染
    expect(items()[0]?.classList.contains("leaving")).toBe(true);
    vi.advanceTimersByTime(180);
    await flushPromises();
    expect(items()).toHaveLength(0);
  });
});
