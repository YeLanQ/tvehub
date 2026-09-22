// Markdown 标签方言的工具调用：弱模型不支持 function-calling 时，常把调用写成
// 「**工具调用：** `load_skill` {"id":"…"}` 甚至紧跟伪造的「**结果：** {…}」。
// 旧解析器（JSON / invoke / tool_call 壳）不认这种形态，循环只能空转救援——
// 本模块把标签块抠成 ToolCall 交 runAgent 真正执行，伪结果块一并剔除（模型把
// 自己编的结果当真、历史被复读污染）；另提供痕迹检测（坏格式纠偏判据）、
// 尾部检测（流式渲染不闪现半截调用）与净化出口（救援耗尽后残骸不上屏）。

import type { ToolCall } from "./agent";

export interface ParsedLabeled {
  calls: ToolCall[];
  /** 已消费区间 [start, end)：调用块 + 紧随的伪结果块，供正文剥离 */
  ranges: Array<[number, number]>;
}

let seq = 0;

/** 生成内联调用 id（JSON / invoke / 标签三种内联形态共用一套前缀语义） */
export function makeCall(name: string, args: unknown): ToolCall | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 64) return null;
  let argsJson: string;
  try {
    argsJson = typeof args === "string" ? args : JSON.stringify(args ?? {});
  } catch {
    return null;
  }
  seq += 1;
  return { id: `inline_${Date.now().toString(36)}_${seq}`, name: trimmed, arguments: argsJson || "{}" };
}

/** 标签头：行首（可带列表符 / 加粗 / 括号包裹）+ 标签词，冒号或闭合括号收尾
 *（【工具调用】无名氏方言不带冒号；名字 + 参数花括号仍是后续硬判据） */
const LABEL_RE_SRC =
  "(?:^|[\\r\\n])[ \\t]*(?:[-*•][ \\t]*)?(?:\\*\\*|__|\\[|【)?[ \\t]*" +
  "(?:工具调用|调用工具|发起调用|工具请求|tool[_ ]?call|function[_ ]?call)" +
  "(?:[ \\t]*(?:\\*\\*|__))?\\s*(?:[:：]\\s*|[\\]】)]\\s*)";

/** 名字 / 花括号两侧允许的装饰字符（反引号、加粗、括号、标点） */
const DECO = new Set([
  " ", "\t", "`", "'", '"', "*", "_", "~",
  "(", ")", "（", "）", "[", "]", "【", "】",
  ":", "：", ",", "，", "-", "—", "·",
]);
const TRAIL_DECO = new Set([" ", "\t", "`", "'", '"', "*", "_", "~"]);

/** 伪结果标签（跟在调用块后面才算；单独出现不消费） */
const RESULT_LABEL_RE =
  /[\s]{0,8}(?:\*\*|__|\[|【)?[ \t]*(?:执行结果|调用结果|运行结果|返回结果|结果|输出|result|output)[ \t]*(?:\*\*|__|\]|\)|】)?[ \t]*[:：]?[ \t]*/iy;

/** 字符串感知的花括号配平扫描：返回 [start, end]（含 end）或 null */
export function balancedObject(text: string, start: number): [number, number] | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return [start, i];
    }
  }
  return null;
}

/** 在文本 start 起取第一个配平 JSON 对象并解析（失败返回 null） */
export function parseObjectAt(text: string, start: number): unknown {
  const range = balancedObject(text, start);
  if (!range) return null;
  try {
    return JSON.parse(text.slice(range[0], range[1] + 1));
  } catch {
    return null;
  }
}

/** 从 from 起读工具名（跳过装饰字符；名字 [A-Za-z0-9._-]+） */
function readName(text: string, from: number): { name: string; end: number } | null {
  let i = from;
  while (i < text.length && DECO.has(text[i])) i++;
  const m = /^[A-Za-z0-9._\-]+/.exec(text.slice(i, i + 80));
  if (!m) return null;
  return { name: m[0], end: i + m[0].length };
}

/** 名字之后的参数对象起始 `{`（中间只许装饰字符），无则 -1 */
function argsBraceAt(text: string, from: number): number {
  let i = from;
  while (i < text.length && DECO.has(text[i])) i++;
  return text[i] === "{" ? i : -1;
}

function lineEnd(text: string, from: number): number {
  const nl = text.indexOf("\n", from);
  return nl < 0 ? text.length : nl;
}

