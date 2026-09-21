// 助手对话循环：wire 协议组装、流式传输（Tauri 事件回推）、工具调用轮。
// chat 传输可注入（测试传桩）；工具结果只在当轮内存中回喂，历史持久化时
// 丢弃工具轮（API 安全：无 tool_calls 的 tool 消息会被服务端拒绝）。

import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import { skillIndexPrompt } from "./skills";
import { assistantTools, type OpenAITool } from "./tools";
import type { AgentCard } from "./store";

export interface ToolCall {
  id: string;
  name: string;
  /** JSON 字符串 */
  arguments: string;
}

export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface AssistantReply {
  content: string;
  toolCalls: ToolCall[];
}

export interface StreamArgs {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  messages: WireMessage[];
  onDelta?: (cumulative: string) => void;
}

export type ChatFn = (args: StreamArgs) => Promise<AssistantReply>;

/** 轮上限与工具结果截断（超限返回提示文案而非报错） */
const MAX_ROUNDS = 8;
const TOOL_RESULT_LIMIT = 4000;

/** Tauri 事件流传输：ai:chunk / ai:done / ai:error（Rust SSE 解析后回推） */
export function createTauriTransport(): ChatFn {
  return async (args) => {
    const reqId = `r_${Date.now().toString(36)}${Math.floor(Math.random() * 1e8).toString(36)}`;
    let content = "";
    const calls = new Map<number, ToolCall & { argsBuf: string }>();
    let done = false;
    let error: string | null = null;

    const offChunk = await listen("ai:chunk", (e) => {
      const p = e.payload as { reqId?: string; delta?: string; toolCalls?: unknown };
      if (p.reqId !== reqId) return;
      if (typeof p.delta === "string" && p.delta) {
        content += p.delta;
        args.onDelta?.(content);
      }
      if (Array.isArray(p.toolCalls)) {
        for (const raw of p.toolCalls as Array<Record<string, any>>) {
          const index = typeof raw.index === "number" ? raw.index : 0;
          const slot = calls.get(index) ?? { id: "", name: "", arguments: "", argsBuf: "" };
          if (typeof raw.id === "string" && raw.id) slot.id = raw.id;
          const fn = raw.function ?? {};
          if (typeof fn.name === "string" && fn.name) slot.name = fn.name;
          if (typeof fn.arguments === "string") slot.argsBuf += fn.arguments;
          calls.set(index, slot);
        }
      }
    });
    const offDone = await listen("ai:done", (e) => {
      if ((e.payload as { reqId?: string }).reqId === reqId) done = true;
    });
    const offError = await listen("ai:error", (e) => {
      const p = e.payload as { reqId?: string; message?: string };
      if (p.reqId === reqId) error = p.message ?? "未知错误";
    });
    try {
      await api.aiChatStream({
        reqId,
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
        model: args.model,
        messages: args.messages,
        temperature: args.temperature,
      });
      const deadline = Date.now() + 300_000;
      while (!done && error === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (error === null && !done) error = "响应超时";
    } finally {
      offChunk();
      offDone();
      offError();
    }
    if (error !== null) throw new Error(error);
    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => ({
        id: c.id || `call_${i}`,
        name: c.name,
        arguments: c.argsBuf || "{}",
      }));
    return { content, toolCalls };
  };
}

