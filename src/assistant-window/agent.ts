// 助手对话循环：wire 协议组装、工具调用轮（并行执行、可中途终止）。
// 职责收敛后本文件只做决策循环；流式传输在 ./transport，正文 JSON 调用
// 解析在 ./inline-tools（不支持 function-calling 的模型把调用写进正文时兜底）。
// 工具结果只在当轮内存中回喂，历史持久化时丢弃工具轮（API 安全：无
// tool_calls 的 tool 消息会被服务端拒绝）。

import { skillIndexPrompt } from "./skills";
import { cleanedContent, parseInlineToolCalls, stripCallTags } from "./inline-tools";
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
/** 空回复续跑预算：方言模型/不稳供应商一轮任务里可能空嗝多次——2 次不够会
 * 频繁落兜底文案打断任务（用户被迫手动「继续」），给到 4 次 */
const MAX_EMPTY_RESCUES = 8;

/** 正文疑似工具调用但解析失败的痕迹（只认标签形态，普通 JSON 数据不误伤） */
const TOOL_MARK_RE = /<\s*tool_call|<\s*invoke\b|<\s*function\b|<\/\s*(tool_call|invoke|function)>/;
/** 格式纠偏提示（解析失败时作为 user 消息回灌） */
const TOOL_FORMAT_NUDGE =
  "（系统）你上面的工具调用格式无法解析、没有被执行。请改用以下任一格式重新发起，" +
  "除调用外不要输出多余文字：\n" +
  '① 正文独立 JSON：{"tool": "方法名", "input": {参数}}\n' +
  '② <invoke name="方法名"><parameter name="参数名">值</parameter></invoke>';
/** 行动宣言特征：模型宣布"要去做"却没带任何调用（拉回循环的判据）。
 * 措辞千变万化（"我先并行添加""先验证参数能力"…），宁可放宽——误救的代价
 * 有界（提示模型别重复已完成步骤，至多烧掉救援预算后照常收尾），
 * 漏救的代价是任务停在宣言上让用户手动「继续」。 */
const ANNOUNCE_RE =
  /(开始执行|现在开始|我将|我会|让我先|我先|接下来|依次|确认后|请稍等|第一步|然后加|然后写|先建|先打开|先并|先读取|先写|先添加|先创建|先执行|先调用|先发起|先验证|先检查|先搭建|先处理|准备执行|即将执行|分步执行|并行(添加|创建|执行|发起|调用|写入|搭建|验证)|计划如下|步骤如下|方案如下|执行计划|执行步骤)/;
/** 取消/终止语义的回应（宣言救援必须避让，否则会把"好的我将停止"也拉回干活） */
const CANCELLED_RE = /(取消|停止|退出|中止|不再执行|放弃本次)/;
/** 宣言救援提示 */
const ANNOUNCE_NUDGE =
  "（系统）你只输出了文字说明，没有发起任何工具调用，任务尚未开始也未完成。" +
  "请先查看上文工具结果判断进度，只发起「尚未完成的」剩余步骤的工具调用（无依赖的调用可在同一轮并行）；" +
  "已成功执行的步骤不要重复执行。" +
  "全部步骤执行完毕后，再输出包含结果的最终总结。在此之前不要输出纯文字回合。";
/** 空回复续跑提示（开头措辞是 spec 判据，保持稳定）。附教学：任务完成时
 * 用「任务完成」开头收尾——这是回喂后纯文本轮放行的明确出口。 */
const EMPTY_NUDGE =
  "（系统）你返回了空回复、无内容占位，或只是复读了工具结果/上一轮回喂文本，" +
  "任务尚未推进。请查看上文工具结果判断进度，继续发起剩余步骤的工具调用（已完成的不要重复）；" +
  "如果任务已全部完成，请仅输出以「任务完成」开头的最终总结，不要再有其他内容。";

/** 终止注记：救援预算耗尽仍无工具推进时，给用户可见的暂停说明与继续指引——
 * 「任务被自动终止」必须是显式的、可恢复的，不允许静默停在半截 */
const STALL_NOTE =
  "（系统）任务已在此暂停：连续多轮没有有效的工具推进。回复「继续」让助手接着执行剩余步骤，" +
  "或换一种表述重新下达指令。";

