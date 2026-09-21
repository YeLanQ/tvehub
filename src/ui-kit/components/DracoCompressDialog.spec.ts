import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import DracoCompressDialog from "./DracoCompressDialog.vue";
import { openDracoCompressDialog } from "../composables/draco-compress";

// Draco 压缩参数弹窗：composable 驱动开合、参数交互与 Promise 兑现。
// 浮层 Teleport 到 body，直接查 document。

const dialog = () => document.querySelector(".prompt-dialog");
const primary = () => dialog()?.querySelector<HTMLButtonElement>(".actions .primary");

describe("DracoCompressDialog", () => {
  it("关闭态不渲染任何浮层", () => {
    mount(DracoCompressDialog, { attachTo: document.body });
    expect(dialog()).toBeNull();
  });

  it("open 后渲染标题与源文件大小；确认兑现当前 speed/quality", async () => {
    mount(DracoCompressDialog, { attachTo: document.body });
    const p = openDracoCompressDialog({ sourceSize: 2048, title: "压缩 Robot.glb" });
    await flushPromises();
    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelector("h3")?.textContent).toBe("压缩 Robot.glb");
    expect(dialog()?.textContent).toContain("2.0 KB");

    // 调整速度与精度（range 的 v-model 监听 input 事件）
    const range = dialog()?.querySelector<HTMLInputElement>("input[type=range]");
    range!.value = "8";
    range!.dispatchEvent(new Event("input"));
    const select = dialog()?.querySelector<HTMLSelectElement>("select");
    select!.value = "high";
    select!.dispatchEvent(new Event("change"));
    await flushPromises();

    primary()!.click();
    await expect(p).resolves.toEqual({ speed: 8, quality: "high" });
    expect(dialog()).toBeNull(); // 确认后浮层关闭
  });

  it("取消按钮兑现 null；Escape 同义", async () => {
    mount(DracoCompressDialog, { attachTo: document.body });
    const p = openDracoCompressDialog({ sourceSize: 1 });
    await flushPromises();
    const cancel = dialog()?.querySelector<HTMLButtonElement>(".actions button:not(.primary)");
    cancel!.click();
    await expect(p).resolves.toBeNull();

    const p2 = openDracoCompressDialog({ sourceSize: 1 });
    await flushPromises();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(p2).resolves.toBeNull();
    expect(dialog()).toBeNull();
  });
});
