// 语义单元计划：大脑拆解产物（brainDecompose）→ 前端执行策略。
// 职责：拆解质量守门（可用才走单元路线，否则回落整任务）、单元指令文案、
// 逐单元小循环驱动。每单元一次独立的 agent 会话——模型每次只面对一个小任务，
// 避免整任务长线思考；跨单元衔接靠已完成单元的一句话结果摘要。
import type { BrainDecomposition, BrainKnowledgeHit, BrainTaskUnit } from "../lib/api";
import type { AssistantReply, WireMessage } from "./agent";

/** 可用判定：≥2 个单元且至少 2 个有方法预测（语义信号不足则回落整任务）。
 * 单元拆解是确定性规则（无 LLM），宁可回落也不拿垃圾计划驱动助手。 */
export function usablePlan(deco: BrainDecomposition | null | undefined): BrainTaskUnit[] | null {
  if (!deco || !Array.isArray(deco.units)) return null;
  const units = deco.units;
  if (units.length < 2 || units.length > 8) return null;
  const predicted = units.filter((u) => u.method).length;
  return predicted >= 2 ? units : null;
}

/** 截短摘要（跨单元衔接用，避免单元指令膨胀） */
function brief(text: string, limit = 120): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? line.slice(0, limit) + "…" : line;
}

const PHASE_LABEL: Record<BrainTaskUnit["phase"], string> = {
  inspect: "调研",
  act: "执行",
  verify: "验证",
};

/** 图谱知识命中 → 目录式指引：一行一条「是什么 + 怎么取」，全文由助手按需
 * load_skill / load_doc 拉取——不预载内容撑大任务上下文。 */
function knowledgeLines(hits: BrainKnowledgeHit[]): string[] {
  return hits.map((r) => {
    if (r.id.startsWith("skill:")) {
      return `- 技能「${r.label}」→ load_skill({"id": "${r.id.slice("skill:".length)}"})`;
    }
    if (r.id.startsWith("concept:doc:")) {
      return `- 官方文档「${r.label}」→ load_doc({"id": "${r.id.slice("concept:doc:".length)}"})`;
    }
    return `- 相关知识「${r.label}」`;
  });
}

const KNOWLEDGE_HEADER =
  "（系统·大脑知识命中）大脑在本任务的知识图谱中命中了以下权威资料。" +
  "涉及 API 用法/操作规范时，先读取对应资料校准再动手，不要凭记忆猜测，也不要用项目内旧示例当唯一依据。" +
  "只有在资料与当前步骤相关时才读取，无关则跳过：";

/** 单元指令：追加在原任务 wire 之后的 user 消息。只描述当前单元 + 已完成
 * 摘要；预测方法作为入口建议（模型按工具回执自纠），不禁止它用别的工具。 */
export function unitInstruction(
  unit: BrainTaskUnit,
  doneNotes: string[],
  total: number,
): string {
  const lines = [
    `（系统·语义单元 ${unit.index}/${total}）大脑已把本任务拆解为 ${total} 个单元，` +
      `你当前只负责第 ${unit.index} 个（${PHASE_LABEL[unit.phase]}）：${unit.text}`,
  ];
  if (unit.method) {
    lines.push(`预测入口工具：${unit.method}（建议首选；回执不符时按实际调整参数或改用其他工具）。`);
  }
  if (unit.refs?.length) {
    lines.push(KNOWLEDGE_HEADER, ...knowledgeLines(unit.refs));
  }
  if (doneNotes.length) {
    lines.push("已完成单元（不要重复执行）：", ...doneNotes.map((n) => `- ${n}`));
  }
  lines.push(
    "只完成当前单元：需要的工具调用直接发起，完成后用一两句话汇报本单元结果；" +
      "不要执行其他单元的步骤，也不要输出过渡宣言。",
  );
  return lines.join("\n");
}

/** 单元循环依赖：runOnce = 一次独立 agent 会话（注入单元消息后跑工具循环）；
 * onUnitStart/onUnitDone 供过程容器与对话流上屏。 */
export interface UnitRunDeps {
  runOnce: (extra: WireMessage[]) => Promise<AssistantReply>;
  onUnitStart: (index: number) => void;
  onUnitDone: (index: number, note: string) => void;
  shouldStop: () => boolean;
}

/** 单元循环结果：reply 为最后一单元的汇报（停止中断时为停止文案） */
export interface UnitPlanResult {
  reply: AssistantReply;
  /** shouldStop 中断（未跑完全部单元） */
  stopped: boolean;
  /** 完成的单元数 */
  completed: number;
}

/** 逐单元推进：每单元一次独立会话；停止或全部完成即返回。
 * 单元成败不在此判定——回执如实进摘要，下一单元的模型自行判断衔接。 */
export async function runUnitPlan(
  units: BrainTaskUnit[],
  deps: UnitRunDeps,
): Promise<UnitPlanResult> {
  const total = units.length;
  const doneNotes: string[] = [];
  let last: AssistantReply = { content: "", toolCalls: [] };
  for (const unit of units) {
    if (deps.shouldStop()) {
      return {
        reply: { content: `已按要求停止（完成 ${doneNotes.length}/${total} 个单元）。`, toolCalls: [] },
        stopped: true,
        completed: doneNotes.length,
      };
    }
    deps.onUnitStart(unit.index);
    last = await deps.runOnce([{ role: "user", content: unitInstruction(unit, doneNotes, total) }]);
    const note = `${brief(unit.text)} → ${brief(last.content)}`;
    doneNotes.push(note);
    deps.onUnitDone(unit.index, last.content);
  }
  return { reply: last, stopped: false, completed: total };
}

/** 落库：拆解结果的 JSON 摘要（历史静态 Nlu 块渲染用） */
export function decomposeDigest(deco: BrainDecomposition): string {
  return JSON.stringify({
    units: deco.units,
    traces: deco.traces,
  });
}

/** 直通路线的知识注入：整任务粒度的图谱命中 → wire 追加消息（不落库）。
 * 空命中返回空串（不加消息）。 */
export function knowledgeNote(deco: BrainDecomposition): string {
  if (!deco.refs?.length) return "";
  return [KNOWLEDGE_HEADER, ...knowledgeLines(deco.refs)].join("\n");
}

/** 历史消息 → 拆解结果（只认本模块落库的 JSON 形态；其余返回 null） */
export function parseStoredDecomposition(content: string): BrainDecomposition | null {
  if (!content.startsWith("{")) return null;
  try {
    const v = JSON.parse(content) as { units?: unknown; traces?: unknown };
    if (!Array.isArray(v.units) || !Array.isArray(v.traces)) return null;
    return { task: "", units: v.units as BrainTaskUnit[], traces: v.traces as BrainDecomposition["traces"], refs: [] };
  } catch {
    return null;
  }
}
