import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import MultiSelect from "./MultiSelect.vue";

const OPTIONS = [
  { id: "a", label: "苹果" },
  { id: "b", label: "香蕉", badge: "2D" },
  { id: "c", label: "樱桃", badge: "已删除", badgeDeleted: true },
];

function mountBox(selectedIds: string[]) {
  return mount(MultiSelect, {
    props: { selectedIds, options: OPTIONS, placeholder: "选择水果" },
  });
}

async function openMenu(w: ReturnType<typeof mountBox>) {
  await w.find("button").trigger("click");
  await flushPromises();
}

const checkboxes = (): NodeListOf<HTMLInputElement> =>
  document.querySelectorAll(".multi-select-menu input[type=checkbox]");

describe("ui-kit components/MultiSelect", () => {
  it("摘要：未选 = 占位文案，单选 = 名称，多选 = 首名 + 等N项", async () => {
    const w = mountBox([]);
    const text = () => w.find(".multi-select-summary").text();
    expect(text()).toBe("选择水果");

    await w.setProps({ selectedIds: ["a"] });
    expect(text()).toBe("苹果");

    await w.setProps({ selectedIds: ["a", "b"] });
    expect(text()).toBe("苹果 等 2 项");
  });

  it("已选 id 不在候选里时显示「（已删除）」占位", () => {
    const w = mountBox(["gone"]);
    expect(w.find(".multi-select-summary").text()).toBe("gone（已删除）");
  });

  it("悬停提示列出全部已选", async () => {
    const w = mountBox(["a", "c"]);
    expect(w.find("button").attributes("title")).toBe("已选：苹果、樱桃");
  });

  it("打开浮层：勾选状态与 selectedIds 一致，徽标行带警示", async () => {
    const w = mountBox(["a"]);
    await openMenu(w);
    const boxes = checkboxes();
    expect(boxes).toHaveLength(3);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
    const badgeRow = document.querySelectorAll(".multi-select-row")[2];
    expect(
      badgeRow.querySelector(".multi-select-kind")?.hasAttribute("data-deleted"),
    ).toBe(true);
  });

  it("勾选/取消即时上报且保持勾选顺序", async () => {
    const w = mountBox(["a"]);
    await openMenu(w);
    checkboxes()[1].dispatchEvent(new Event("change"));
    await flushPromises();
    expect(w.emitted("update:selectedIds")?.[0]).toEqual([["a", "b"]]);

    // 宿主回灌新选中值后再取消勾选第一项
    await w.setProps({ selectedIds: ["a", "b"] });
    checkboxes()[0].dispatchEvent(new Event("change"));
    await flushPromises();
    expect(w.emitted("update:selectedIds")?.[1]).toEqual([["b"]]);
  });

  it("候选为空显示空态文案", async () => {
    const w = mount(MultiSelect, {
      props: { selectedIds: [], options: [] },
    });
    await openMenu(w);
    expect(
      document.querySelector(".multi-select-empty")?.textContent,
    ).toContain("无可选项");
  });
});
