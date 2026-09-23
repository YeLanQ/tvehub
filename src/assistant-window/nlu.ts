// 语义单元计划：大脑拆解产物（brainDecompose）→ 前端执行策略。
// 模糊原子单元合并为**一次助手会话**：单元计划作为路线图注入，模型在单个
// 工具循环内按序推进（自动续跑机制保证不中途停摆）——比逐单元独立会话少
// N-1 次全量上下文往返，这是通信速度的关键。纯直执行任务零 LLM 完成。
import type { BrainDecomposition, BrainKnowledgeHit, BrainTaskUnit } from "../lib/api";

const KNOWLEDGE_HEADER =
  "（系统·大脑知识命中）大脑在本任务的知识图谱中命中了以下权威资料。" +
  "涉及 API 用法/操作规范时，先读取对应资料校准再动手，不要凭记忆猜测，也不要用项目内旧示例当唯一依据。" +
  "只有在资料与当前步骤相关时才读取，无关则跳过：";

/** 图谱知识命中 → 目录式指引：一行一条「是什么 + 怎么取」，全文由助手按需
 * load_skill / load_doc / load_repo 拉取——不预载内容撑大任务上下文。 */
function knowledgeLines(hits: BrainKnowledgeHit[]): string[] {
  return hits.map((r) => {
    if (r.id.startsWith("skill:")) {
      return `- 技能「${r.label}」→ load_skill({"id": "${r.id.slice("skill:".length)}"})`;
    }
    if (r.id.startsWith("concept:doc:")) {
      return `- 官方文档「${r.label}」→ load_doc({"id": "${r.id.slice("concept:doc:".length)}"})`;
    }
    if (r.id.startsWith("concept:repos:")) {
      return `- 工坊资源「${r.label}」→ load_repo({"id": "${r.id.slice("concept:repos:".length)}"})`;
    }
    return `- 相关知识「${r.label}」`;
  });
}

/** 直通路线的知识注入：整任务粒度的图谱命中 → wire 追加消息（不落库）。
 * 空命中返回空串（不加消息）。 */
export function knowledgeNote(deco: BrainDecomposition): string {
  if (!deco.refs?.length) return "";
  return [KNOWLEDGE_HEADER, ...knowledgeLines(deco.refs)].join("\n");
}

/** 执行计划注入：模糊原子单元合并为一次会话时的推进路线图。
 * 每单元一行（目标 + 建议工具 + 建议参数 + 知识参考），模型按序转换为
 * 精准命令执行；无依赖的单元并行。 */
export function planNote(units: BrainTaskUnit[]): string {
  const lines = units.map((u) => {
    const parts = [`- 单元 ${u.index}（建议工具：${u.method ?? "自行选择"}）：${u.text}`];
    if (u.params && Object.keys(u.params).length) {
      parts.push(`建议参数（大脑提取，校验后使用）：${JSON.stringify(u.params)}`);
    }
    if (u.refs?.length) {
      parts.push(`知识参考：${u.refs.map((r) => r.label).join("、")}`);
    }
    return parts.join("\n");
  });
  return [
    `（系统·执行计划）大脑已把任务拆解为 ${units.length} 个单元任务，请按顺序推进：`,
    ...lines,
    "",
    "把每个单元转换为精准的工具调用后执行（无依赖的调用放同一轮并行）；" +
      "全部完成后输出以「任务完成」开头的总结；某个单元无法完成时说明原因并继续其余单元。",
  ].join("\n");
}

/** 落库：拆解结果的 JSON 摘要（历史静态 Nlu 块渲染用） */
export function decomposeDigest(deco: BrainDecomposition): string {
  return JSON.stringify({
    units: deco.units,
    traces: deco.traces,
  });
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
