// 正文内联工具调用解析：部分模型/供应商不支持 function-calling，会把调用
// 以文本形式写进回复正文。本模块把这类块抠出来转成 ToolCall，让 runAgent
// 照常执行——指令任务因此不再"只聊天不干活"。
// 支持四种形态：
//   1. JSON 对象：{"tool": "x", "input": {…}} / {"name": "x", "arguments": {…}}
//   2. XML invoke：<invoke name="x"><parameter name="k">v</parameter>…</invoke>
//   3. 包裹标签：<tool_call>{"name": …}</tool_call>（剥壳后按 JSON 解析）
//   4. Markdown 标签：**工具调用：** `x` {…}（含伪结果块，见 ./labeled-calls）
// 非调用形状的内容不误吞；cleaned 供展示净化（抠掉已识别块）。

import type { ToolCall } from "./agent";
import {
  balancedObject,
  makeCall,
  parseObjectAt,
  labeledTailStart,
  scanLabeledCalls,
  stripLabeledCalls,
} from "./labeled-calls";

export interface ParsedInline {
  calls: ToolCall[];
  /** 去掉已识别调用块后的正文（历史与展示都用净化版） */
  cleaned: string;
}

/** JSON 对象形状校验：tool|name + input|arguments|args */
function callFromJson(raw: unknown): ToolCall | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.tool === "string" ? obj.tool : typeof obj.name === "string" ? obj.name : "";
  if (!name || !("input" in obj || "arguments" in obj || "args" in obj)) return null;
  return makeCall(name, obj.input ?? obj.arguments ?? obj.args ?? {});
}

/** XML 实体解码（parameter 值里常见 &lt; &amp; 等） */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** <invoke name="x">…</invoke> 块解析已由宽松参数槽解析（callFromParams）取代 */
const LOOSE_BLOCK_RE = /<(?:invoke|function)\b[^>]*>([\s\S]*?)<\/(?:invoke|function)>/g;
/** 调用壳（单复数都收；弱模型有 <tool_calls>[…]</tool_calls> 数组方言） */
const WRAPPER_RE = /<tool_calls?(?:\s[^>]*)?>[\s\S]*?<\/tool_calls?>/g;

/** 包裹词（等号方言里挂在 = 后的不是工具名，是壳语义：<function=tool_call>） */
const WRAPPER_NAME_TOKENS = new Set(["tool_call", "tool_calls", "tool", "invoke", "function", "call"]);

/** 开标签 → 工具名：name="x" 属性优先；缺失时取裸等号方言 <function=asset.read>
 * 的 = 值（包裹词不算，仍走 name 槽语义）。 */
function blockNameOf(opening: string): string {
  const attr = /name\s*=\s*"([^"]+)"/.exec(opening)?.[1] ?? "";
  if (attr) return WRAPPER_NAME_TOKENS.has(attr.toLowerCase()) ? "" : attr;
  const bare = /=[\s"']*([A-Za-z0-9_.:\-]+)[\s"'>]/.exec(opening)?.[1] ?? "";
  return bare && !WRAPPER_NAME_TOKENS.has(bare.toLowerCase()) ? bare : "";
}

const NAME_KEYS = new Set(["name", "tool", "method", "function"]);
const ARGS_KEYS = new Set(["input", "arguments", "args"]);

/** 宽松参数解析：标准形态 <parameter name="k">v</parameter> +
 * 残缺等号形态 <parameter=k>v</parameter>（键直接挂在 = 后）。 */
function parseParamPairs(inner: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of inner.matchAll(/<parameter\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/parameter>/g)) {
    out.push([m[1], decodeEntities(m[2]).trim()]);
  }
  const rest = inner.replace(/<parameter\s+name\s*=\s*"([^"]+)"\s*>[\s\S]*?<\/parameter>/g, "");
  for (const m of rest.matchAll(/<parameter\s*=\s*"?([^">]+?)"?\s*>([\s\S]*?)<\/parameter>/g)) {
    out.push([m[1].trim(), decodeEntities(m[2]).trim()]);
  }
  return out;
}

/** 参数槽 → 调用：
 * - 块级 name 属性缺失（如 <function=tool_call> 残缺开标签）时，name 槽当工具名、
 *   input 槽当参数 JSON（残缺方言的语义）；
 * - 块级 name 属性存在时它就是工具名，一切参数槽（含恰好叫 name 的）都按逐参数
 *   入参处理（标准 invoke 语义）。 */
