import { describe, expect, it } from "vitest";
import { buildSystemPrompt, runAgent, toWire } from "./agent";
import { assistantTools } from "./tools";
import type { AgentCard } from "./store";
import type { AssistantReply } from "./agent";

function cardFixture(over: Partial<AgentCard>): AgentCard {
  return {
    id: "card_x",
    name: "测试卡",
    persona: "",
    systemPrompt: "",
    firstMessage: "",
    tags: [],
    model: "",
    temperature: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** 纯内存传输桩：按脚本逐轮返回回复（无事件流） */
function stubChat(script: AssistantReply[]): {
  chat: Parameters<typeof runAgent>[0]["chat"];
  calls: () => number;
} {
  let n = 0;
  return {
    chat: async () => {
      const reply = script[Math.min(n, script.length - 1)];
      n += 1;
      return reply;
    },
    calls: () => n,
  };
}

describe("toWire", () => {
  it("正常：user/assistant 保留，tool/error 轮不回放", () => {
    const wire = toWire([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "tool", content: "结果" },
      { role: "error", content: "失败" },
      { role: "user", content: "c" },
    ]);
    expect(wire).toHaveLength(3);
    expect(wire.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
  it("空值：空历史返回空数组", () => {
    expect(toWire([])).toEqual([]);
  });
});

describe("runAgent 工具循环", () => {
  it("正常：无工具调用直接返回", async () => {
    const { chat, calls } = stubChat([{ content: "答案", toolCalls: [] }]);
    const events: string[] = [];
    const reply = await runAgent({
      messages: [{ role: "user", content: "hi" }],
      tools: assistantTools(),
      chat,
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async () => ({}),
      onEvent: (e) => events.push(e.type),
    });
    expect(reply.content).toBe("答案");
    expect(calls()).toBe(1);
    expect(events).toEqual([]);
  });

  it("正常：工具轮执行并把结果回喂下一轮", async () => {
    const script: AssistantReply[] = [
      { content: "", toolCalls: [{ id: "t1", name: "scene.list", arguments: "{}" }] },
      { content: "有 2 个场景", toolCalls: [] },
    ];
    const { chat, calls } = stubChat(script);
    const seen: string[] = [];
    const events: Array<{ type: string; name: string }> = [];
    const reply = await runAgent({
      messages: [{ role: "user", content: "列场景" }],
      tools: assistantTools(),
      chat,
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async (name) => {
        seen.push(name);
        return [{ name: "Main.scene" }];
      },
      onEvent: (e) => events.push({ type: e.type, name: e.name }),
    });
    expect(seen).toEqual(["scene.list"]);
    expect(reply.content).toBe("有 2 个场景");
    expect(calls()).toBe(2);
    expect(events.map((e) => e.type)).toEqual(["tool_start", "tool_result"]);
  });

  it("异常：工具抛错以 {error} 回喂而非中断", async () => {
    const script: AssistantReply[] = [
      { content: "", toolCalls: [{ id: "t1", name: "node.add", arguments: "不是json" }] },
      { content: "已改用默认参数", toolCalls: [] },
    ];
    const { chat } = stubChat(script);
    const results: string[] = [];
    const reply = await runAgent({
      messages: [{ role: "user", content: "加个节点" }],
      tools: assistantTools(),
      chat,
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async (name, args) => {
        JSON.parse(args);
        void name;
        return "ok";
      },
      onEvent: (e) => {
        if (e.type === "tool_result") results.push(e.result ?? "");
      },
    });
    expect(results[0]).toContain("error");
    expect(reply.content).toBe("已改用默认参数");
  });

  it("边界：连续工具轮达到上限后返回提示而非死循环", async () => {
    const { chat } = stubChat([
      { content: "", toolCalls: [{ id: "t", name: "editor.state", arguments: "{}" }] },
    ]);
    const reply = await runAgent({
      messages: [{ role: "user", content: "循环" }],
      tools: assistantTools(),
      chat,
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async () => ({}),
      maxRounds: 3,
    });
    expect(reply.content).toContain("轮");
    expect(reply.toolCalls).toHaveLength(0);
  });
});

describe("buildSystemPrompt", () => {
  it("正常：默认身份 + 环境项目 + 工具 + 技能索引", () => {
    const prompt = buildSystemPrompt(null, "D:/proj", assistantTools());
    expect(prompt).toContain("TvE Hub");
    expect(prompt).toContain("D:/proj");
    expect(prompt).toContain("scene.list");
    expect(prompt).toContain("load_skill");
  });
  it("正常：策略门注入（brain.plan 三态决策语义）", () => {
    const prompt = buildSystemPrompt(null, "", assistantTools());
    expect(prompt).toContain("brain.plan");
    expect(prompt).toContain("autoExecute");
    expect(prompt).toContain("needConfirm");
    expect(prompt).toContain("deny");
  });
  it("异常：卡片自定义系统提示词替代默认身份，但工具与技能索引保留", () => {
    const prompt = buildSystemPrompt(
      cardFixture({ systemPrompt: "你是一只猫" }),
      "",
      assistantTools(),
    );
    expect(prompt).toContain("你是一只猫");
    expect(prompt).not.toContain("内置助手");
    expect(prompt).toContain("load_skill");
  });
  it("空值：无人设卡片回退默认文案", () => {
    const prompt = buildSystemPrompt(cardFixture({}), "");
    expect(prompt).toContain("内置助手");
    expect(prompt).toContain("未打开");
  });
});
