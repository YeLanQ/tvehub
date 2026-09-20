import { describe, expect, it } from "vitest";
import { closePrompt, prompt, promptState } from "./prompt";

describe("ui-kit composables/prompt", () => {
  it("打开时补默认按钮文案并把 initial 写入输入值", () => {
    prompt({ title: "重命名", initial: "abc", placeholder: "输入名称" });
    expect(promptState.open).toBe(true);
    expect(promptState.options).toMatchObject({
      confirmText: "确定",
      cancelText: "取消",
      title: "重命名",
      placeholder: "输入名称",
    });
    expect(promptState.value).toBe("abc");
  });

  it("无 initial 时输入值为空串", () => {
    prompt({ title: "新建" });
    expect(promptState.value).toBe("");
    closePrompt(null);
  });

  it("closePrompt 以给定值兑现 Promise 并复位状态", async () => {
    const p1 = prompt({ title: "a" });
    closePrompt("结果");
    await expect(p1).resolves.toBe("结果");
    expect(promptState.open).toBe(false);
    expect(promptState.resolve).toBeNull();

    const p2 = prompt({ title: "a" });
    closePrompt(null);
    await expect(p2).resolves.toBeNull();
    expect(promptState.open).toBe(false);
  });
});
