// 命令入参窄化帮手：命令的 args 来自多个入口（UI/快捷键/devtools/MCP），实际是
// 任意 JSON。各命令按需收窄成强类型，通用守卫集中在此，避免每个命令文件重复同款防御代码。

/** 未知值 → 对象记录（null/数组/原始值返回 undefined） */
export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** 未知值 → 字符串数组（数组逐项 String 化；非数组返回空数组） */
export function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

/** 未知值 → 三态布尔（true/"true" → true；false/"false" → false；其余 undefined）。
 *  助手工具 schema 的参数统一按 string 下发，弱模型惯以 "true" 字符串传布尔；
 *  命令侧宽松收窄，避免 `"true" === true` 静默失真成缺省值。 */
export function asBool(v: unknown): boolean | undefined {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return undefined;
}

/** 未知值 → 字符串数组，兼容单字符串（中英文逗号分隔）与非数组其他形态（返回空数组） */
export function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") {
    return v
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}