function stalled(content: string): AssistantReply {
  // 坏格式调用残骸不上屏（模型历史保留原文供自纠）
  const text = stripCallTags(content);
  return {
    content: (text ? text + "\n\n" : "") + STALL_NOTE,
    toolCalls: [],
  };
}

/** 复读判定：回复几乎原样复述了最近一次工具回喂文本（弱模型把回喂当输出
 * 复读，不产生任何推进）。复读通常原样起头——开头 20 字与回喂一致且全文
 * 不超出回喂太多才算；结果核心太短（如 {ok:true}）不判，避免误伤简短总结。 */
export function looksLikeEcho(content: string, feedCore: string): boolean {
  const text = content.replace(/\s+/g, "");
  const feed = feedCore.replace(/\s+/g, "");
  if (!text || feed.length < 24) return false;
  return text.startsWith(feed.slice(0, 20)) && text.length <= feed.length + 40;
}

/** 完成语义：回喂后的纯文本轮放行收尾的判据。弱模型常见"一步一轮"——每轮
 * 输出一段中途评论就停；只有明确说"做完了"（含系统教学标记「任务完成」开头）
 * 才允许任务结束。否定表述（未完成/还没完成）必须先于肯定词排除。 */
const COMPLETION_RE =
  /(任务完成|已全部完成|全部完成|已完成|已修复|已修正|已写入|已创建|已保存|已添加|已删除|已打开|已关闭|完成|搞定|可以了)/;
const INCOMPLETE_RE = /(未完成|没有完成|尚未完成|还没(有)?完成|未修复|未修正|待完成)/;

export function looksLikeCompletion(text: string): boolean {
  if (!text) return false;
  if (INCOMPLETE_RE.test(text)) return false;
  return COMPLETION_RE.test(text);
}

/** 内联调用轮写进历史的占位正文（模型只发调用没写字时防供应商空回复）。
 * 弱模型会把这句占位当自己的"状态汇报"原样复读出来——那不是总结，
 * 会被下方空回复救援识别并拉回循环，绝不能当作任务的最终结论。 */
