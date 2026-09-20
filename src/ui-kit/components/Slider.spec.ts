import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import Slider from "./Slider.vue";

describe("ui-kit components/Slider", () => {
  it("渲染 range 属性与默认步长", () => {
    const w = mount(Slider, { props: { modelValue: 0.25 } });
    const el = w.find("input").element as HTMLInputElement;
    expect(el.type).toBe("range");
    expect(el.min).toBe("0");
    expect(el.max).toBe("1");
    expect(el.step).toBe("0.01");
  });

  it("填充比例按当前值计算", () => {
    const w = mount(Slider, { props: { modelValue: 0.25, min: 0, max: 1 } });
    expect(
      (w.find("input").element as HTMLInputElement).style.getPropertyValue(
        "--fill",
      ),
    ).toBe("25.00%");
  });

  it("值越界时填充比例钳制在 0~100%", () => {
    const w = mount(Slider, { props: { modelValue: 2, min: 0, max: 1 } });
    expect(
      (w.find("input").element as HTMLInputElement).style.getPropertyValue(
        "--fill",
      ),
    ).toBe("100.00%");
  });

  it("非区间（max <= min）填充为 0%", () => {
    const w = mount(Slider, { props: { modelValue: 0.5, min: 1, max: 0 } });
    expect(
      (w.find("input").element as HTMLInputElement).style.getPropertyValue(
        "--fill",
      ),
    ).toBe("0%");
  });

  it("input 事件以数值提交 update:modelValue", async () => {
    const w = mount(Slider, { props: { modelValue: 0.25 } });
    await w.find("input").setValue("0.5");
    const ev = w.emitted("update:modelValue");
    expect(ev).toHaveLength(1);
    expect(ev?.[0] as number[]).toEqual([0.5]);
  });

  it("disabled 透传到原生控件", () => {
    const w = mount(Slider, { props: { modelValue: 0, disabled: true } });
    expect(
      (w.find("input").element as HTMLInputElement).disabled,
    ).toBe(true);
  });
});
