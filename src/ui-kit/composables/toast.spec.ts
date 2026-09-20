import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dismiss,
  dismissAll,
  leave,
  toast,
  toastErr,
  toastInfo,
  toastOk,
  toastWarn,
  toasts,
} from "./toast";

describe("ui-kit composables/toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dismissAll();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("入队并返回递增 id", () => {
    const a = toastInfo("a");
    const b = toastInfo("b");
    expect(b).toBeGreaterThan(a);
    expect(toasts.value.map((t) => t.text)).toEqual(["a", "b"]);
  });

  it("默认停留时长按级别：err 8000 / warn 5000 / 其它 3500", () => {
    toastErr("e");
    toastWarn("w");
    toastInfo("i");
    toastOk("o");
    expect(toasts.value.map((t) => t.duration)).toEqual([
      8000, 5000, 3500, 3500,
    ]);
  });

  it("options.duration 覆盖默认值，action 透传", () => {
    const run = vi.fn();
    toast("ok", "x", { duration: 123, action: { label: "重试", run } });
    const item = toasts.value[0];
    expect(item.duration).toBe(123);
    expect(item.action?.label).toBe("重试");
    expect(item.action?.run).toBe(run);
  });

  it("到期自动离场（淡出 180ms 后移除）", () => {
    const id = toastInfo("hi");
    vi.advanceTimersByTime(3500);
    expect(toasts.value[0]?.leaving).toBe(true);
    vi.advanceTimersByTime(180);
    expect(toasts.value.find((t) => t.id === id)).toBeUndefined();
  });

  it("leave 提前离场，重复调用无副作用", () => {
    const id = toastInfo("hi");
    leave(id);
    leave(id);
    expect(toasts.value[0]?.leaving).toBe(true);
    expect(toasts.value).toHaveLength(1);
    vi.advanceTimersByTime(180);
    expect(toasts.value).toHaveLength(0);
  });

  it("同屏超过 5 条挤掉最早的", () => {
    for (let i = 0; i < 7; i += 1) toastInfo(`t${i}`);
    expect(toasts.value).toHaveLength(5);
    expect(toasts.value[0]?.text).toBe("t2");
  });

  it("dismiss 按 id 移除，dismissAll 清空", () => {
    const a = toastInfo("a");
    toastInfo("b");
    dismiss(a);
    expect(toasts.value.map((t) => t.text)).toEqual(["b"]);
    dismissAll();
    expect(toasts.value).toHaveLength(0);
  });
});
