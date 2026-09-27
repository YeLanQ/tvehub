// MeshSection 基元尺寸（size）编辑回归：逐轴 NumberField commit 必须以
// "Set Mesh Size" + {axis, value} 载荷 emit update；非基元来源不渲染尺寸字段。
// 历史背景：size 之前无 UI 入口，节点 scale=1 而外观是长方体时无从排查。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import MeshSection from "./MeshSection.vue";
import NumberField from "../NumberField.vue";
import { MeshNode } from "../../../framework/prototype/derived/Primitives";

function mountWith(node: MeshNode) {
  return mount(MeshSection, { props: { node, rev: 0 } });
}

describe("MeshSection 基元尺寸编辑", () => {
  it("基元渲染 xyz 三个尺寸 NumberField，初值绑定 node.size", () => {
    const node = new MeshNode({ geometry: "box" });
    node.size = { x: 2, y: 0.5, z: 3 };
    const wrapper = mountWith(node);
    const fields = wrapper.findAllComponents(NumberField);
    expect(fields.length).toBe(3);
    expect(fields[0].props("modelValue")).toBe(2);
    expect(fields[1].props("modelValue")).toBe(0.5);
    expect(fields[2].props("modelValue")).toBe(3);
  });

  it("尺寸 NumberField commit 以 Set Mesh Size + 逐轴载荷 emit update", async () => {
    const node = new MeshNode({ geometry: "box" });
    const wrapper = mountWith(node);
    const fields = wrapper.findAllComponents(NumberField);
    fields[0].vm.$emit("commit", 2);
    fields[1].vm.$emit("commit", 0.4);
    await wrapper.vm.$nextTick();
    const emitted = wrapper.emitted("update");
    expect(emitted).toBeTruthy();
    expect(emitted!.length).toBe(2);
    expect(emitted![0][0]).toBe("Set Mesh Size");
    expect(emitted![0][1]).toEqual({ axis: "x", value: 2 });
    expect(emitted![1][0]).toBe("Set Mesh Size");
    expect(emitted![1][1]).toEqual({ axis: "y", value: 0.4 });
  });

  it("非基元来源（data）不渲染尺寸字段", () => {
    const node = new MeshNode({ source: "data" });
    const wrapper = mountWith(node);
    expect(wrapper.findAllComponents(NumberField).length).toBe(0);
  });
});