function callFromParams(params: Array<[string, string]>, blockName: string): ToolCall | null {
  let name = blockName.trim();
  let argsPair: [string, string] | null = null;
  const perArg: Record<string, string> = {};
  for (const [k, v] of params) {
    const key = k.trim().toLowerCase();
    if (ARGS_KEYS.has(key) && name && !argsPair) argsPair = [key, v];
    else if (NAME_KEYS.has(key) && !name) name = v;
    else perArg[key] = v;
  }
  const cleanName = name.replace(/^["']|["']$/g, "").trim();
  if (!cleanName) return null;
  if (argsPair) {
    const [slotKey, raw] = argsPair;
    try {
      const parsed: unknown = JSON.parse(raw);
      // 必须是对象才整体作为参数；标量/数组回落为 {槽名: 值}
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return makeCall(cleanName, parsed);
      }
      return makeCall(cleanName, { [slotKey]: parsed as string | number | boolean | null });
    } catch {
      return makeCall(cleanName, { [slotKey]: raw });
    }
  }
  if (Object.keys(perArg).length) return makeCall(cleanName, perArg);
  // 零参调用（如 node.list）：块级工具名有效即可发起，不再要求必须有参数槽
  return makeCall(cleanName, {});
}

/** 从回复正文解析内联工具调用。
 * 策略：先吃形状完整的（宽松 function/invoke 块、内含有效调用 JSON 的
 * tool_call 壳——壳内捞不到有效调用就不消费，留给裸扫兜底），再在"挖掉
 * 已消费区间的等长替身"上裸扫 JSON——标签残骸里嵌的 {"name":…} 也能捞出。 */
export function parseInlineToolCalls(content: string): ParsedInline {
  const calls: ToolCall[] = [];
  const ranges: Array<[number, number]> = [];

  // 1. 宽松 function/invoke 块（标准 invoke、<function=…> 裸等号/残缺标签、参数槽两种形态）
  for (const m of content.matchAll(LOOSE_BLOCK_RE)) {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    const opening = /<(?:invoke|function)\b[^>]*>/.exec(m[0])?.[0] ?? "";
    const call = callFromParams(parseParamPairs(m[1]), blockNameOf(opening));
    if (call) {
      calls.push(call);
      ranges.push([s, e]);
    }
  }

  // 2. <tool_call>/<tool_calls> 壳：壳内（含已识别的嵌套块）捞出有效调用才整壳消费
  for (const m of content.matchAll(WRAPPER_RE)) {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    const openEnd = m[0].indexOf(">") + 1;
    const inner = m[0].slice(openEnd, m[0].lastIndexOf("</"));
    const nested = ranges.some(([rs, re]) => rs >= s && re <= e);
    let found = nested;
    let pos = 0;
    while (pos < inner.length) {
      const brace = inner.indexOf("{", pos);
      if (brace < 0) break;
      const range = balancedObject(inner, brace);
      if (!range) break;
      const call = callFromJson(parseObjectAt(inner, brace));
      if (call) {
        calls.push(call);
        found = true;
      }
      pos = range[1] + 1;
    }
    if (found) ranges.push([s, e]);
  }

  // 2.5 Markdown 标签方言：**工具调用：** `name` {json} + 紧随的伪结果块
  //（弱模型把调用连同自己编的结果一起写进正文，见 ./labeled-calls）
  const labeled = scanLabeledCalls(content, false);
  calls.push(...labeled.calls);
  ranges.push(...labeled.ranges);

  // 3. 裸 JSON 扫描（等长挖替身，offset 与原文一致）
  let scanText = content;
  for (const [s, e] of ranges) {
    scanText = scanText.slice(0, s) + " ".repeat(e - s) + scanText.slice(e);
  }
  let cursor = 0;
  while (cursor < scanText.length) {
    const start = scanText.indexOf("{", cursor);
    if (start < 0) break;
    const range = balancedObject(scanText, start);
    if (!range) break;
    const call = callFromJson(parseObjectAt(scanText, start));
    if (call) {
      calls.push(call);
      ranges.push([range[0], range[1] + 1]);
    }
    cursor = range[1] + 1;
  }

  return { calls, cleaned: stripAll(content, ranges) };
}

/** 围栏吸附：调用块被 ```lang … ``` 围栏包裹且围栏内除调用外无其他内容时，
 * 把围栏一并纳入剔除区间——否则抠掉调用 JSON 后残留孤立的 ```json 围栏壳
 * （上屏与历史都会出现"空 json 块"噪音）。围栏内有散文/其他代码则不吸附，
 * 真代码块里的普通 JSON 不误吞。 */
function absorbFences(content: string, ranges: Array<[number, number]>): void {
  for (let i = 0; i < ranges.length; i++) {
    const [s, e] = ranges[i];
    const before = content.slice(0, s);
    const open = /(?:^|\n)[ \t]*```[a-zA-Z]*[ \t]*(?:\n[ \t]*)?$/.exec(before);
    if (!open) continue;
    const close = /^[ \t]*(?:\r?\n)?[ \t]*```/.exec(content.slice(e));
    if (!close) continue;
    ranges[i] = [before.length - open[0].length, e + close[0].length];
  }
}

/** 空代码围栏（```lang 开栅后直接闭栅，围栏内无内容）：围栏吸附后的漏网壳
 * 或模型直出的空围栏都是纯噪音；有内容的围栏（真代码块）绝不碰 */
const EMPTY_FENCE_RE = /```[a-zA-Z]*[ \t]*\r?\n[ \t]*\r?\n?[ \t]*```/g;

function stripRanges(text: string, ranges: Array<[number, number]>): string {
  if (!ranges.length) return text;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = "";
  let pos = 0;
  for (const [s, e] of sorted) {
    if (s < pos) continue;
    out += text.slice(pos, s);
    pos = e;
  }
  return out + text.slice(pos);
}

/** 按区间剔除调用块（先吸附包裹围栏）并清掉空围栏、收敛空行 */
function stripAll(text: string, ranges: Array<[number, number]>): string {
  absorbFences(text, ranges);
  return stripRanges(text, ranges)
    .replace(EMPTY_FENCE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 无内联调用（快捷判定，避免每轮都做扫描清理） */
export function hasInlineToolCalls(content: string): boolean {
  return parseInlineToolCalls(content).calls.length > 0;
}

/** 残骸净化（上屏出口用）：解析失败也绝不裸露调用标签块。含未闭合形态
 * （<tool_call> 壳没有闭合、<function=invoke> 缺工具名这类方言残骸）——
 * 从开标签删到文本尾；Markdown 标签方言残骸（**工具调用：** …）一并剔除。
 * 模型内部历史保留原文供自纠，这里只管用户看得见的。 */
/** 复读的工具回喂块（弱模型把 [工具 X 执行结果] + 结果体原样抄进回复）：
 * 从标记行起惰性吃到「系统代为执行」注 / 空行 / 文本尾；400 字上限防误吞
 * 标记后紧跟的正文（不满足任一终止条件时宁可不剔） */
const FEED_ECHO_RE = /\[工具 [^\]\n]{0,60} 执行结果\]\s*[\s\S]{0,400}?(?:（系统代为执行[^）]*）|(?=\n\s*\n)|$)/g;

export function stripCallTags(text: string): string {
  const out = stripLabeledCalls(text)
    .replace(/<tool_calls?(?:\s[^>]*)?>[\s\S]*?(?:<\/tool_calls?>|$)/g, "")
    .replace(/<(?:invoke|function|parameter)\b[^>]*>[\s\S]*?(?:<\/(?:invoke|function|parameter)>|$)/g, "")
    .replace(/<\/?(?:tool_calls?|invoke|function|parameter)\b[^>]*>/g, "")
    // 内联思考块（provider 没剥干净的 <think> 方言）：配对整块剔、未闭合
    // 剔到尾（流式中即思考进行中）、孤儿标签单独清
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think(?:\s[^>]*)?>[\s\S]*$/g, "")
    .replace(/<\/?think(?:\s[^>]*)?>/g, "")
    .replace(FEED_ECHO_RE, "")
    .replace(EMPTY_FENCE_RE, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** 展示用净化正文：抠掉调用块、压掉多余空行 */
export function cleanedContent(content: string): string {
  return parseInlineToolCalls(content).cleaned;
}

/** 定位文本末尾未闭合、且形似调用载荷的外层 "{"（非调用数据不隐藏） */
function unclosedCallStart(text: string): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let lastOpen = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) lastOpen = i;
      depth++;
    } else if (c === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
  if (depth === 0 || lastOpen < 0) return -1;
  return /^\{\s*"?\s*(tool|name)\s*"?\s*:/.test(text.slice(lastOpen, lastOpen + 24))
    ? lastOpen
    : -1;
}

/** 流式显示净化：完整调用块与残骸标签剔除；尾部未写完的调用载荷/调用标签
 * 不闪现（含 Markdown 标签方言的半截调用）；孤立 ```lang 开栅同样隐藏——
 * 它要么正变成围栏调用（随后整体被吸附剔除），要么是真代码块（内容一到即
 * 恢复显示）。只动显示，不动历史（历史由 cleaned 回写负责）。 */
export function streamingDisplay(text: string): string {
  const cleaned = stripCallTags(cleanedContent(text));
  const callStart = unclosedCallStart(cleaned);
  if (callStart >= 0) {
    // 载荷前紧邻的 ```lang 开栅一并隐藏（围栏调用的流式半截不闪围栏壳）
    const head = cleaned.slice(0, callStart);
    const fenceTail = /(?:^|\n)[ \t]*```[a-zA-Z]+\b[ \t]*\n?$/.exec(head);
    return (fenceTail ? head.slice(0, head.length - fenceTail[0].length) : head).trimEnd();
  }
  const tagStart = cleaned.search(/<\s*(?:tool_calls?|invoke|function|parameter)\b[^<]*$/);
  if (tagStart >= 0) return cleaned.slice(0, tagStart).trimEnd();
  const labelStart = labeledTailStart(cleaned);
  if (labelStart >= 0) return cleaned.slice(0, labelStart).trimEnd();
  const fenceStart = cleaned.search(/```[a-zA-Z]+\b[ \t]*(?:\r?\n)?[ \t]*$/);
  if (fenceStart >= 0) return cleaned.slice(0, fenceStart).trimEnd();
  return cleaned;
}
