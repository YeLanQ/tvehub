// 通用工具调用语法引擎（非标记壳）：不走成对标记结构的两种已知方言——
// Llama 系 <|python_tag|> 后跟调用 JSON、Mistral 系 [TOOL_CALLS] 后跟调用
// 数组。结构标记方言的识别在 ./tool-dialects。
import type { ToolCall } from "./agent";
import { callFromLooseJson } from "./labeled-calls";
import type { ParsedDialect } from "./tool-dialects";

/** 配平 JSON 值扫描（对象或数组；字符串感知），返回 [start, end]（含 end） */
function balancedValue(text: string, start: number): [number, number] | null {
  const close = text[start] === "{" ? "}" : text[start] === "[" ? "]" : "";
  if (!close) return null;
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
    else if (c === text[start]) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return [start, i];
    }
  }
  return null;
}

/** 已知非标记壳扫描：<|python_tag|>{"name":…} 与 [TOOL_CALLS] [{…}, …]
 * （数组可含多个调用）；非调用形状的值不消费 */
export function scanExoticShells(text: string): ParsedDialect {
  const calls: ToolCall[] = [];
  const ranges: Array<[number, number]> = [];
  for (const m of text.matchAll(/<\|python_tag\|>|\[TOOL_CALLS\]/gi)) {
    let at = (m.index ?? 0) + m[0].length;
    while (at < text.length && /\s/.test(text[at])) at++;
    const range = balancedValue(text, at);
    if (!range) continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text.slice(range[0], range[1] + 1)) as unknown;
    } catch {
      parsed = null; // 非 JSON 载荷：按无壳处理
    }
    const had = calls.length;
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const call = callFromLooseJson(item);
      if (call) calls.push(call);
    }
    if (calls.length > had) ranges.push([(m.index ?? 0), range[1] + 1]);
  }
  return { calls, ranges };
}
