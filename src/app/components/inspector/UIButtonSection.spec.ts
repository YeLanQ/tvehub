// UIButtonSection 取色输入回归：@input/@change 必须把事件对象传给处理器并 emit
// update。历史缺陷：模板写成 onColorInput('color')（柯里化工厂被当处理器调用），
// 每次事件只"创建"了返回的闭包就丢弃——发射永不发生，取色在真实应用中无效。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import UIButtonSection from "./UIButtonSection.vue";
import { UIButtonNode } from "../../../framework/prototype/derived/Primitives";

function mountSection() {
  const node = new UIButtonNode({ label: "Btn" });
  const wrapper = mount(UIButtonSection, {
    props: { node, rev: 0 },
  });
  return { wrapper, node };
}

/** 第 index 个取色输入（模板顺序：背景色 0、标签色 1） */
function colorInput(wrapper: ReturnType<typeof mountSection>["wrapper"], index: number): HTMLInputElement {
  return wrapper.findAll('input[type="color"]')[index].element as HTMLInputElement;
}

describe("UIButtonSection 颜色输入", () => {
  it("背景色 input 事件按 label=color 发射数值", async () => {
    const { wrapper } = mountSection();
    const input = colorInput(wrapper, 0);
    input.value = "#00aa00";
    await wrapper.find('input[type="color"]').trigger("input");
    const emitted = wrapper.emitted("update");
    expect(emitted).toBeTruthy();
    expect(emitted![0][0]).toBe("color");
    expect(emitted![0][1]).toBe(0x00aa00);
  });

  it("标签色 change 事件按 label=labelColor 发射数值", async () => {
    const { wrapper } = mountSection();
    const input = colorInput(wrapper, 1);
    input.value = "#ffcc00";
    await wrapper.findAll('input[type="color"]')[1].trigger("change");
    const emitted = wrapper.emitted("update");
    expect(emitted).toBeTruthy();
    expect(emitted![0][0]).toBe("labelColor");
    expect(emitted![0][1]).toBe(0xffcc00);
  });
});
