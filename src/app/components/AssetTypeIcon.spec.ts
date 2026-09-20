import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import AssetTypeIcon from "./AssetTypeIcon.vue";

describe("app components/AssetTypeIcon", () => {
  it.each([
    "dir",
    "scene",
    "ts",
    "mat",
    "png",
    "glb",
    "terrain",
    "light:point",
    "camera",
    "unknownext", // 兜底分支：带折角文档
  ])("渲染 %s 图标（SVG 线稿）", (kind) => {
    const w = mount(AssetTypeIcon, { props: { kind } });
    expect(w.find("svg.asset-type-icon").exists()).toBe(true);
    expect(w.findAll("path").length).toBeGreaterThan(0);
  });

  it("未知类型回退到文档图标且不抛错", () => {
    const w = mount(AssetTypeIcon, { props: { kind: "" } });
    expect(w.find("svg").exists()).toBe(true);
  });
});
