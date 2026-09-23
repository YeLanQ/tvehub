// ---------------------------------------------------------------------------
// 助手会话时间线（纯函数，便于单测）：消息流 → 渲染块序列（msg/steps/nlu）。
// 从 AssistantChat 拆出，大脑块的生命周期规则在此收敛——
// - 历史静态块：brain.decompose 调用/结果对 → 解析 digest 还原过程容器，
//   多次任务的块按序累积（与执行过程容器同等保留在会话里）；
// - 运行动态块：当前任务的 nluRun（带 callId）追加在末尾实时驱动；只隐藏
//   当前任务自己的静态消息对（callId 匹配）防同屏重复，先前任务的块不受影响。
// ---------------------------------------------------------------------------

import { parseStoredDecomposition } from "./nlu";
import { mergeStepRow } from "./steps";
import type { ChatMessage } from "./conversations";
import type { RunNlu } from "./runs";
import type { ToolStepItem } from "./ToolSteps.vue";
import type { NluBlockData } from "./NluSteps.vue";
import type { BrainDecomposition } from "../lib/api";

export type Block =
  | { kind: "msg"; key: string; m: ChatMessage }
  | { kind: "steps"; key: string; rows: ToolStepItem[] }
  | { kind: "nlu"; key: string; data: NluBlockData };

/** BrainDecomposition → 过程容器数据（历史静态与运行动态共用） */
export function toNluData(deco: BrainDecomposition): NluBlockData {
  return {
    traces: [...deco.traces],
    units: deco.units.map((u) => ({
      index: u.index,
      text: u.text,
      method: u.method,
      zone: u.zone,
      phase: u.phase,
      refs: u.refs ?? [],
      status: "pending" as const,
    })),
  };
}

export function buildTimeline(messages: ChatMessage[], runNlu: RunNlu | null): Block[] {
  const out: Block[] = [];
  for (const m of messages) {
    if (m.role === "tool" && m.toolName === "brain.decompose") {
      // 当前任务的大脑块由末尾动态块代展（防同屏重复）；先前任务的静态块照常保留
      if (runNlu && m.toolCallId && m.toolCallId === runNlu.callId) continue;
      if (m.result) {
        const deco = parseStoredDecomposition(m.content);
        if (deco) {
          const data = toNluData(deco);
          const open = [...out].reverse().find((b) => b.kind === "nlu");
          if (open && open.kind === "nlu" && !open.data.units.length) {
            open.data = data; // 填充未决的调用占位块
          } else {
            out.push({ kind: "nlu", key: `nlu_r_${m.id}`, data });
          }
        }
        continue;
      }
      out.push({ kind: "nlu", key: `nlu_c_${m.toolCallId ?? m.id}`, data: { traces: [], units: [] } });
      continue;
    }
    const last = out[out.length - 1];
    if (m.role === "tool") {
      if (last && last.kind === "steps") {
        mergeStepRow(last.rows, m);
      } else {
        const rows: ToolStepItem[] = [];
        mergeStepRow(rows, m);
        out.push({ kind: "steps", key: `steps_${m.id}`, rows });
      }
    } else {
      out.push({ kind: "msg", key: m.id, m });
    }
  }
  if (runNlu) out.push({ kind: "nlu", key: "__nlu_run", data: runNlu });
  return out;
}
