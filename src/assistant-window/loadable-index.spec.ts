// loadable-index 纯逻辑单测：可加载资料索引段的渲染规则。
import { describe, expect, it } from "vitest";
import { EMPTY_CATALOGS, loadableIndexPrompt } from "./loadable-index";

describe("loadableIndexPrompt", () => {
  it("渲染 docs 与工坊两小节，行含 id 与摘要", () => {
    const text = loadableIndexPrompt({
      docs: [{ id: "sdk/tween.md", title: "tween 补间动画", summary: "缓动 API 手册" }],
      repos: [{ id: "code/Rotator.ts", title: "Rotator", summary: "绕 Y 轴匀速自转" }],
    });
    expect(text).toContain("## 可加载资料索引");
    expect(text).toContain("load_doc");
    expect(text).toContain("load_repo");
    expect(text).toContain("- sdk/tween.md：tween 补间动画 — 缓动 API 手册");
    expect(text).toContain("- code/Rotator.ts：Rotator — 绕 Y 轴匀速自转");
    expect(text).toContain("空参调用会被拒绝");
  });

  it("空目录省略对应小节；全空只留头部指引", () => {
    const half = loadableIndexPrompt({
      docs: [{ id: "README.md", title: "README", summary: "" }],
      repos: [],
    });
    expect(half).toContain("### 官方文档");
    expect(half).not.toContain("工坊原型");
    expect(loadableIndexPrompt(EMPTY_CATALOGS).split("\n")).toHaveLength(2);
  });

  it("摘要超长截断；摘要与标题相同时不重复", () => {
    const text = loadableIndexPrompt({
      docs: [],
      repos: [
        { id: "effect/X.shader", title: "X", summary: "很长的描述".repeat(20) },
        { id: "effect/Y.shader", title: "Y", summary: "Y" },
      ],
    });
    expect(text).toContain("很长的描述很长的描述很长的描述");
    expect(text).not.toContain("Y — Y");
  });
});
