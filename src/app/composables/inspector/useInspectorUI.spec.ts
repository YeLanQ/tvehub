// useInspectorUI Widget 共有字段写路径（editWidgetField）——opacity 收敛用例。
// 域处理器经 ctx.node + ctx.commit 与真实节点解耦：commit 直接对同一实例 mutate。
import { describe, expect, it } from "vitest";
import { computed, ref } from "vue";
import { useInspectorUI } from "./useInspectorUI";
import { UIButtonNode, UITextNode } from "../../../framework/prototype/derived/Primitives";
import type { Node } from "../../../framework/prototype/Node";
import type { InspectorNodeApi } from "./useInspectorNode";

function ctxOf(node: UIButtonNode): InspectorNodeApi {
  return {
    node: computed(() => node),
    revision: ref(0),
    commit: (mutate: (n: Node) => void) => mutate(node as unknown as Node),
    mutateNode: (_n: Node, mutate: (nn: Node) => void) => mutate(node as unknown as Node),
  } as unknown as InspectorNodeApi;
}

describe("useInspectorUI opacity 写路径", () => {
  it("onUIButtonUpdate('opacity') 收敛 0..1 并写入节点", () => {
    const btn = new UIButtonNode({});
    const api = useInspectorUI(ctxOf(btn));
    api.onUIButtonUpdate("opacity", 0.3);
    expect(btn.opacity).toBe(0.3);
    api.onUIButtonUpdate("opacity", 7);
    expect(btn.opacity).toBe(1);
    api.onUIButtonUpdate("opacity", -1);
    expect(btn.opacity).toBe(0);
  });

  it("onUITextUpdate 同一写路径生效", () => {
    const node = new UITextNode({});
    const api = useInspectorUI(ctxOf(node as unknown as UIButtonNode));
    api.onUITextUpdate("opacity", 0.6);
    expect(node.opacity).toBe(0.6);
  });
});
