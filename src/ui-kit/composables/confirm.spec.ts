import { describe, expect, it } from "vitest";
import { closeConfirm, confirm, confirmState } from "./confirm";

describe("ui-kit composables/confirm", () => {
  it("打开时填入标题并补默认按钮文案", async () => {
    const p = confirm({ title: "删除", message: "确认删除？" });
    expect(confirmState.open).toBe(true);
    expect(confirmState.options).toEqual({
      confirmText: "确定",
      cancelText: "取消",
      danger: false,
      title: "删除",
      message: "确认删除？",
    });
    closeConfirm(true);
    await expect(p).resolves.toBe(true);
  });

  it("可覆盖按钮文案与 danger 标记", async () => {
    const p = confirm({
      title: "t",
      message: "m",
      confirmText: "删掉",
      cancelText: "留着",
      danger: true,
    });
    expect(confirmState.options).toMatchObject({
      confirmText: "删掉",
      cancelText: "留着",
      danger: true,
    });
    closeConfirm(false);
    await expect(p).resolves.toBe(false);
  });

  it("确定/取消分别以 true/false 兑现 Promise 并复位状态", async () => {
    const p1 = confirm({ title: "a", message: "b" });
    closeConfirm(true);
    await expect(p1).resolves.toBe(true);
    expect(confirmState.open).toBe(false);
    expect(confirmState.resolve).toBeNull();

    const p2 = confirm({ title: "a", message: "b" });
    closeConfirm(false);
    await expect(p2).resolves.toBe(false);
    expect(confirmState.open).toBe(false);
    expect(confirmState.resolve).toBeNull();
  });
});
