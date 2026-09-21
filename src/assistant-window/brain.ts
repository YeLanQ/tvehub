// 助手大脑桥：brain.* 工具目录、直连执行器与观测上报。
// brain.* 不走 devtools 内部桥（大脑是进程内 Rust 状态，非编辑器命令），
// 也不入观测——观测本身是它喂给大脑的数据，避免自指循环。

import { api, type BrainPlan, type BrainRouteHit, type BrainStatsReport } from "../lib/api";

/** 工具目录条目（tools.ts 与 brain.ts 共用；由 specToTool 统一转 OpenAI 格式） */
export interface ToolSpec {
  method: string;
  description: string;
  params?: Record<string, string>;
  required?: string[];
}

/** 大脑工具目录（与编辑器 CATALOG 结构一致，由 tools.ts 合并导出） */
export const BRAIN_CATALOG: ToolSpec[] = [
  {
    method: "brain.plan",
    description:
      "向大脑要执行策略（多步/写操作任务前必调）：返回匹配技能、推荐步骤（含区域与效能比）与门控决策。" +
      "autoExecute=按 steps 顺序自主执行；needConfirm=把 steps 摘要给用户征得同意后再执行；deny=拒绝并说明原因。",
    params: { task: "任务的一句话描述" },
    required: ["task"],
  },
  {
    method: "brain.query",
    description: "知识图谱语义检索：返回与文本最相关的技能/命令/概念节点（找能力、找接口时用）。",
    params: { text: "查询文本", topK: "返回条数（缺省 5）" },
    required: ["text"],
  },
  {
    method: "brain.stats",
    description: "读取大脑状态：节点分布、向量压缩率、各命令正确率/平均耗时/效能比、决策计数。",
  },
];

export type BrainToolResult = BrainPlan | BrainRouteHit[] | BrainStatsReport | { error: string };

/** 执行一个 brain.* 调用（调用方保证 name 以 brain. 开头） */
export async function execBrainTool(
  name: string,
  params: Record<string, unknown>,
  fallbackTask = "",
): Promise<BrainToolResult> {
  if (name === "brain.plan") {
    return await api.brainPlan(String(params.task ?? fallbackTask ?? ""));
  }
  if (name === "brain.query") {
    const topK = params.topK != null ? Number(params.topK) : undefined;
    return await api.brainQuery(String(params.text ?? ""), topK);
  }
  if (name === "brain.stats") {
    return await api.brainStats();
  }
  return { error: `未知大脑方法: ${name}` };
}

/** 观测上报（fire-and-forget）：成败按 { error } 结构判定，大脑侧进化因果链 */
export function observeExecution(
  method: string,
  started: number,
  result: unknown,
  task: string,
): void {
  api
    .brainObserve({ task, method, ok: !(result && typeof result === "object" && "error" in result), ms: Math.round(performance.now() - started) })
    .catch(() => {
      // 观测失败不影响工具调用主链路
    });
}
