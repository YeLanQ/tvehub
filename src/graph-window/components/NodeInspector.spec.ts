import { beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import NodeInspector from "./NodeInspector.vue";
import ComboBox from "../../ui-kit/components/ComboBox.vue";
import { getGraphWindowStore } from "../graphStore";
import type { GraphCanvasBridge } from "../graphStore";
import type { GNode, ScriptGraphDoc } from "../../framework/graph";

/** FSM 容器 + 一张比较卡（容器内子节点）的最小画布桩 */
function makeNode(): GNode {
  return {
    id: "n13",
    type: "flow.compare",
    containerId: "n7",
    params: { operator: ">", b: 0, event: "" },
  } as unknown as GNode;
}

function makeCanvasBridge(node: GNode, fsmParams?: Record<string, unknown>): GraphCanvasBridge {
  const doc: ScriptGraphDoc = {
    nodes: [
      node,
      {
        id: "n7",
        type: "fsm.container",
        params: fsmParams ?? { states: "Idle,Chase,Die", initial: "Idle", transitions: "start_chase>Chase,back_idle>Idle" },
      } as unknown as GNode,
    ],
    edges: [],
    comments: [],
  };
  return {
    loadDoc: () => {},
    serializeDoc: () => doc,
    getSelectedNode: () => node,
    getSelectedComment: () => null,
    fitView: () => {},
    undo: () => {},
    redo: () => {},
    requestSnapshot: () => {},
    addProto: () => {},
    addMatch: () => {},
  } as unknown as GraphCanvasBridge;
}

async function mountInspector(node: GNode, fsmParams?: Record<string, unknown>): Promise<VueWrapper> {
  const store = getGraphWindowStore();
  store.canvas = makeCanvasBridge(node, fsmParams);
  store.setSelection(null, false);
  const w = mount(NodeInspector);
  store.setSelection("n13", false);
  await nextTick();
  await nextTick();
  return w;
}

describe("graph-window components/NodeInspector（比较卡字段）", () => {
  beforeEach(() => {
    const store = getGraphWindowStore();
    store.setSelection(null, false);
  });

  it("比较卡渲染「B 值（未连线时）」数字输入并写回 params.b", async () => {
    const node = makeNode();
    const w = await mountInspector(node);
    const label = w.findAll("label").find((l) => l.text().includes("B 值"));
    expect(label, "检查器应渲染 B 值输入").toBeDefined();
    const input = label!.find("input[type=number]");
    expect(input.exists()).toBe(true);
    await input.setValue("2.5");
    await input.trigger("change");
    expect(node.params?.b).toBe(2.5);
  });

  it("比较卡渲染「触发事件名」输入（候选 = 容器切换事件，不含状态名）并写回 params.event", async () => {
    const node = makeNode();
    const w = await mountInspector(node);
    const label = w.findAll("label").find((l) => l.text().includes("触发事件名"));
    expect(label, "检查器应渲染触发事件名输入").toBeDefined();
    const combo = label!.findComponent(ComboBox);
    expect(combo.exists()).toBe(true);
    // 候选只含事件（容器「切换事件」映射目标有效者）；Idle/Chase/Die 等状态名不进候选
    expect(combo.props("options")).toEqual(["start_chase", "back_idle"]);
    expect(String(combo.props("modelValue"))).toBe("");
    combo.vm.$emit("update:model-value", "start_chase");
    await nextTick();
    expect(node.params?.event).toBe("start_chase");
  });

  it("候选过滤：映射目标已失效的切换事件不进候选", async () => {
    const node = makeNode();
    // states 无 Die：stale>Die 映射失效；start_chase/back_idle 目标仍在
    const w = await mountInspector(node, { states: "Idle,Chase", transitions: "start_chase>Chase,stale>Die,back_idle>Idle" });
    const label = w.findAll("label").find((l) => l.text().includes("触发事件名"))!;
    const combo = label.findComponent(ComboBox);
    expect(combo.props("options")).toEqual(["start_chase", "back_idle"]);
  });

  it("触发事件名写为字符串（非数字收敛），空值原样保留", async () => {
    const node = makeNode();
    node.params = { operator: ">", b: 0, event: "" };
    const w = await mountInspector(node);
    const label = w.findAll("label").find((l) => l.text().includes("触发事件名"))!;
    const combo = label.findComponent(ComboBox);
    combo.vm.$emit("update:model-value", "8");
    await nextTick();
    expect(node.params?.event).toBe("8");
    expect(typeof node.params?.event).toBe("string");
  });

  it("回归：运算下拉仍渲染且可选", async () => {
    const node = makeNode();
    const w = await mountInspector(node);
    const label = w.findAll("label").find((l) => l.text().includes("运算"));
    expect(label).toBeDefined();
    const select = label!.find("select");
    expect(select.exists()).toBe(true);
    await select.setValue("<");
    await select.trigger("change");
    expect(node.params?.operator).toBe("<");
  });
});
