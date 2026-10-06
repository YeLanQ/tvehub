// 通用工具调用语法引擎（参数值装配）：参数体到调用参数的值语义与调用形状
// 校验。结构识别在 ./tool-dialects，非标记壳在 ./tool-dialect-shells，痕迹
// 与出口净化在 ./tool-dialect-sanitize。
import type { ToolCall } from "./agent";
import { makeCall } from "./labeled-calls";

/** 名字槽 / 整体参数槽键名（parameters 是 Llama/Mistral 系方言的参数槽名） */
const NAME_KEYS = new Set(["name", "tool", "method", "function"]);
const WHOLE_KEYS = new Set(["input", "arguments", "args", "parameters"]);

/** 参数体 → 值：string="false" 声明 JSON（解析失败即残缺）；DSML 给标量参数
 * 也套同名对象壳（{"id": "…"} 挂在 name="id" 上）——单键同名时解一层；
 * 无声明时仅 input/arguments/args/parameters 槽的花括号形态尝试 JSON，其余
 * 一律纯文本（正文代码片段不误吞） */
export function convertValue(body: string, strFlag: string, key: string): { v: unknown; broken: boolean } {
  if (strFlag === "true") return { v: body, broken: false };
  if (strFlag === "false") {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const keys = Object.keys(obj);
        if (keys.length === 1 && keys[0] === key) return { v: obj[keys[0]], broken: false };
      }
      return { v: parsed, broken: false };
    } catch {
      return { v: body, broken: true };
    }
  }
  if (WHOLE_KEYS.has(key.toLowerCase()) && /^[[{]/.test(body)) {
    try {
      return { v: JSON.parse(body) as unknown, broken: false };
    } catch {
      return { v: body, broken: false }; // 解析失败按纯文本：可能是正文 JSON 片段
    }
  }
  return { v: body, broken: false };
}

/** 参数槽 → 调用：块级 name 属性缺失时 name 槽顶工具名；input/arguments/
 * args/parameters 槽的对象整体作参数，其余逐参数合并（键保留原大小写） */
export function assembleCall(nameAttr: string, params: Array<[string, unknown]>): ToolCall | null {
  let name = nameAttr.trim();
  let whole: unknown = null;
  const per: Record<string, unknown> = {};
  for (const [k, v] of params) {
    if (!k) continue;
    const lower = k.toLowerCase();
    if (!name && NAME_KEYS.has(lower) && typeof v === "string") {
      name = v;
      continue;
    }
    if (WHOLE_KEYS.has(lower) && v && typeof v === "object" && !Array.isArray(v) && !whole) {
      whole = v;
      continue;
    }
    per[k] = v;
  }
  name = name.replace(/^["']|["']$/g, "").trim();
  if (!name) return null;
  return makeCall(name, whole ?? per);
}
