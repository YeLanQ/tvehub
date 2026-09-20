import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import PromptDialog from "./PromptDialog.vue";
import { closePrompt, prompt, promptState } from "../composables/prompt";

const input = (): HTMLInputElement => {
  const el = document.querySelector<HTMLInputElement>(".prompt-dialog input");
  expect(el).toBeTruthy();
  return el as HTMLInputElement;
};
const buttons = (): NodeListOf<HTMLButtonElement> =>
  document.querySelectorAll(".prompt-dialog button");

function fill(value: string): void {
  const el = input();
  el.value = value;
  el.dispatchEvent(new Event("input"));
}

describe("ui-kit components/PromptDialog", () => {
  it("关闭时不渲染任何弹层", () => {
    mount(PromptDialog);
    expect(document.querySelector(".prompt-backdrop")).toBeNull();
  });

  it("打开：渲染标题/标签/占位与初值，输入框自动聚焦全选", async () => {
    mount(PromptDialog);
    const p = prompt({
      title: "重命名",
      label: "新名称",
      initial: "abc",
      placeholder: "输入名称",
    });
    await nextTick();
    await flushPromises();
    expect(
      document.querySelector(".prompt-dialog h3")?.textContent,
    ).toBe("重命名");
    expect(document.querySelector(".prompt-dialog label")?.textContent).toBe(
      "新名称",
    );
    expect(input().placeholder).toBe("输入名称");
    expect(input().value).toBe("abc");
    expect(document.activeElement).toBe(input());
    closePrompt(null);
    await expect(p).resolves.toBeNull();
  });

  it("无 label 时不渲染标签行", async () => {
    mount(PromptDialog);
    const p = prompt({ title: "t", initial: "x" });
    await nextTick();
    expect(document.querySelector(".prompt-dialog label")).toBeNull();
    closePrompt(null);
    await expect(p).resolves.toBeNull();
  });

  it("确定按钮提交 trim 后的值；空白提交 null", async () => {
    mount(PromptDialog);
    const p1 = prompt({ title: "t", initial: "  abc  " });
    await nextTick();
    buttons()[1]?.click();
    await expect(p1).resolves.toBe("abc");

    const p2 = prompt({ title: "t", initial: "   " });
    await nextTick();
    fill("   ");
    buttons()[1]?.click();
    await expect(p2).resolves.toBeNull();
  });

  it("输入框内按 Enter 提交当前值", async () => {
    mount(PromptDialog);
    const p = prompt({ title: "t", initial: "v1" });
    await nextTick();
    fill("v2");
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", cancelable: true }),
    );
    await expect(p).resolves.toBe("v2");
  });

  it("取消按钮与 Escape 都以 null 兑现", async () => {
    mount(PromptDialog);
    const p1 = prompt({ title: "t" });
    await nextTick();
    buttons()[0]?.click();
    await expect(p1).resolves.toBeNull();

    const p2 = prompt({ title: "t" });
    await nextTick();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(p2).resolves.toBeNull();
    expect(promptState.open).toBe(false);
  });
});
