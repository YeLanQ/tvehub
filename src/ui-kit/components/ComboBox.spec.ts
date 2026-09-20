import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import ComboBox from "./ComboBox.vue";

const OPTIONS = ["foo", "bar", "baz"];

async function openBox(value = "foo") {
  const w = mount(ComboBox, {
    props: { modelValue: value, options: OPTIONS },
  });
  await w.find("input").trigger("focus");
  await flushPromises();
  return w;
}

const menu = (): Element | null =>
  document.querySelector(".combo-box-menu");
const rows = (): NodeListOf<Element> =>
  document.querySelectorAll(".combo-box-row");

describe("ui-kit components/ComboBox", () => {
  it("聚焦打开浮层，展示全量候选并勾选当前值", async () => {
    await openBox("bar");
    expect(rows()).toHaveLength(3);
    const current = Array.from(rows()).find(
      (r) => r.textContent?.includes("bar"),
    );
    expect(current?.querySelector(".combo-box-check")).toBeTruthy();
  });

  it("输入按包含匹配过滤，无命中显示空态", async () => {
    const w = await openBox();
    await w.find("input").setValue("ba");
    expect(Array.from(rows()).map((r) => r.textContent)).toEqual([
      "bar",
      "baz",
    ]);

    await w.find("input").setValue("zz");
    expect(rows()).toHaveLength(0);
    expect(menu()?.querySelector(".combo-box-empty")?.textContent).toContain(
      "无匹配候选",
    );
  });

  it("点候选提交并关闭", async () => {
    const w = await openBox();
    rows()[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(w.emitted("update:modelValue")).toEqual([["bar"]]);
    expect(menu()).toBeNull();
  });

  it("Enter 提交当前草稿（候选之外可手填）", async () => {
    const w = await openBox();
    await w.find("input").setValue("custom");
    await w.find("input").trigger("keydown", { key: "Enter" });
    expect(w.emitted("update:modelValue")).toEqual([["custom"]]);
    expect(menu()).toBeNull();
  });

  it("Escape 还原为当前值并关闭，不提交", async () => {
    const w = await openBox();
    await w.find("input").setValue("zzz");
    await w.find("input").trigger("keydown", { key: "Escape" });
    expect((w.find("input").element as HTMLInputElement).value).toBe("foo");
    expect(w.emitted("update:modelValue")).toBeUndefined();
    expect(menu()).toBeNull();
  });

  it("失焦时提交有变化的草稿（浮层保留，靠外点/Escape 关闭）", async () => {
    const w = await openBox();
    await w.find("input").setValue("draft");
    await w.find("input").trigger("blur");
    expect(w.emitted("update:modelValue")).toEqual([["draft"]]);
  });

  it("外部值变化同步到输入框（未聚焦时）", async () => {
    const w = mount(ComboBox, {
      props: { modelValue: "foo", options: OPTIONS },
    });
    await w.setProps({ modelValue: "bar" });
    expect((w.find("input").element as HTMLInputElement).value).toBe("bar");
  });
});