/** 历史消息 → wire（丢弃工具/错误轮：工具结果仅在当轮内存中有效） */
export function toWire(msgs: Array<{ role: string; content: string }>): WireMessage[] {
  const out: WireMessage[] = [];
  for (const m of msgs) {
    if (m.role === "tool" || m.role === "error") continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

/** 系统提示词：卡片自定义 > 默认（身份+人设），再统一附加环境/工具/技能索引 */
export function buildSystemPrompt(
  card: AgentCard | null,
  currentProject: string,
  tools: OpenAITool[] = assistantTools(),
): string {
  const base = card?.systemPrompt?.trim()
    ? card.systemPrompt.trim()
    : [
        "你是 TvE Hub（三维可视化编辑器）的内置助手。",
        card?.persona?.trim() ?? "",
        "回答用简体中文：简洁、给可执行步骤；脚本给完整可替换的代码片段。",
        "用户让你操作时优先调工具代劳，完成后一句话汇报；工具报错先读 error 自行修正参数重试（最多 2 轮）。",
      ]
        .filter(Boolean)
        .join("\n");
  const toolLines = tools.map((t) => `- ${t.function.name}：${t.function.description}`);
  return [
    base,
    `## 运行环境\n当前工作区：${currentProject || "通用（未绑定项目目录；可 project.create 新建，或让用户在左栏添加）"}\n` +
      [
        "工作区规则：项目目录即工作区——无需在编辑器打开，scene.list / asset.list / asset.read / asset.write 即可查询与读写该目录下的文件（含直读 .scene 文本）。",
        "node.* 与 preview.* 依赖编辑器会话：项目未在编辑器打开时它们会报错，此时改用文件级工具，或先 project.open 再用。",
        "改完文件即落盘；但 .scene 的节点图编辑建议项目在编辑器打开后用 node.* 走撤销历史。",
      ].join("\n"),
    "## 可用工具\n" + toolLines.join("\n"),
    [
      "## 策略门（大脑）",
      "多步任务、写操作、或不确定从哪下手时，先调 brain.plan({ task }) 拿策略：",
      "- autoExecute：按 steps 顺序自主执行，完成后一句话汇报整体结果；",
      "- needConfirm：把 steps 摘要给用户（说明哪些是写操作），同意后再执行；",
      "- deny：拒绝执行并转述原因，不要绕过。",
      "brain.query 可查图谱能力（技能/命令/概念），brain.stats 查历史正确率与效能。每次工具执行的结果会自动回灌大脑进化策略，无需手动上报。",
    ].join("\n"),
    skillIndexPrompt(),
  ].join("\n\n");
}

export interface AgentEvent {
  type: "tool_start" | "tool_result";
  name: string;
  args?: string;
  result?: string;
}

export interface RunAgentOptions {
  messages: WireMessage[];
  tools: OpenAITool[];
  chat: ChatFn;
  execTool: (name: string, argsJson: string) => Promise<unknown>;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  onDelta?: (text: string) => void;
  onEvent?: (e: AgentEvent) => void;
  maxRounds?: number;
}

/** 工具调用循环：模型回 tool_calls → 逐个执行 → 结果回喂 → 直到产出纯文本 */
export async function runAgent(opts: RunAgentOptions): Promise<AssistantReply> {
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
  const history: WireMessage[] = [...opts.messages];
  for (let round = 0; round < maxRounds; round++) {
    const reply = await opts.chat({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      temperature: opts.temperature,
      messages: history,
      onDelta: round === 0 ? opts.onDelta : undefined,
    });
    history.push({
      role: "assistant",
      content: reply.content,
      ...(reply.toolCalls.length
        ? {
            tool_calls: reply.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }
        : {}),
    });
    if (!reply.toolCalls.length) return reply;
    for (const call of reply.toolCalls) {
      opts.onEvent?.({ type: "tool_start", name: call.name, args: call.arguments });
      let result: string;
      try {
        result = truncateResult(await opts.execTool(call.name, call.arguments));
      } catch (e) {
        result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
      history.push({ role: "tool", content: result, tool_call_id: call.id });
      opts.onEvent?.({ type: "tool_result", name: call.name, result });
    }
  }
  return {
    content: `已连续工具调用 ${maxRounds} 轮，暂停执行。告诉我「继续」可接着跑，或调整方向。`,
    toolCalls: [],
  };
}

function truncateResult(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > TOOL_RESULT_LIMIT ? text.slice(0, TOOL_RESULT_LIMIT) + "…（已截断）" : text;
}
