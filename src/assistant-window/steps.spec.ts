// steps 纯逻辑单测：工具消息 →「一次调用一行」的合并规则。
// 重点回归：并行调用完成序≠调用序时，结果必须按 toolCallId 精确回位。
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./conversations";
import { mergeStepRow } from "./steps";
import type { ToolStepItem } from "./ToolSteps.vue";

let seq = 0;
function call(toolName: string, toolCallId: string, args: string): ChatMessage {
  return {
    id: `c${++seq}`,
    role: "tool",
    content: args,
    toolName,
    toolCallId,
    createdAt: seq,
  };
}

function result(toolName: string, toolCallId: string, content: string): ChatMessage {
  return {
    id: `r${++seq}`,
    role: "tool",
    content,
    toolName,
    toolCallId,
    result: true,
    createdAt: seq,
  };
}

function rowOf(m: ChatMessage, rows: ToolStepItem[] = []): ToolStepItem[] {
  mergeStepRow(rows, m);
  return rows;
}

describe("mergeStepRow 调用/结果配对", () => {
  it("并行乱序完成：结果按 toolCallId 回位，不错挂到别的调用", () => {
    const rows: ToolStepItem[] = [];
    mergeStepRow(rows, call("load_doc", "a1", '{"id":"sdk/math.md"}'));
    mergeStepRow(rows, call("load_doc", "a2", '{"id":"sdk/engine.md"}'));
    // 完成序与调用序相反（a2 先回）
    mergeStepRow(rows, result("load_doc", "a2", '{"id":"sdk/engine.md","title":"引擎入口"}'));
    mergeStepRow(rows, result("load_doc", "a1", '{"id":"sdk/math.md","title":"数学库"}'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.args).toBe('{"id":"sdk/math.md"}');
    expect(rows[0]?.result).toBe('{"id":"sdk/math.md","title":"数学库"}');
    expect(rows[1]?.args).toBe('{"id":"sdk/engine.md"}');
    expect(rows[1]?.result).toBe('{"id":"sdk/engine.md","title":"引擎入口"}');
    expect(rows.every((r) => r.ok)).toBe(true);
  });

  it("错误结果标记 ok=false", () => {
    const rows = rowOf(call("asset.read", "b1", "{}"));
    mergeStepRow(rows, result("asset.read", "b1", '{"error":"缺少 path 参数"}'));
    expect(rows[0]?.ok).toBe(false);
  });

  it("无 id 的历史孤儿：结果按同名 FIFO 兜底，无配对则单独成行", () => {
    const rows: ToolStepItem[] = [];
    mergeStepRow(rows, call("asset.read", undefined as unknown as string, "src/A.ts"));
    mergeStepRow(rows, { ...result("asset.read", "", '{"ok":true}'), toolCallId: undefined });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('{"ok":true}');
    // 完全无调用行可挂 → 结果自建一行
    mergeStepRow(rows, { ...result("asset.list", "", "[]"), toolCallId: undefined });
    expect(rows).toHaveLength(2);
    expect(rows[1]?.toolName).toBe("asset.list");
  });

  it("不同名结果不吃掉未决行（同名优先，再退任意）", () => {
    const rows: ToolStepItem[] = [];
    mergeStepRow(rows, call("load_doc", "c1", "{}"));
    mergeStepRow(rows, call("asset.read", "c2", "{}"));
    mergeStepRow(rows, result("load_doc", "c1", '{"ok":1}'));
    // c2 的结果最后回：同名未决行不存在时退任意未决行
    mergeStepRow(rows, result("asset.read", "c2", '{"ok":2}'));
    expect(rows).toHaveLength(2);
    expect(rows[1]?.result).toBe('{"ok":2}');
  });
});
