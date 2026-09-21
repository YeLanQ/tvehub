// 助手对话循环：wire 协议组装、工具调用轮（并行执行、可中途终止）。
// 职责收敛后本文件只做决策循环；流式传输在 ./transport，正文 JSON 调用
// 解析在 ./inline-tools（不支持 function-calling 的模型把调用写进正文时兜底）。
// 工具结果只在当轮内存中回喂，历史持久化时丢弃工具轮（API 安全：无
// tool_calls 的 tool 消息会被服务端拒绝）。

import { skillIndexPrompt } from "./skills";
import { cleanedContent, parseInlineToolCalls } from "./inline-tools";
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

/** 轮上限与工具结果截断（超限返回提示文案而非报错）。
 * 建造类任务（建项目 → 开项目 → 逐个加节点 → 写脚本 → 预览）单轮通常只推进
 * 1-2 步，24 轮才够一次完整交付；仍超限时走「继续」续跑。 */
const MAX_ROUNDS = 24;
const TOOL_RESULT_LIMIT = 4000;

/** 正文疑似工具调用但解析失败的痕迹（只认标签形态，普通 JSON 数据不误伤） */
const TOOL_MARK_RE = /<\s*tool_call|<\s*invoke\b|<\s*function\b|<\/\s*(tool_call|invoke|function)>/;
/** 格式纠偏提示（解析失败时作为 user 消息回灌） */
const TOOL_FORMAT_NUDGE =
  "（系统）你上面的工具调用格式无法解析、没有被执行。请改用以下任一格式重新发起，" +
  "除调用外不要输出多余文字：\n" +
  '① 正文独立 JSON：{"tool": "方法名", "input": {参数}}\n' +
  '② <invoke name="方法名"><parameter name="参数名">值</parameter></invoke>';
/** 行动宣言特征：模型宣布"要去做"却没带任何调用（拉回循环的判据） */
const ANNOUNCE_RE =
  /(开始执行|现在开始|我将|我会|接下来|依次|确认后|请稍等|先建|先打开|第一步|然后加|然后写)/;
/** 取消/终止语义的回应（宣言救援必须避让，否则会把"好的我将停止"也拉回干活） */
const CANCELLED_RE = /(取消|停止|退出|中止|不再执行|放弃本次)/;
/** 宣言救援提示 */
const ANNOUNCE_NUDGE =
  "（系统）你只输出了文字说明，没有发起任何工具调用，任务尚未开始也未完成。" +
  "请先查看上文工具结果判断进度，只发起「尚未完成的」剩余步骤的工具调用（无依赖的调用可在同一轮并行）；" +
  "已成功执行的步骤不要重复执行。" +
  "全部步骤执行完毕后，再输出包含结果的最终总结。在此之前不要输出纯文字回合。";
/** 空回复续跑提示 */
const EMPTY_NUDGE =
  "（系统）你返回了空回复，任务尚未完成。请查看上文工具结果判断进度，" +
  "继续发起剩余步骤的工具调用（已完成的不要重复）；全部完成后再输出最终总结。";

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
        "会话依赖：node.* 与 preview.* 只对「已在编辑器打开」的项目生效。project.create 只在磁盘建项目——建完必须先 project.open 打开它，才能 node.add / scene.save / 预览。多步建造任务按顺序推进：project.create → project.open → 场景/节点操作 → 保存。",
        "项目未打开时 node.* 会报「没有活跃的编辑器窗口」，此时先 project.open，不要反复重试同一调用。",
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
      "调用方式：优先 function-calling 的 tool_calls；若当前模型不支持，则在正文中输出独立 JSON 对象（每块一个调用）：{\"tool\": \"方法名\", \"input\": {参数}}，系统会识别并代为执行。",
      "回合协议：不要输出「开始执行」「我将依次操作」之类的过渡宣言——纯文字回合会被视为任务结束。要么直接发起工具调用（无依赖的调用放同一轮并行），要么在全部步骤完成后输出含结果的最终总结。",
      "防重复：每次发起调用前先看上文工具结果判断进度——已成功执行的步骤不要再次执行；报错的步骤先修正参数，也不要原样重发。",
    ].join("\n"),
    skillIndexPrompt(),
  ].join("\n\n");
}

export interface AgentEvent {
  type: "tool_start" | "tool_result";
  name: string;
  args?: string;
  result?: string;
  /** 本次调用的 id（内联调用的 id 以 inline_ 开头） */
  callId?: string;
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
  /** 返回 true 时在轮边界/工具执行前尽快终止（配合「停止」按钮） */
  shouldStop?: () => boolean;
}

