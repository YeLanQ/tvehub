// 执行步骤行模型与合并规则：把时间线上的工具消息（调用 + 结果成对落库）
// 合并成「一次调用一行」的展示行。纯函数，AssistantChat 时间线计算用。
import type { ChatMessage } from "./conversations";
import type { ToolStepItem } from "./ToolSteps.vue";

/** 结果消息是否为失败（{error} 结构） */
export function stepHasError(content: string): boolean {
  try {
    const v = JSON.parse(content) as { error?: unknown };
    return !!(v && typeof v === "object" && "error" in v);
  } catch {
    return false;
  }
}

/** 把一条工具消息合进步骤行：调用建行，结果按 同名未决行 → 任意未决行 原位落位
 * （并行时同名调用 FIFO 配对；无配对的历史孤儿结果单独成行）。 */
export function mergeStepRow(rows: ToolStepItem[], m: ChatMessage): void {
  if (m.result) {
    const open =
      [...rows].reverse().find((r) => r.result === undefined && (!m.toolName || r.toolName === m.toolName)) ??
      [...rows].reverse().find((r) => r.result === undefined);
    if (open) {
      open.result = m.content;
      open.ok = !stepHasError(m.content);
      return;
    }
    rows.push({
      id: m.toolCallId ?? m.id,
      toolName: m.toolName ?? "?",
      args: "",
      result: m.content,
      ok: !stepHasError(m.content),
    });
    return;
  }
  rows.push({ id: m.toolCallId ?? m.id, toolName: m.toolName ?? "?", args: m.content });
}
