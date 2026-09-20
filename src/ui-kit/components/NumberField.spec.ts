import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import NumberField from "./NumberField.vue";

const lastCommit = (w: ReturnType<typeof mount>): number | undefined => {
  const ev = w.emitted("commit");
  return (ev?.[ev.length - 1] as number[] | undefined)?.[0];
};

// 拖拽用原生 PointerEvent 派发：jsdom 的构造器完整支持 button/clientX/pointerId，
// 而 VTU trigger 会对构造器未消费的键做属性赋值（button 只有 getter，会抛错）。
function firePointer(
  el: Element,
  type: string,
  init: PointerEventInit,
): void {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init }));
}

describe("ui-kit components/NumberField", () => {
  it("显示按 8 位有效数字格式化的当前值", () => {
    const w = mount(NumberField, { props: { modelValue: 3.141592653 } });
    expect((w.find("input").element as HTMLInputElement).value).toBe(
      "3.1415927",
    );
  });

  it("外部值变化时同步显示（未聚焦状态）", async () => {
    const w = mount(NumberField, { props: { modelValue: 1 } });
    await w.setProps({ modelValue: 2.5 });
    expect((w.find("input").element as HTMLInputElement).value).toBe("2.5");
  });

  it("输入合法值立即 commit 并按 min/max 钳制", async () => {
    const w = mount(NumberField, {
      props: { modelValue: 1, min: 0, max: 3 },
    });
    await w.find("input").setValue("5");
    expect(lastCommit(w)).toBe(3);
  });

  it("输入非法文本不 commit", async () => {
    const w = mount(NumberField, { props: { modelValue: 1 } });
    await w.find("input").setValue("abc");
    expect(w.emitted("commit")).toBeUndefined();
  });

  it("Enter 提交钳制值并回写规范化文本", async () => {
    const w = mount(NumberField, {
      props: { modelValue: 1, min: 0, max: 5 },
    });
    const input = w.find("input");
    await input.trigger("focus");
    await input.setValue("9");
    await input.trigger("keydown", { key: "Enter" });
    expect(lastCommit(w)).toBe(5);
    expect((input.element as HTMLInputElement).value).toBe("5");
  });

  it("Escape 还原为模型值且不 commit", async () => {
    const w = mount(NumberField, {
      props: { modelValue: 1, min: 0, max: 5 },
    });
    const input = w.find("input");
    await input.trigger("focus");
    await input.setValue("9");
    await input.trigger("keydown", { key: "Escape" });
    expect((input.element as HTMLInputElement).value).toBe("1");
    expect(lastCommit(w)).toBe(5); // 只有输入中途那次 commit，Escape 本身不提交
  });

  it("失焦时非法文本回退为模型值", async () => {
    const w = mount(NumberField, { props: { modelValue: 1 } });
    const input = w.find("input");
    await input.trigger("focus");
    await input.setValue("bad");
    await input.trigger("blur");
    expect((input.element as HTMLInputElement).value).toBe("1");
    expect(w.emitted("commit")).toBeUndefined();
  });

  it("拖拽按 dx * step 提交，Shift 精细 10 倍", async () => {
    const w = mount(NumberField, {
      props: { modelValue: 1, min: 0, max: 5 },
    });
    const el = w.find("input").element;
    firePointer(el, "pointerdown", { button: 0, clientX: 100, pointerId: 1 });
    firePointer(el, "pointermove", { clientX: 110, pointerId: 1 });
    expect(lastCommit(w)).toBeCloseTo(1.1, 5);

    firePointer(el, "pointermove", {
      clientX: 130,
      pointerId: 1,
      shiftKey: true,
    });
    // 始终相对按下起点：dx = 130 - 100 = 30，Shift 后 step = 0.001 → 1 + 0.03
    expect(lastCommit(w)).toBeCloseTo(1.03, 5);
  });

  it("disabled 时拖拽与输入不生效", async () => {
    const w = mount(NumberField, {
      props: { modelValue: 1, disabled: true },
    });
    const input = w.find("input");
    expect((input.element as HTMLInputElement).disabled).toBe(true);
    firePointer(input.element, "pointerdown", {
      button: 0,
      clientX: 100,
      pointerId: 1,
    });
    firePointer(input.element, "pointermove", { clientX: 110, pointerId: 1 });
    expect(w.emitted("commit")).toBeUndefined();
  });
});
