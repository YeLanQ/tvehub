import { describe, expect, it } from "vitest";
import { buildSystemPrompt, compactToolHistory, doneWritesNote, looksLikeCompletion, looksLikeConfirmRequest, runAgent, toWire } from "./agent";
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
      { content: "查询完成，共有 2 个场景。", toolCalls: [] },
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
    expect(reply.content).toBe("查询完成，共有 2 个场景。");
    expect(calls()).toBe(2);
    expect(events.map((e) => e.type)).toEqual(["tool_start", "tool_result"]);
  });

  it("异常：工具抛错以 {error} 回喂而非中断", async () => {
    const script: AssistantReply[] = [
      { content: "", toolCalls: [{ id: "t1", name: "node.add", arguments: "不是json" }] },
      { content: "已改用默认参数，修正完成。", toolCalls: [] },
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
    expect(reply.content).toBe("已改用默认参数，修正完成。");
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
      { content: "好了，全部完成。", toolCalls: [] },
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
    expect(reply.content).toBe("好了，全部完成。");
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

  it("边界：宣言救援最多 3 次，之后纯文字附显式暂停注记返回（不静默终止）", async () => {
    let n = 0;
    const script: AssistantReply[] = [
      { content: "开始执行。", toolCalls: [] },
      { content: "接下来加节点。", toolCalls: [] },
      { content: "我先并行添加基础节点。", toolCalls: [] },
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
    expect(reply.content).toContain("然后写脚本。");
    expect(reply.content).toContain("已在此暂停");
  });

  it("正常：工具回喂被模型复读时不终止，拉回循环继续推进", async () => {
    const script: AssistantReply[] = [
      // 第一轮：内联调用（产生「[工具 xx 执行结果]」回喂文本，成为复读基准）
      { content: '{"tool": "scene.open", "input": {"rel": "a.scene"}}', toolCalls: [] },
      // 第二轮：复读回喂文本（截图中「任务被自动终止」的形态）
      {
        content:
          '[工具 scene.open 执行结果]\n{"ok":true,"scene":"a.scene"}\n（系统代为执行，请基于以上结果继续）',
        toolCalls: [],
      },
      // 第三轮：被拉回后正常收尾
      { content: "场景已打开。", toolCalls: [] },
    ];
    let n = 0;
    const reply = await runAgent({
      messages: [{ role: "user", content: "打开场景" }],
      tools: assistantTools(),
      chat: async () => script[n++],
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async () => ({ ok: true, scene: "a.scene" }),
    });
    expect(reply.content).toBe("场景已打开。");
    expect(n).toBe(3);
  });

  it("边界：复读救援预算用尽后返回带暂停注记的复读文本", async () => {
    const feed =
      '[工具 scene.open 执行结果]\n{"ok":true,"scene":"assets/QuickStart.scene"}\n（系统代为执行，请基于以上结果继续）';
    let n = 0;
    const script: AssistantReply[] = [
      { content: '{"tool": "scene.open", "input": {"rel": "a"}}', toolCalls: [] },
      { content: feed, toolCalls: [] },
      { content: feed, toolCalls: [] },
      { content: feed, toolCalls: [] },
      { content: feed, toolCalls: [] },
      { content: feed, toolCalls: [] },
      { content: feed, toolCalls: [] },
      { content: feed, toolCalls: [] },
      { content: feed, toolCalls: [] },
      { content: feed, toolCalls: [] },
      { content: "（不应走到这一条）", toolCalls: [] },
    ];
    const reply = await runAgent({
      messages: [{ role: "user", content: "打开场景" }],
      tools: assistantTools(),
      chat: async () => script[Math.min(n++, script.length - 1)],
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async () => ({ ok: true, scene: "assets/QuickStart.scene" }),
    });
    expect(reply.content).toContain("已在此暂停");
    expect(n).toBe(10); // 首轮调用 + 8 次复读救援 + 终止轮
  });

  it("正常：回喂后的中途评论（无完成语义）自动续跑，不再要求用户手动「继续」", async () => {
    const script: AssistantReply[] = [
      { content: '{"tool": "asset.read", "input": {"path": "src/a.ts"}}', toolCalls: [] },
      // 回喂后的中途评论：无调用、无完成词、无宣言词（旧版在这里停轮）
      { content: "好的，我已经读完内容了。", toolCalls: [] },
      {
        content: '{"tool": "asset.write", "input": {"path": "src/a.ts", "content": "x"}}',
        toolCalls: [],
      },
      // 完成语义：放行收尾
      { content: "脚本已修正完成。", toolCalls: [] },
    ];
    let n = 0;
    const reply = await runAgent({
      messages: [{ role: "user", content: "修脚本" }],
      tools: assistantTools(),
      chat: async () => script[n++],
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async () => ({ ok: true }),
    });
    expect(reply.content).toContain("已修正完成");
    expect(n).toBe(4);
  });

  it("边界：完成语义放行收尾；否定表述（未完成）不放行", () => {
    expect(looksLikeCompletion("脚本已修正完成。")).toBe(true);
    expect(looksLikeCompletion("全部完成，共 3 步。")).toBe(true);
    expect(looksLikeCompletion("脚本还没有完成，需要继续。")).toBe(false);
    expect(looksLikeCompletion("已定位到两个致命错误。")).toBe(false);
    expect(looksLikeCompletion("")).toBe(false);
  });

  it("边界：正常最终总结不含暂停注记（复读判定不误伤）", async () => {
    const script: AssistantReply[] = [
      { content: '{"tool": "scene.open", "input": {"rel": "a.scene"}}', toolCalls: [] },
      {
        content: "场景打开成功。结果摘录：{\"ok\":true,\"scene\":\"a.scene\"}，已按你的要求完成。",
        toolCalls: [],
      },
    ];
    let n = 0;
    const reply = await runAgent({
      messages: [{ role: "user", content: "打开场景" }],
      tools: assistantTools(),
      chat: async () => script[n++],
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async () => ({ ok: true, scene: "a.scene" }),
    });
    expect(reply.content).not.toContain("已在此暂停");
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

  it("边界：空回复续跑预算 8 次，用尽后原样返回（交兜底文案）", async () => {
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
    expect(calls).toBe(9); // 首轮 + 8 次自动续跑，之后才落兜底文案
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

  it("边界：模型复读系统占位「（已发起工具调用）」不算任务结论，救援续跑", async () => {
    // 回归：多步任务只推进第一轮就停——弱模型把上一轮系统写入历史的占位
    // 正文当自己的状态汇报原样复读，runAgent 误当作最终总结结束循环
    const nudges: string[] = [];
    const script: AssistantReply[] = [
      {
        content: '<tool_call>{"name":"project.create","arguments":{"name":"Demo"}}</tool_call>',
        toolCalls: [],
      },
      { content: "（已发起工具调用）", toolCalls: [] }, // 回声轮：必须被拉回而非停轮
      { content: "项目与节点全部创建完成", toolCalls: [] },
    ];
    let n = 0;
    const executed: string[] = [];
    const reply = await runAgent({
      messages: [{ role: "user", content: "建项目并加节点" }],
      tools: assistantTools(),
      chat: async (args) => {
        // 记录每轮注入的系统救援提示（空回复/占位回声共用 EMPTY_NUDGE）
        for (const m of args.messages) {
          if (m.role === "user" && m.content.startsWith("（系统）你返回了空回复")) nudges.push(m.content);
        }
        return script[Math.min(n++, script.length - 1)];
      },
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool: async (name) => {
        executed.push(name);
        return { path: "D:/Demo" };
      },
    });
    expect(executed).toEqual(["project.create"]);
    expect(nudges).toHaveLength(1); // 占位回声轮应注入一次续跑提示
    expect(reply.content).toBe("项目与节点全部创建完成");
  });

  it("边界：纯宣言措辞（「我先并行添加并验证…」）被救援拉回而非收尾", async () => {
    // 回归：截图原句——模型宣布下一步计划却没带调用，措辞不在旧 ANNOUNCE_RE
    // 里（无"我将/开始执行/第一步"），救援漏触发导致任务停在宣言上
    const script: AssistantReply[] = [
      { content: "", toolCalls: [{ id: "t1", name: "scene.tree", arguments: "{}" }] },
      {
        content: "为保证节点参数与变换设置正确，我先并行添加基础节点并验证 `node.add/node.set` 的参数能力。",
        toolCalls: [],
      },
      { content: "", toolCalls: [{ id: "t2", name: "node.add", arguments: '{"kind":"mesh"}' }] },
      { content: "节点已添加完毕，动画组件已挂载。", toolCalls: [] },
    ];
    let n = 0;
    const executed: string[] = [];
    const reply = await runAgent({
      messages: [{ role: "user", content: "搭场景" }],
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
    expect(executed).toEqual(["scene.tree", "node.add"]);
    expect(reply.content).toContain("已添加完毕");
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
      { content: "都查完了，任务完成。", toolCalls: [] },
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
    expect(reply.content).toBe("都查完了，任务完成。");
    // 回喂顺序 = 调用顺序（与完成时间无关），保证 tool_call_id 配对稳定
    expect(order.sort()).toEqual(["asset.list", "editor.state", "scene.list"]);
  });

  it("正常：模型不支持工具机制时，正文 JSON 调用被识别并执行", async () => {
    const script: AssistantReply[] = [
      {
        content: '我先查状态。\n{ "tool": "editor.state", "input": {} }',
        toolCalls: [],
      },
      { content: "检查完成，状态正常。", toolCalls: [] },
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
    expect(reply.content).toBe("检查完成，状态正常。");
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

describe("compactToolHistory 结果压实", () => {
  /** 构造 [user, 8 批结果（每批后夹一条 assistant 轮）] 的历史与批次起点 */
  const build = () => {
    const big = "y".repeat(1200);
    const history: WireMessage[] = [{ role: "user", content: "任务" }];
    const starts: number[] = [];
    for (let b = 0; b < 8; b++) {
      starts.push(history.length);
      history.push({ role: "tool", content: big + b, tool_call_id: `t${b}` });
      history.push({ role: "assistant", content: `第${b}步` });
    }
    return { history, starts, big };
  };

  it("正常：保留窗外的旧结果压为头部，窗内保全文（8 批 KEEP=6 → 前 2 批压）", () => {
    const { history, starts, big } = build();
    compactToolHistory(history, starts);
    const c0 = history[starts[0]]?.content ?? "";
    const c1 = history[starts[1]]?.content ?? "";
    const c2 = history[starts[2]]?.content ?? "";
    const c7 = history[starts[7]]?.content ?? "";
    expect(c0.length).toBeLessThan(600);
    expect(c1).toContain("已压实");
    expect(c2).toBe(big + 2);
    expect(c7).toBe(big + 7);
  });

  it("边界：批数不超保留窗时一律不动", () => {
    const { history, starts, big } = build();
    const small = starts.slice(0, 5);
    compactToolHistory(history, small);
    for (const i of small) expect(history[i]?.content).toContain(big);
  });

  it("正常：内联框架 user 结果轮同样压实；普通 user 发言不碰", () => {
    const long = "z".repeat(1500);
    const history: WireMessage[] = [
      {
        role: "user",
        content: "[工具 scene.tree 执行结果]\n" + long + "\n（系统代为执行，请基于以上结果继续）",
      },
      { role: "user", content: "帮我把立方体变大一些" },
    ];
    compactToolHistory(history, [0, 1, 2, 3, 4, 5, 6]);
    expect(history[0]?.content.length).toBeLessThan(600);
    expect(history[1]?.content).toBe("帮我把立方体变大一些");
  });

  it("空值：无批次起点与空历史都不报错", () => {
    expect(() => compactToolHistory([], [])).not.toThrow();
    expect(() => compactToolHistory([{ role: "user", content: "x" }], [0])).not.toThrow();
  });
});

describe("runAgent 重复调用守卫（省往返）", () => {
  function loop(
    script: AssistantReply[],
    execTool: (name: string, argsJson: string) => Promise<unknown>,
  ) {
    const { chat } = stubChat(script);
    const events: Array<{ type: string; name: string }> = [];
    const done = runAgent({
      messages: [{ role: "user", content: "跑个任务" }],
      tools: assistantTools(),
      chat,
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      execTool,
      onEvent: (e) => events.push({ type: e.type, name: e.name }),
    });
    return { done, events };
  }
  const call = (id: string, name: string, args: string) => ({ id, name, arguments: args });

  it("正常：同参数纯加载第二次起不触达后端（全文仍在结果窗内）", async () => {
    let execs = 0;
    const { done, events } = loop(
      [
        { content: "", toolCalls: [call("t1", "load_skill", '{"id":"s1"}')] },
        { content: "", toolCalls: [call("t2", "load_skill", '{"id":"s1"}')] },
        { content: "任务完成", toolCalls: [] },
      ],
      async () => {
        execs += 1;
        return { id: "s1", name: "S1", content: "技能正文" };
      },
    );
    const reply = await done;
    expect(execs).toBe(1);
    expect(reply.content).toContain("任务完成");
    // 短路轮同样上屏成对事件（展示行不缺对）
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(2);
  });

  it("异常：同参数连败从第三次起零往返回警告（前两次允许真实重试）", async () => {
    let execs = 0;
    const { done } = loop(
      [
        { content: "", toolCalls: [call("t1", "node.add", '{"kind":"script"}')] },
        { content: "", toolCalls: [call("t2", "node.add", '{"kind":"script"}')] },
        { content: "", toolCalls: [call("t3", "node.add", '{"kind":"script"}')] },
        { content: "", toolCalls: [call("t4", "node.add", '{"kind":"script"}')] },
        { content: "任务完成", toolCalls: [] },
      ],
      async () => {
        execs += 1;
        return { error: "脚本节点缺少脚本路径" };
      },
    );
    const reply = await done;
    expect(reply.content).toContain("任务完成");
    expect(execs).toBe(2);
  });

  it("正常：环境补齐后同参数重试不受限（第二次失败仍真实执行）", async () => {
    let execs = 0;
    const seen: string[] = [];
    const { done } = loop(
      [
        { content: "", toolCalls: [call("t1", "node.add", '{"kind":"group"}')] },
        { content: "", toolCalls: [call("t2", "project.open", '{"path":"D:/p"}')] },
        { content: "", toolCalls: [call("t3", "node.add", '{"kind":"group"}')] },
        { content: "任务完成", toolCalls: [] },
      ],
      async (name) => {
        execs += 1;
        seen.push(name);
        if (name === "node.add" && execs === 1) return { error: "没有活跃的编辑器窗口" };
        return { ok: true };
      },
    );
    const reply = await done;
    expect(reply.content).toContain("任务完成");
    expect(execs).toBe(3);
    expect(seen).toEqual(["node.add", "project.open", "node.add"]);
  });
});
