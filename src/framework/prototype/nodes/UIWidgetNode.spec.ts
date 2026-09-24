// UI Widget 不透明度（opacity）数据层回归：构造收敛、JSON 往返、clone 保留。
// opacity 在 UIWidgetNode 基类统一序列化（writeWidget/readWidget），四类 Widget 共有。
import { describe, expect, it } from "vitest";
import { UIButtonNode } from "./UIButtonNode";
import { UIImageNode } from "./UIImageNode";
import { UILayoutNode } from "./UILayoutNode";
import { UITextNode } from "./UITextNode";

describe("UIWidgetNode opacity", () => {
  it("构造收敛到 0..1；缺省 1", () => {
    expect(new UIButtonNode({}).opacity).toBe(1);
    expect(new UIButtonNode({ opacity: 0.4 }).opacity).toBe(0.4);
    expect(new UIButtonNode({ opacity: 5 }).opacity).toBe(1);
    expect(new UIButtonNode({ opacity: -2 }).opacity).toBe(0);
    expect(new UIButtonNode({ opacity: Number.NaN }).opacity).toBe(1);
  });

  it("JSON 往返保留 opacity；applyJSON 非法值回退当前值", () => {
    const btn = new UIButtonNode({ opacity: 0.25 });
    const json = btn.toJSON() as Record<string, unknown>;
    expect(json.opacity).toBe(0.25);
    btn.applyJSON({ ...json, opacity: 0.75 } as Record<string, unknown>);
    expect(btn.opacity).toBe(0.75);
    btn.applyJSON({ ...json, opacity: "x" } as unknown as Record<string, unknown>);
    expect(btn.opacity).toBe(0.75);
  });

  it("旧数据无 opacity 字段 → 回退 1（applyJSON 走 readWidget）", () => {
    const legacy = { type: "uiImageNode", id: "img1", name: "Img" };
    const img = new UIImageNode();
    img.applyJSON(legacy as unknown as Record<string, unknown>);
    expect(img.opacity).toBe(1);
  });

  it("clone 保留 opacity（四类 Widget）", () => {
    const cases = [
      new UIButtonNode({ opacity: 0.5 }),
      new UIImageNode({ opacity: 0.3 }),
      new UITextNode({ opacity: 0.2 }),
      new UILayoutNode({ opacity: 0.9 }),
    ];
    for (const node of cases) {
      expect(node.clone().opacity).toBe(node.opacity);
    }
  });
});