export const CALLS_PLACEHOLDER = "（已发起工具调用）";

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
        "会话依赖：node.* 与 preview.* 只对「已在编辑器打开」的项目生效。project.create 只在磁盘建项目——建完必须先 project.open 打开它，才能 node.add / scene.save / 预览。project.open 在没有编辑器窗口时会新开一个编辑器窗口加载（返回即已就绪），有编辑器窗口时切换其工作区。多步建造任务按顺序推进：project.create → project.open → 场景/节点操作 → 保存。",
        "项目未打开时 node.* 会报「没有活跃的编辑器窗口」，此时先 project.open，不要反复重试同一调用。",
        "参数缺省即有默认值时直接采用默认执行，不要为可选参数暂停询问；只有缺失会造成不可逆破坏（误删、覆盖已有成果）时才向用户确认。",
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
      "工具执行由后端大脑决策中心统一门控：只读（绿灯）直接执行；写操作（黄灯）会先请求用户批准，批准一次即覆盖本任务的后续写调用。收到「用户拒绝执行」的回执时改为只读方案或询问用户，不要原样重试同一调用。",
      "调用方式：优先 function-calling 的 tool_calls；若当前模型不支持，则在正文中输出独立 JSON 对象（每块一个调用）：{\"tool\": \"方法名\", \"input\": {参数}}，系统会识别并代为执行。",
      "回合协议：不要输出「开始执行」「我将依次操作」之类的过渡宣言——纯文字回合会被视为任务结束。要么直接发起工具调用（无依赖的调用放同一轮并行），要么在全部步骤完成后输出以「任务完成」开头的最终总结；没有工具需要调用且任务未完成时，继续发起调用而不是输出说明文字。",
      "任务边界：每条新的用户消息是一个独立任务——brain.plan 的 task 与工具调用只描述本轮新指令；往期任务已完成的操作（见「会话进度备忘」）不要并入计划、也不要再次执行，需要先前成果时直接引用其结果（项目名/路径）。",
      "防重复：每次发起调用前先看上文结果与「会话进度备忘」判断进度——已成功执行的步骤不要再次执行；报错的步骤先修正参数，也不要原样重发。",
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
  let nudges = 0;
  const MAX_FORMAT_NUDGES = 2;
  /** 宣言救援已用次数 */
  let rescues = 0;
  /** 空回复续跑已用次数 */
  let emptyRescues = 0;
  /** 最近一次工具回喂文本头部（复读检测基准；首轮无前序工具时为空） */
  let lastFeedCore = "";
  /** 上一轮是否为工具执行轮（回喂后紧跟的纯文本轮按"未完成"处理，见下） */
  let lastWasFeed = false;
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
        // 清洗后正文为空（模型只发调用没写字）时放占位文本：空 assistant 消息
        // 会让部分供应商返回空回复，方言调用轮的历史里全是这种消息
        let cleaned = cleanedContent(reply.content);
        if (!cleaned.trim()) cleaned = CALLS_PLACEHOLDER;
        finalReply = { ...reply, content: cleaned };
        history[history.length - 1].content = cleaned;
      }
    }
    if (!calls.length) {
      // 空回复自动续跑：空内容多半是供应商打嗝，占位回声（模型复读上一轮
      // 系统写入的「（已发起工具调用）」）与工具回喂复读（弱模型把回喂文本
      // 原样输出）同理——都不是任务结论也不是推进，拉回循环继续剩余步骤
      //（最多 4 次）
      const text = reply.content.trim();
      const echo = looksLikeEcho(finalReply.content, lastFeedCore);
      if (text === "" || text === CALLS_PLACEHOLDER || echo) {
        if (emptyRescues < MAX_EMPTY_RESCUES) {
          emptyRescues += 1;
          history.push({ role: "user", content: EMPTY_NUDGE });
          continue;
        }
        // 预算用尽：空回复原样交由调用方兜底文案；复读带显式暂停注记
        return echo ? stalled(finalReply.content) : reply;
      }
      // 确认请求是合法终止态（needConfirm 策略门）：立即返回交给确认浮动条。
      // 必须先于格式纠偏/宣言救援——「确认后我就开始」式请求含宣言特征词，
      // 被救援拉回循环会让模型跳过用户批准直接执行。
      if (looksLikeConfirmRequest(finalReply.content)) {
        return finalReply;
      }
      // 有工具调用痕迹但全部解析失败：注入纠偏提示让模型重发（至多 2 次），而不是停轮
      if (nudges < MAX_FORMAT_NUDGES && TOOL_MARK_RE.test(reply.content)) {
        nudges += 1;
        history.push({ role: "user", content: TOOL_FORMAT_NUDGE });
        continue;
      }
      // 行动宣言救援：模型宣布"要执行"却没带调用——拉回循环真正发起调用
      //（最多救 3 次；取消语义不救；确认请求已在上方先行返回）
      if (rescues < 3 && !CANCELLED_RE.test(reply.content) && ANNOUNCE_RE.test(reply.content)) {
        rescues += 1;
        history.push({ role: "user", content: ANNOUNCE_NUDGE });
        continue;
      }
      // 救援耗尽仍无推进（宣言/坏痕迹）：显式暂停注记，不再静默按"最终回答"返回
      if (ANNOUNCE_RE.test(reply.content) || TOOL_MARK_RE.test(reply.content)) {
        return stalled(finalReply.content);
      }
      // 弱模型「一步一轮」：工具回喂后输出一段中途评论就停，每步都要用户手动
      // 「继续」。回喂后紧跟的纯文本轮默认视为未完成——只有明确完成表述
      // （looksLikeCompletion）或取消语义才允许结束；其余自动续跑
      if (lastWasFeed && !CANCELLED_RE.test(reply.content) && !looksLikeCompletion(finalReply.content)) {
        if (emptyRescues < MAX_EMPTY_RESCUES) {
          emptyRescues += 1;
          history.push({ role: "user", content: EMPTY_NUDGE });
          continue;
        }
        return stalled(finalReply.content);
      }
      // 正常收尾：正文仍过一遍残骸净化（防调用标签碎片裸露）
      return { content: stripCallTags(reply.content), toolCalls: [] };
    }
    if (opts.shouldStop?.()) {
      return stopped(
        (finalReply.content ? finalReply.content + "\n\n" : "") + "已停止，列出的操作未执行。",
      );
    }
    // 同轮调用互相独立 → 并行执行；结果按调用顺序回喂，配对关系不变
    const results = await Promise.all(calls.map((call) => execOne(opts, call, inline)));
    history.push(...results);
    // 复读检测基准 = 最近一次回喂文本头部（inline 与 native tool 通道都覆盖）
    lastFeedCore = results[results.length - 1]?.content?.slice(0, 200) ?? "";
    lastWasFeed = true;
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

