import { describe, expect, it } from "vitest";
import { buildSystemPrompt, doneWritesNote, looksLikeConfirmRequest, runAgent, toWire } from "./agent";
import { assistantTools } from "./tools";
import type { AgentCard } from "./store";
import type { AssistantReply, WireMessage } from "./agent";

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

  it("正常：正文残缺 tool_call 壳被解析执行（不空停）", async () => {
    const garbage =
      '<tool_call>\n<function=name="tool_calls">\n' +
      '{"name": "brain.plan", "arguments": {"task": "创建3D项目"}}\n' +
      "</parameter>\n</function>\n</tool_call>";
    let n = 0;
    const script: AssistantReply[] = [
      { content: garbage, toolCalls: [] },
      { content: "计划完成", toolCalls: [] },
    ];
    const executed: string[] = [];
    const reply = await runAgent({
      messages: [{ role: "user", content: "建项目" }],
      tools: assistantTools(),
      chat: async () => script[Math.min(n++, script.length - 1)],
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async (name) => {
        executed.push(name);
        return { decision: "autoExecute" };
      },
    });
    expect(executed).toEqual(["brain.plan"]);
    expect(reply.content).toBe("计划完成");
  });

  it("异常：正文带调用痕迹但解析失败时，纠偏提示续跑而不是停轮", async () => {
    let n = 0;
    const script: AssistantReply[] = [
      { content: '<tool_call>\n完全无法解析\n</tool_call>', toolCalls: [] },
      { content: '{ "tool": "editor.state", "input": {} }', toolCalls: [] },
      { content: "好了", toolCalls: [] },
    ];
    const executed: string[] = [];
    const reply = await runAgent({
      messages: [{ role: "user", content: "查状态" }],
      tools: assistantTools(),
      chat: async () => script[Math.min(n++, script.length - 1)],
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async (name) => {
        executed.push(name);
        return {};
      },
    });
    expect(executed).toEqual(["editor.state"]);
    expect(reply.content).toBe("好了");
  });

  it("正常：行动宣言（纯文字无调用）被拉回循环继续执行", async () => {
    let n = 0;
    const script: AssistantReply[] = [
      { content: "好的，开始执行。先建项目再加立方体。", toolCalls: [] },
      { content: "", toolCalls: [{ id: "t1", name: "project.create", arguments: '{"name":"Demo"}' }] },
      { content: "", toolCalls: [{ id: "t2", name: "project.open", arguments: "{}" }] },
      { content: "已创建并打开项目 Demo，可以继续添加节点。", toolCalls: [] },
    ];
    const executed: string[] = [];
    const reply = await runAgent({
      messages: [{ role: "user", content: "建个项目" }],
      tools: assistantTools(),
      chat: async () => script[Math.min(n++, script.length - 1)],
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async (name) => {
        executed.push(name);
        return {};
      },
    });
    expect(executed).toEqual(["project.create", "project.open"]);
    expect(reply.content).toContain("已创建");
  });

  it("边界：宣言救援最多 2 次，之后纯文字按最终回答返回", async () => {
    let n = 0;
    const script: AssistantReply[] = [
      { content: "开始执行。", toolCalls: [] },
      { content: "接下来加节点。", toolCalls: [] },
      { content: "然后写脚本。", toolCalls: [] },
      { content: "（不应走到这一条）", toolCalls: [] },
    ];
    const reply = await runAgent({
      messages: [{ role: "user", content: "做事" }],
      tools: assistantTools(),
      chat: async () => script[Math.min(n++, script.length - 1)],
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async () => ({}),
    });
    expect(reply.content).toBe("然后写脚本。");
  });

  it("正常：确认请求（needConfirm）立即返回，不被宣言救援拉回循环", async () => {
    let n = 0;
    const confirmReply: AssistantReply = {
      content:
        "计划如下，确认后我就开始：1) 创建项目 2) 添加立方体。是否按此计划执行？（回复「确认」即开始）",
      toolCalls: [],
    };
    const reply = await runAgent({
      messages: [{ role: "user", content: "建个项目" }],
      tools: assistantTools(),
      chat: async () => {
        n += 1;
        return confirmReply;
      },
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async () => ({}),
    });
    expect(reply.content).toBe(confirmReply.content);
    expect(n).toBe(1);
  });

  it("正常：空回复自动续跑，模型继续剩余步骤", async () => {
    let n = 0;
    const script: AssistantReply[] = [
      { content: "", toolCalls: [] },
      { content: "", toolCalls: [{ id: "t1", name: "editor.state", arguments: "{}" }] },
      { content: "全部完成", toolCalls: [] },
    ];
    const executed: string[] = [];
    const reply = await runAgent({
      messages: [{ role: "user", content: "查状态" }],
      tools: assistantTools(),
      chat: async () => script[Math.min(n++, script.length - 1)],
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async (name) => {
        executed.push(name);
        return {};
      },
    });
    expect(executed).toEqual(["editor.state"]);
    expect(reply.content).toBe("全部完成");
  });

  it("边界：空回复续跑预算 4 次，用尽后原样返回（交兜底文案）", async () => {
    const blank: AssistantReply = { content: "", toolCalls: [] };
    let calls = 0;
    const reply = await runAgent({
      messages: [{ role: "user", content: "做事" }],
      tools: assistantTools(),
      chat: async () => {
        calls += 1;
        return blank;
      },
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async () => ({}),
    });
    expect(reply.content).toBe("");
    expect(reply.toolCalls).toHaveLength(0);
    expect(calls).toBe(5); // 首轮 + 4 次自动续跑，之后才落兜底文案
  });

  it("正常：内联调用无正文时，历史 assistant 消息用占位文本（防供应商空回复）", async () => {
    let n = 0;
    const seen: WireMessage[][] = [];
    const script: AssistantReply[] = [
      {
        content: '<tool_call>{"name":"editor.state","arguments":{}}</tool_call>',
        toolCalls: [],
      },
      { content: "全部完成", toolCalls: [] },
    ];
    const reply = await runAgent({
      messages: [{ role: "user", content: "查状态" }],
      tools: assistantTools(),
      chat: async (args) => {
        // 快照：runAgent 每轮传的是同一个 history 数组引用，不拷贝会互相污染
        seen.push(args.messages.map((m) => ({ ...m })));
        return script[Math.min(n++, script.length - 1)];
      },
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async () => ({}),
    });
    expect(reply.content).toBe("全部完成");
    // 第二轮请求里，上一轮"只发调用没写字"的 assistant 消息不能是空正文——
    // 空 assistant 消息会让部分供应商返回空回复
    const assistantMsgs = seen[1].filter((m) => m.role === "assistant");
    expect(assistantMsgs[assistantMsgs.length - 1].content).toBe("（已发起工具调用）");
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

  it("正常：同轮多个调用并行执行（重叠运行），结果按调用顺序回喂", async () => {
    const script: AssistantReply[] = [
      {
        content: "",
        toolCalls: [
          { id: "a", name: "scene.list", arguments: "{}" },
          { id: "b", name: "asset.list", arguments: "{}" },
          { id: "c", name: "editor.state", arguments: "{}" },
        ],
      },
      { content: "都查完了", toolCalls: [] },
    ];
    let running = 0;
    let peak = 0;
    const order: string[] = [];
    const { chat } = stubChat(script);
    const reply = await runAgent({
      messages: [{ role: "user", content: "并行查" }],
      tools: assistantTools(),
      chat,
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async (name) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, name === "asset.list" ? 20 : 1));
        running -= 1;
        order.push(name);
        return { name };
      },
    });
    expect(peak).toBe(3);
    expect(reply.content).toBe("都查完了");
    // 回喂顺序 = 调用顺序（与完成时间无关），保证 tool_call_id 配对稳定
    expect(order.sort()).toEqual(["asset.list", "editor.state", "scene.list"]);
  });

  it("正常：模型不支持工具机制时，正文 JSON 调用被识别并执行", async () => {
    const script: AssistantReply[] = [
      {
        content: '我先查状态。\n{ "tool": "editor.state", "input": {} }',
        toolCalls: [],
      },
      { content: "状态正常", toolCalls: [] },
    ];
    const executed: string[] = [];
    const { chat } = stubChat(script);
    const reply = await runAgent({
      messages: [{ role: "user", content: "看看编辑器状态" }],
      tools: assistantTools(),
      chat,
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async (name) => {
        executed.push(name);
        return { project: "demo" };
      },
    });
    expect(executed).toEqual(["editor.state"]);
    expect(reply.content).toBe("状态正常");
  });

  it("终止：shouldStop 在轮边界生效，未执行的工具保持未执行", async () => {
    let n = 0;
    const script: AssistantReply[] = [
      { content: "", toolCalls: [{ id: "t1", name: "node.add", arguments: "{}" }] },
      { content: "", toolCalls: [{ id: "t2", name: "node.remove", arguments: "{}" }] },
    ];
    const executed: string[] = [];
    let stop = false;
    const reply = await runAgent({
      messages: [{ role: "user", content: "改场景" }],
      tools: assistantTools(),
      chat: async () => script[Math.min(n++, script.length - 1)],
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async (name) => {
        executed.push(name);
        stop = true; // 模拟工具执行期间用户点了停止
        return {};
      },
      shouldStop: () => stop,
    });
    expect(executed).toEqual(["node.add"]);
    expect(reply.content).toContain("停止");
    expect(reply.toolCalls).toHaveLength(0);
  });

  it("终止：内联调用也受 shouldStop 门控（不执行任何工具）", async () => {
    let n = 0;
    const script: AssistantReply[] = [
      { content: '{ "tool": "asset.delete", "input": {} }', toolCalls: [] },
    ];
    const executed: string[] = [];
    const reply = await runAgent({
      messages: [{ role: "user", content: "删掉" }],
      tools: assistantTools(),
      chat: async () => script[Math.min(n++, script.length - 1)],
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async (name) => {
        executed.push(name);
        return {};
      },
      shouldStop: () => true,
    });
    expect(executed).toEqual([]);
    expect(reply.content).toContain("停止");
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

describe("looksLikeConfirmRequest", () => {
  it("正常：识别常见的确认请求句式", () => {
    expect(looksLikeConfirmRequest("需确认的写操作计划（2 次添加 + 1 次保存）…")).toBe(true);
    expect(looksLikeConfirmRequest("回复「确认」我就执行；若想用地形，一并告诉我。")).toBe(true);
    expect(looksLikeConfirmRequest("**是否按此计划执行？** 确认后我依次操作。")).toBe(true);
    expect(looksLikeConfirmRequest("方案已定，确认后我就开始。")).toBe(true);
    expect(looksLikeConfirmRequest("请批准以上步骤，我将依次执行。")).toBe(true);
    expect(looksLikeConfirmRequest("发送 OK 立即开始")).toBe(true);
  });

  it("边界：一般性总结与「已确认」陈述不触发", () => {
    expect(looksLikeConfirmRequest("已创建并打开项目 Demo，节点添加完毕。")).toBe(false);
    expect(looksLikeConfirmRequest("已确认材质路径无误，任务完成。")).toBe(false);
    expect(looksLikeConfirmRequest("（模型这一轮返回了空回复。回复「继续」让它接着执行。）")).toBe(false);
  });

  it("空值：空文本返回 false", () => {
    expect(looksLikeConfirmRequest("")).toBe(false);
  });

  it("边界：超长确认请求（计划+完整脚本 >2000 字）按结尾段识别", () => {
    const script = "@property( type: nodeType ) target: string = '';\n".repeat(120);
    expect(
      looksLikeConfirmRequest(script + "是否按此计划执行？（回复「确认」即开始创建并保存。）"),
    ).toBe(true);
    expect(looksLikeConfirmRequest(script + "以上是本轮执行摘要，任务全部完成。")).toBe(false);
  });
});

describe("doneWritesNote（跨轮防重复备忘）", () => {
  /** 工具消息行桩（调用 + 结果成对，toolCallId 配对） */
  function toolRows(
    ...pairs: Array<{ name: string; args: string; ok: boolean }>
  ): Array<{ role: string; toolName?: string; toolCallId?: string; content: string; result?: boolean }> {
    const rows: Array<{ role: string; toolName?: string; toolCallId?: string; content: string; result?: boolean }> = [];
    pairs.forEach((p, i) => {
      const id = `call_${i}`;
      rows.push({ role: "tool", toolName: p.name, toolCallId: id, content: p.args });
      rows.push({
        role: "tool",
        toolName: p.name,
        toolCallId: id,
        content: p.ok ? '{"ok":true}' : '{"error":"目录已存在"}',
        result: true,
      });
    });
    return rows;
  }

  it("正常：已成功的写操作列进备忘，失败的不列", () => {
    const note = doneWritesNote(
      toolRows(
        { name: "brain.plan", args: '{"task":"建项目"}', ok: true },
        { name: "project.create", args: '{"name":"RotCube"}', ok: true },
        { name: "project.create", args: '{"name":"RotCube"}', ok: false },
      ),
    );
    expect(note).toContain("project.create(name=RotCube)");
    expect(note).toContain("不要重复执行");
    expect(note).not.toContain("brain.plan"); // 非写操作不列
  });

  it("正常：读操作（scene.list/asset.read）不列——重复无害", () => {
    const note = doneWritesNote(
      toolRows(
        { name: "scene.list", args: "{}", ok: true },
        { name: "asset.read", args: '{"path":"a.txt"}', ok: true },
      ),
    );
    expect(note).toBe("");
  });

  it("边界：连续重复的同类成功只记一条，最多保留最近 6 条", () => {
    const many = toolRows(
      { name: "scene.save", args: "{}", ok: true },
      { name: "scene.save", args: "{}", ok: true },
      ...Array.from({ length: 8 }, (_, i) => ({
        name: "asset.write",
        args: `{"path":"f${i}.ts"}`,
        ok: true,
      })),
    );
    const note = doneWritesNote(many);
    expect(note.match(/asset\.write/g)?.length).toBe(6);
    expect(note).not.toContain("scene.save"); // 被最近 6 条挤出
  });

  it("空值：空时间线 / 全失败 → 空串（发送时不注入）", () => {
    expect(doneWritesNote([])).toBe("");
    expect(doneWritesNote(toolRows({ name: "node.add", args: "{}", ok: false }))).toBe("");
  });

  it("边界：无 toolCallId 的历史孤儿按同名 FIFO 配对", () => {
    const rows = [
      { role: "tool", toolName: "node.add", content: '{"kind":"mesh"}' },
      { role: "tool", toolName: "node.add", content: '{"ok":true}', result: true },
    ];
    expect(doneWritesNote(rows)).toContain("node.add(kind=mesh)");
  });
});
