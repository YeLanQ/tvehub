import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import { closeConfirm, confirm } from "../composables/confirm";

const backdrop = (): Element | null =>
  document.querySelector(".confirm-backdrop");
const dialogButtons = (): NodeListOf<HTMLButtonElement> =>
  document.querySelectorAll(".confirm-dialog button");

describe("ui-kit components/ConfirmDialog", () => {
  it("关闭时不渲染任何弹层", () => {
    mount(ConfirmDialog);
    expect(backdrop()).toBeNull();
  });

  it("confirm() 打开：渲染标题、正文与默认按钮文案", async () => {
    mount(ConfirmDialog);
    const p = confirm({ title: "删除资产", message: "该操作不可撤销" });
    await nextTick();
    expect(backdrop()).toBeTruthy();
    expect(
      document.querySelector(".confirm-dialog h3")?.textContent,
    ).toBe("删除资产");
    const [cancel, ok] = Array.from(dialogButtons());
    expect(cancel?.textContent?.trim()).toBe("取消");
    expect(ok?.textContent?.trim()).toBe("确定");
    expect(ok?.classList.contains("danger")).toBe(false);
    closeConfirm(true);
    await expect(p).resolves.toBe(true);
  });

  it("danger 标记落到确认按钮上", async () => {
    mount(ConfirmDialog);
    const p = confirm({ title: "t", message: "m", danger: true });
    await nextTick();
    expect(
      document
        .querySelector(".confirm-dialog button.primary")
        ?.classList.contains("danger"),
    ).toBe(true);
    closeConfirm(false);
    await expect(p).resolves.toBe(false);
  });

  it("点击取消/确定分别兑现 false/true", async () => {
    mount(ConfirmDialog);
    const p1 = confirm({ title: "t", message: "m" });
    await nextTick();
    dialogButtons()[0]?.click();
    await expect(p1).resolves.toBe(false);

    const p2 = confirm({ title: "t", message: "m" });
    await nextTick();
    dialogButtons()[1]?.click();
    await expect(p2).resolves.toBe(true);
    await flushPromises();
    expect(backdrop()).toBeNull();
  });

  it("Escape 兑现 false", async () => {
    mount(ConfirmDialog);
    const p = confirm({ title: "t", message: "m" });
    await nextTick();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(p).resolves.toBe(false);
  });

  it("点击遮罩空白处兑现 false，点弹层内部不关闭", async () => {
    mount(ConfirmDialog);
    const p = confirm({ title: "t", message: "m" });
    await nextTick();
    document
      .querySelector(".confirm-dialog")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await nextTick();
    expect(backdrop()).toBeTruthy(); // 内部 mousedown 不关

    backdrop()?.dispatchEvent(new MouseEvent("mousedown"));
    await expect(p).resolves.toBe(false);
  });
});