/** 区间末尾吃掉装饰尾巴（闭合反引号等） */
function trailEnd(text: string, end: number): number {
  let e = end;
  while (e < text.length && TRAIL_DECO.has(text[e])) e++;
  return e;
}

/** 剔除紧随调用的伪结果块：有标签且配平 JSON 才消费（prose 结果不动）；
 * lenient 下残缺也按行剔除。返回新的区间末尾。 */
function stripFakeResult(text: string, from: number, lenient: boolean): number {
  RESULT_LABEL_RE.lastIndex = from;
  const m = RESULT_LABEL_RE.exec(text);
  if (!m) return from;
  const brace = argsBraceAt(text, m.index + m[0].length);
  // 残缺按行剔除要从匹配末尾找行尾——匹配自身吃掉的前导换行不算
  if (brace < 0) return lenient ? lineEnd(text, m.index + m[0].length) : from;
  const range = balancedObject(text, brace);
  if (!range) return lenient ? lineEnd(text, m.index + m[0].length) : from;
  return trailEnd(text, range[1] + 1);
}

/** 扫描正文里的标签调用。
 * strict（解析执行）：必须名字 + 配平 JSON 参数才算调用，否则不消费；
 * lenient（出口净化）：残缺调用按行剔除，防止坏格式残骸上屏。 */
export function scanLabeledCalls(text: string, lenient: boolean): ParsedLabeled {
  const calls: ToolCall[] = [];
  const ranges: Array<[number, number]> = [];
  const re = new RegExp(LABEL_RE_SRC, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const labelStart = /[\r\n]/.test(m[0][0]) ? m.index + 1 : m.index;
    if (ranges.some(([s, e]) => labelStart >= s && labelStart < e)) continue;
    const nameInfo = readName(text, re.lastIndex);
    if (!nameInfo) continue;
    let end = -1;
    const brace = argsBraceAt(text, nameInfo.end);
    if (brace >= 0) {
      const range = balancedObject(text, brace);
      if (range) {
        const parsed = parseObjectAt(text, brace);
        if (parsed !== null) {
          const call = makeCall(nameInfo.name, parsed);
          if (call) calls.push(call);
        }
        end = trailEnd(text, range[1] + 1);
      }
    }
    if (end < 0) {
      if (!lenient) continue;
      end = lineEnd(text, nameInfo.end);
    }
    end = stripFakeResult(text, end, lenient);
    ranges.push([labelStart, end]);
    re.lastIndex = Math.max(end, re.lastIndex);
  }
  return { calls, ranges };
}

/** 正文里是否有「标签 + 名字 + 参数花括号」的调用痕迹（坏格式纠偏判据：
 * 完整形态已被解析执行，能走到这里说明格式坏了解析不了） */
export function hasLabeledCallTrace(text: string): boolean {
  const re = new RegExp(LABEL_RE_SRC, "gi");
  while (re.exec(text) !== null) {
    const nameInfo = readName(text, re.lastIndex);
    if (nameInfo && argsBraceAt(text, nameInfo.end) >= 0) return true;
  }
  return false;
}

/** 流式尾部：最后一个标签块是没写完的调用（参数 `{` 未配平，或名字刚流出
 * 还没到参数）→ 返回标签起点供截断；完整块（已由解析器消费）或纯叙述 → -1 */
export function labeledTailStart(text: string): number {
  const re = new RegExp(LABEL_RE_SRC, "gi");
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) last = m;
  if (!last) return -1;
  // exec 失败会把全局正则的 lastIndex 归零——尾部位置必须从 last 匹配算
  const nameInfo = readName(text, last.index + last[0].length);
  if (!nameInfo) return -1;
  const displayStart = /[\r\n]/.test(last[0][0]) ? last.index + 1 : last.index;
  const brace = argsBraceAt(text, nameInfo.end);
  if (brace >= 0) return balancedObject(text, brace) !== null ? -1 : displayStart;
  let i = nameInfo.end;
  while (i < text.length && DECO.has(text[i])) i++;
  return i >= text.length ? displayStart : -1;
}

/** 出口净化：剥离标签调用残骸（含伪结果行），供最终上屏文本兜底 */
export function stripLabeledCalls(text: string): string {
  const { ranges } = scanLabeledCalls(text, true);
  if (!ranges.length) return text;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = "";
  let pos = 0;
  for (const [s, e] of sorted) {
    if (s < pos) continue;
    out += text.slice(pos, s);
    pos = e;
  }
  return (out + text.slice(pos)).replace(/\n{3,}/g, "\n\n").trim();
}
