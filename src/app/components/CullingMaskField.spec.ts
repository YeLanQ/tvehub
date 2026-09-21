import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import CullingMaskField from "./CullingMaskField.vue";
import { getProjectStore } from "../stores/project";
import { ALL_LAYERS_MASK } from "../../framework/layers";

// Culling Mask 控件：摘要回显、下拉开合、快捷档与逐层勾选的归一化 emit。
// 浮层 Teleport 到 body；项目层表用真实单例 store（默认仅 Default 层）。

const store = getProjectStore();

function mountField(mask = 1) {
  return mount(CullingMaskField, { props: { mask } });
}

const summaryOf = (w: ReturnType<typeof mountField>): string =>
  w.get(".culling-mask-summary").text();

const openMenu = async (w: ReturnType<typeof mountField>): Promise<void> => {
  w.get(".culling-mask-btn").trigger("click");
  await flushPromises();
};

describe("CullingMaskField 折叠态", () => {
  it("掩码摘要回显（Everything / Nothing / 层名）", async () => {
    store.setLayers(["Default"]);
    expect(summaryOf(mountField(-1))).toBe("Everything");
    expect(summaryOf(mountField(0))).toBe("Nothing");
    // 单层表里勾满唯一层 = Everything（cullingMaskLabel 语义）
    expect(summaryOf(mountField(1))).toBe("Everything");
    store.setLayers(["Default", "", "Water"]);
    expect(summaryOf(mountField(0b100))).toBe("Water"); // 部分勾选 = 层名列表
    expect(summaryOf(mountField(0b101))).toBe("Everything"); // 已定义层全勾
  });

  it("title 属性携带完整摘要（悬停提示）", () => {
    store.setLayers(["Default"]);
    const w = mountField(-1);
    expect(w.get(".culling-mask-btn").attributes("title")).toContain("Everything");
  });
});

describe("下拉菜单", () => {
  it("点击开合；菜单只列已定义层；Everything/Nothing 快捷档直发", async () => {
    store.setLayers(["Default", "", "Water"]);
    const w = mountField(0b101);
    await openMenu(w);
    const pop = document.querySelector(".culling-mask-pop");
    expect(pop).not.toBeNull();
    const names = [...pop!.querySelectorAll(".culling-mask-name")].map((n) => n.textContent);
    expect(names).toEqual(["Default", "Water"]);

    const quick = [...pop!.querySelectorAll(".culling-mask-quick button")];
    quick[0]!.dispatchEvent(new Event("click")); // Everything
    await flushPromises();
    expect(w.emitted("change")![0]).toEqual([ALL_LAYERS_MASK]);
    quick[1]!.dispatchEvent(new Event("click")); // Nothing
    await flushPromises();
    expect(w.emitted("change")![1]).toEqual([0]);
  });

  it("勾掉最后一个已勾层 → emit 归一化为 0（Nothing）", async () => {
    store.setLayers(["Default"]);
    const w = mountField(1);
    await openMenu(w);
    const box = document.querySelector<HTMLInputElement>(".culling-mask-row input");
    box!.checked = false;
    box!.dispatchEvent(new Event("change"));
    await flushPromises();
    expect(w.emitted("change")![0]).toEqual([0]);
  });

  it("勾满全部已定义层 → emit 归一化为 -1（Everything）", async () => {
    store.setLayers(["Default", "", "Water"]);
    const w = mountField(0b101);
    await openMenu(w);
    const boxes = [...document.querySelectorAll<HTMLInputElement>(".culling-mask-row input")];
    expect(boxes.map((b) => b.checked)).toEqual([true, true]); // 层 0 与层 2 都在掩码里
    // 取消一个再勾回：先发部分掩码，再勾满发 -1
    boxes[1]!.checked = false;
    boxes[1]!.dispatchEvent(new Event("change"));
    await flushPromises();
    expect(w.emitted("change")![0]).toEqual([1]); // 只剩层 0 → 保持原值
    const recheck = document.querySelectorAll<HTMLInputElement>(".culling-mask-row input")[1];
    recheck.checked = true;
    recheck.dispatchEvent(new Event("change"));
    await flushPromises();
    expect(w.emitted("change")![1]).toEqual([ALL_LAYERS_MASK]);
  });

  it("点击菜单外部关闭浮层；按钮自身点击不误关", async () => {
    store.setLayers(["Default"]);
    const w = mountField(1);
    await openMenu(w);
    expect(document.querySelector(".culling-mask-pop")).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flushPromises();
    expect(document.querySelector(".culling-mask-pop")).toBeNull();
  });
});