/** 工具调用循环：模型回调用 → 并行执行 → 结果回喂 → 直到产出纯文本 */
export async function runAgent(opts: RunAgentOptions): Promise<AssistantReply> {
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
  const history: WireMessage[] = [...opts.messages];
  const stopped = (note: string): AssistantReply => ({ content: note, toolCalls: [] });
  let nudged = false;
  /** 宣言救援已用次数 */
  let rescues = 0;
  /** 空回复续跑已用次数 */
  let emptyRescues = 0;
  for (let round = 0; round < maxRounds; round++) {
    if (opts.shouldStop?.()) return stopped("已按要求停止。");
    const reply = await opts.chat({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      temperature: opts.temperature,
      messages: history,
      onDelta: opts.onDelta,
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
    // 内联兜底：无原生 tool_calls 时从正文里抠调用（JSON / <invoke> / <tool_call>）；
    // 命中时回写净化正文——原始调用块不上屏也不落库
    const inline = reply.toolCalls.length === 0;
    let finalReply = reply;
    let calls: ToolCall[] = reply.toolCalls;
    if (inline) {
      const parsed = parseInlineToolCalls(reply.content);
      calls = parsed.calls;
      if (calls.length) {
        finalReply = { ...reply, content: cleanedContent(reply.content) };
        history[history.length - 1].content = finalReply.content;
      }
    }
    if (!calls.length) {
      // 空回复自动续跑：空内容多半是供应商打嗝，拉回循环继续剩余步骤（最多 2 次）
      if (reply.content.trim() === "") {
        if (emptyRescues < 2) {
          emptyRescues += 1;
          history.push({ role: "user", content: EMPTY_NUDGE });
          continue;
        }
        return reply; // 预算用尽：交由调用方的空回复兜底文案
      }
      // 有工具调用痕迹但全部解析失败：注入纠偏提示让模型重发（单轮一次），而不是停轮
      if (!nudged && TOOL_MARK_RE.test(reply.content)) {
        nudged = true;
        history.push({ role: "user", content: TOOL_FORMAT_NUDGE });
        continue;
      }
      // 行动宣言救援：模型宣布"要执行"却没带调用——拉回循环真正发起调用
      //（最多救 2 次；取消语义不救；真正的最终总结不含未来意图词，不受影响）
      if (rescues < 2 && !CANCELLED_RE.test(reply.content) && ANNOUNCE_RE.test(reply.content)) {
        rescues += 1;
        history.push({ role: "user", content: ANNOUNCE_NUDGE });
        continue;
      }
      return reply;
    }
    if (opts.shouldStop?.()) {
      return stopped(
        (finalReply.content ? finalReply.content + "\n\n" : "") + "已停止，列出的操作未执行。",
      );
    }
    // 同轮调用互相独立 → 并行执行；结果按调用顺序回喂，配对关系不变
    const results = await Promise.all(calls.map((call) => execOne(opts, call, inline)));
    history.push(...results);
  }
  return {
    content: `已连续工具调用 ${maxRounds} 轮，暂停执行。告诉我「继续」可接着跑，或调整方向。`,
    toolCalls: [],
  };
}

/** 执行单个调用：事件上屏 → 执行 → 截断 → 结果按通道回喂。
 * 原生 tool_calls 走 tool 角色；内联调用（模型不支持工具机制）以 user 角色
 * 框架化回喂，避免严格服务端拒绝无 tool_calls 的 tool 消息。 */
async function execOne(
  opts: RunAgentOptions,
  call: ToolCall,
  inline: boolean,
): Promise<WireMessage> {
  opts.onEvent?.({ type: "tool_start", name: call.name, args: call.arguments, callId: call.id });
  let result: string;
  try {
    result = truncateResult(await opts.execTool(call.name, call.arguments));
  } catch (e) {
    result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
  opts.onEvent?.({ type: "tool_result", name: call.name, result, callId: call.id });
  return inline
    ? {
        role: "user",
        content: `[工具 ${call.name} 执行结果]\n${result}\n（系统代为执行，请基于以上结果继续）`,
      }
    : { role: "tool", content: result, tool_call_id: call.id };
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

/** 确认请求识别：最终回复是否在向用户要确认/批准（弹出确认浮动条的判据）。
 * 只认「要确认」的句式，不认一般性的"已确认/确认无误"等陈述。 */
export function looksLikeConfirmRequest(text: string): boolean {
  if (!text || text.length > 2000) return false;
  const patterns: RegExp[] = [
    /(回复|发送|输入|回)[「"'『『]?\s*(确认|同意|批准|确定|OK|ok)/,
    /(确认|批准|同意)(后|之后|再)(我|就|再|开始|执行)/,
    /是否(按此|按上面|同意|确认|需要|执行|继续)/,
    /(需要|需)确认/,
    /等待(你|用户)?(确认|批准|同意)/,
    /请(你)?(确认|批准|同意)/,
  ];
  return patterns.some((p) => p.test(text));
}
