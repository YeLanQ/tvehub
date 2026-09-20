import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { h } from "vue";
import ComponentCard from "./ComponentCard.vue";

describe("ui-kit components/ComponentCard", () => {
  it("默认折叠：不渲染内容区，箭头朝右", () => {
    const w = mount(ComponentCard, { props: { title: "变换" } });
    expect(w.find(".section-body").exists()).toBe(false);
    expect(w.find(".caret").text()).toBe("▸");
  });

  it("open 时渲染默认插槽，箭头朝下", () => {
    const w = mount(ComponentCard, {
      props: { title: "变换", open: true },
      slots: { default: () => h("div", { class: "body-content" }, "内容") },
    });
    expect(w.find(".section-body").exists()).toBe(true);
    expect(w.find(".body-content").text()).toBe("内容");
    expect(w.find(".caret").text()).toBe("▾");
  });

  it("点击头部发出 toggle", async () => {
    const w = mount(ComponentCard, { props: { title: "变换" } });
    await w.find(".section-head").trigger("click");
    expect(w.emitted("toggle")).toHaveLength(1);
  });

  it("渲染类型徽标与头部具名插槽", () => {
    const w = mount(ComponentCard, {
      props: { title: "变换", type: "Transform", open: true },
      slots: { head: () => h("span", { class: "head-extra" }, "+") },
    });
    expect(w.find(".comp-type").text()).toBe("Transform");
    expect(w.find(".head-extra").text()).toBe("+");
  });

  it("dim 时根节点带置灰类", () => {
    const w = mount(ComponentCard, {
      props: { title: "变换", dim: true },
    });
    expect(w.find(".section").classes()).toContain("dim");
  });
});
