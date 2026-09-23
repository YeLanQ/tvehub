// 时间线构建纯函数单测：大脑块生命周期——历史静态块按任务累积保留（与执行
// 过程容器同等），运行中只有当前任务（callId 匹配）的静态对被动态块代展。
import { describe, expect, it } from "vitest";
import { buildTimeline, toNluData } from "./timeline";
import type { ChatMessage } from "./conversations";

function decoPair(
  ids: [string, string],
  callId: string,
  task: string,
): ChatMessage[] {
  return [
    {
      id: ids[0],
      role: "tool",
      content: task,
      toolName: "brain.decompose",
      toolCallId: callId,
      createdAt: 0,
    },
    {
      id: ids[1],
      role: "tool",
      content: JSON.stringify({
        units: [{ index: 1, text: `${task}·单元`, phase: "act" }],
        traces: [{ stage: "语言归一化", detail: task }],
      }),
      toolName: "brain.decompose",
      toolCallId: callId,
      result: true,
      createdAt: 0,
    },
  ];
}

function user(id: string, text: string): ChatMessage {
  return { id, role: "user", content: text, createdAt: 0 };
}

function nluKeys(blocks: ReturnType<typeof buildTimeline>): string[] {
  return blocks.filter((b) => b.kind === "nlu").map((b) => b.key);
}

describe("buildTimeline 大脑块生命周期", () => {
  const msgs = [
    user("u1", "任务一"),
    ...decoPair(["m1", "m2"], "call1", "任务一"),
    ...decoPair(["m3", "m4"], "call2", "任务二"),
    user("u2", "任务二"),
    ...decoPair(["m5", "m6"], "call3", "任务三"),
  ];

  it("正常：多次任务的大脑块按序累积保留（与执行过程容器同等）", () => {
    const blocks = buildTimeline(msgs, null);
    const keys = nluKeys(blocks);
    expect(keys).toHaveLength(3);
    const nluBlocks = blocks.filter((b) => b.kind === "nlu");
    for (const b of nluBlocks) {
      if (b.kind !== "nlu") return;
      expect(b.data.units.length).toBe(1);
    }
    // 各块数据与任务对应（占位块被各自的结果填充，不串任务）
    const texts = nluBlocks.map((b) => (b.kind === "nlu" ? b.data.units[0]?.text : ""));
    expect(texts).toEqual(["任务一·单元", "任务二·单元", "任务三·单元"]);
  });

  it("运行中：只隐藏当前任务（callId 匹配）的静态对，先前任务块保留，动态块在末尾", () => {
    const runNlu = { ...toNluData({
      task: "任务三",
      units: [{ index: 1, text: "任务三·单元", method: null, source: null, zone: null, phase: "act", refs: [], exec: "assist", params: null }],
      traces: [],
      refs: [],
    }), callId: "call3" };
    const blocks = buildTimeline(msgs, runNlu);
    const keys = nluKeys(blocks);
    // 任务一/二的大脑块保留；任务三的静态对被代展；末尾是运行动态块
    expect(keys).toEqual(["nlu_c_call1", "nlu_c_call2", "__nlu_run"]);
    const last = blocks[blocks.length - 1];
    expect(last.kind === "nlu" && last.key).toBe("__nlu_run");
  });

  it("收尾：runNlu 清空后当前任务的静态对恢复为普通大脑块", () => {
    const blocks = buildTimeline(msgs, null);
    expect(nluKeys(blocks)).toHaveLength(3);
  });

  it("边界：解析不了的结果消息不产生块，占位调用消息在无结果时保留为空块", () => {
    const blocks = buildTimeline(
      [
        { id: "x1", role: "tool", content: "不是 JSON", toolName: "brain.decompose", result: true, createdAt: 0 },
        { id: "x2", role: "tool", content: "原文", toolName: "brain.decompose", toolCallId: "c9", createdAt: 0 },
      ],
      null,
    );
    expect(nluKeys(blocks)).toEqual(["nlu_c_c9"]);
  });
});