// ---------------------------------------------------------------------------
// 跨轮会话进度备忘：wire 历史不回放工具结果（toWire 丢弃工具轮），模型跨轮
// 只见上一轮总结——规划时容易把往期任务并入 brain.plan 造成重复执行。发送时
// 把「本会话已成功的写操作」列成一行短句注入 wire（不落库），给模型明确的
// 防重复事实源。
// ---------------------------------------------------------------------------

/** 计入备忘的方法（写/会改变状态的操作；读操作重复无害，不列） */
const WRITE_METHODS = new Set([
  "project.create", "project.open",
  "asset.write", "asset.create", "asset.delete", "asset.rename",
  "node.add", "node.remove", "node.rename", "node.set",
  "scene.open", "scene.save",
]);
/** 备忘摘要优先取的参数键（识别性强的短字段） */
const ARG_DIGEST_KEYS = ["name", "path", "rel", "kind", "id", "parent"];

function argDigest(argsJson: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    return "";
  }
  const keys = Object.keys(parsed).filter((k) => ARG_DIGEST_KEYS.includes(k));
  const picked = (keys.length ? keys : Object.keys(parsed).slice(0, 1)).slice(0, 2);
  return picked
    .filter((k) => parsed[k] !== undefined && parsed[k] !== null && parsed[k] !== "")
    .map((k) => `${k}=${String(parsed[k]).slice(0, 24)}`)
    .join(", ");
}

/** 会话工具消息时间线 → 已成功写操作的备忘短句（无则空串）。
 * 调用/结果按 toolCallId 配对（无 id 的历史孤儿按同名 FIFO 兜底）。 */
export function doneWritesNote(
  rows: Array<{ role: string; toolName?: string; toolCallId?: string; content: string; result?: boolean }>,
): string {
  const pending = new Map<string, { name: string; args: string }>();
  const fifo = new Map<string, Array<{ name: string; args: string }>>();
  const done: string[] = [];
  for (const m of rows) {
    if (m.role !== "tool" || !m.toolName || !WRITE_METHODS.has(m.toolName)) continue;
    if (!m.result) {
      const entry = { name: m.toolName, args: m.content };
      if (m.toolCallId) pending.set(m.toolCallId, entry);
      else {
        const list = fifo.get(m.toolName) ?? [];
        list.push(entry);
        fifo.set(m.toolName, list);
      }
      continue;
    }
    let call = m.toolCallId ? pending.get(m.toolCallId) : undefined;
    if (!call) call = fifo.get(m.toolName)?.shift();
    if (!call) call = { name: m.toolName, args: "" }; // 孤儿结果：名字仍可列
    let failed = false;
    try {
      const v = JSON.parse(m.content) as { error?: unknown };
      failed = !!(v && typeof v === "object" && "error" in v);
    } catch {
      failed = false;
    }
    if (!failed) {
      const entry = `${call.name}(${argDigest(call.args)})`;
      if (done[done.length - 1] !== entry) done.push(entry);
    }
  }
  if (!done.length) return "";
  const list = done.slice(-6).join("；");
  return `（系统）会话进度备忘——以下写操作已成功执行，不要重复执行，直接基于其结果继续本轮任务：${list}`;
}

/** 确认请求识别：最终回复是否在向用户要确认/批准（弹出确认浮动条的判据）。
 * 只认「要确认」的句式，不认一般性的"已确认/确认无误"等陈述。长回复
 * （needConfirm 的计划+完整脚本可达数千字）只看结尾段——确认问句总是收尾
 * 出现；整体匹配会漏掉超长确认请求，弹窗因此不出现。 */
export function looksLikeConfirmRequest(text: string): boolean {
  if (!text) return false;
  const patterns: RegExp[] = [
    /(回复|发送|输入|回)[「"'『『]?\s*(确认|同意|批准|确定|OK|ok)/,
    /(确认|批准|同意)(后|之后|再)(我|就|再|开始|执行)/,
    /是否(按此|按上面|同意|确认|需要|执行|继续)/,
    /(需要|需)确认/,
    /等待(你|用户)?(确认|批准|同意)/,
    /请(你)?(确认|批准|同意)/,
  ];
  const scope = text.length > 2000 ? text.slice(-800) : text;
  return patterns.some((p) => p.test(scope));
}
