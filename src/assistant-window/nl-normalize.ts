// 语言归一化前置层：自然语言 →（助手 LLM 单轮结构化）→ 大脑可检索的任务
// spec。大脑的规则 NLU（分段/词典/字面特征）对口语化表述经常抓不准锚点；
// 本层让助手先"翻译"一次：规范化任务表述 + 提取检索锚点 + 判断任务类型
// （命令操作/创作/优化/解析/闲聊）+ 提取提及的项目文件。文件只对工作区
// 清单做存在性校验，绝不读取内容。任何失败（无供应商/超时/输出不合法）
// 都返回 null——大脑按原始文本走既有规则链路，本层对下游透明。

import { api } from "../lib/api";
import type { ChatFn, WireMessage } from "./agent";
import { createTauriTransport } from "./transport";

export type NormTaskType = "operate" | "create" | "optimize" | "analyze" | "chat";

/** brain_decompose 的 spec 入参（与 Rust nlu::NormSpec 的 camelCase 对应） */
export interface NormSpec {
  taskType: NormTaskType;
  /** 规范化后的任务表述（大脑分段/检索/单元文本的输入） */
  task: string;
  /** 检索锚点（方法名/API 名/对象词，中英混合） */
  keywords: string[];
  /** 提及且确认存在于工作区的文件（相对路径；只校验存在性） */
  files: string[];
}

const TASK_TYPES: readonly NormTaskType[] = ["operate", "create", "optimize", "analyze", "chat"];
const TYPE_FALLBACK: NormTaskType = "operate";
const KEYWORDS_MAX = 8;
const FILES_MAX = 8;
const TASK_MAX_CHARS = 160;
const PATH_MAX_CHARS = 200;
/** 归一化超时：前置层不值得久等，超时即回落规则链路 */
const TIMEOUT_MS = 20_000;

export function normalizePrompt(): string {
  return [
    "你是 TvE Hub 助手的「语言归一化」前置层：把用户的自然语言翻译成下游大脑（规则 NLU + 知识图谱检索）能准确处理的结构化任务。",
    "只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码围栏。字段：",
    '- taskType：任务类型，五选一——"operate"（命令操作：对项目/场景/节点/资产执行具体操作）、"create"（指令创作：创作新内容，如写脚本/着色器/文件）、"optimize"（指令优化：修改/优化已有内容或文件）、"analyze"（指令解析：解释/分析/问答，不要求改动）、"chat"（闲聊对话）',
    "- task：规范化后的任务描述——保留对象名/参数值/文件名等实体，消除口语歧义与错别字，一句话（≤120 字）",
    '- keywords：3~8 个检索锚点（方法名/API 名/对象词，中英混合，如 "tween"、"node.add"、"旋转"）',
    '- files：任务提到的项目文件相对路径（按表述推断，如 "src/TweenMotion.ts"）；没有就空数组。只列路径，绝不读取文件内容',
    '示例：输入「帮我写个让方块慢慢转的脚本」→ {"taskType":"create","task":"编写脚本组件：使立方体绕 Y 轴缓慢旋转","keywords":["脚本","Component","onUpdate","旋转","node.add"],"files":[]}',
  ].join("\n");
}

/** 相对路径归一：反斜杠统一、去引导 ./ 与 /（存在性匹配用） */
export function normalizeRelPath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

/** 从模型输出提取并校验 spec（宽松：容忍围栏与前后缀杂文本）；不合法返回 null */
export function parseNormalizedTask(raw: string): NormSpec | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const task = typeof o.task === "string" ? o.task.trim().slice(0, TASK_MAX_CHARS) : "";
  const keywords = Array.isArray(o.keywords)
    ? o.keywords
        .filter((k): k is string => typeof k === "string" && !!k.trim())
        .map((k) => k.trim().slice(0, 40))
        .slice(0, KEYWORDS_MAX)
    : [];
  const files = Array.isArray(o.files)
    ? o.files
        .filter((f): f is string => typeof f === "string" && !!f.trim())
        .map((f) => normalizeRelPath(f).slice(0, PATH_MAX_CHARS))
        .filter(Boolean)
        .slice(0, FILES_MAX)
    : [];
  if (!task && !keywords.length && !files.length) return null;
  const taskType = TASK_TYPES.includes(o.taskType as NormTaskType)
    ? (o.taskType as NormTaskType)
    : TYPE_FALLBACK;
  return { taskType, task, keywords, files };
}

/** 文件存在性校验：只对工作区清单成员判定（不读文件内容）；路径归一 +
 * 大小写不敏感（Windows）；重复路径去重。 */
export function filterExistingFiles(
  files: string[],
  listing: string[],
): { files: string[]; dropped: number } {
  const set = new Set(listing.map((p) => normalizeRelPath(p).toLowerCase()));
  const kept: string[] = [];
  for (const f of files) {
    const norm = normalizeRelPath(f);
    if (norm && set.has(norm.toLowerCase()) && !kept.some((k) => k.toLowerCase() === norm.toLowerCase())) {
      kept.push(norm);
    }
  }
  return { files: kept, dropped: files.length - kept.length };
}

export interface NormalizeOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

/** 单轮 LLM 归一化。绝不抛出：任何失败（无供应商/超时/格式坏）返回 null。
 * 独立传输实例——请求 id 不接入「停止」按钮，超时/失败后 aiCancel 收割
 * 孤儿流，不占供应商并发。 */
export async function normalizeNaturalLanguage(
  text: string,
  opts: NormalizeOpts,
): Promise<NormSpec | null> {
  if (!opts.baseUrl.trim() || !opts.model.trim()) return null;
  const reqIds = new Set<string>();
  const chat: ChatFn = createTauriTransport((id) => reqIds.add(id));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      chat({
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        model: opts.model,
        messages: [
          { role: "system", content: normalizePrompt() },
          { role: "user", content: text },
        ] satisfies WireMessage[],
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("语言归一化超时")), opts.timeoutMs ?? TIMEOUT_MS);
      }),
    ]);
    return parseNormalizedTask(reply.content);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    for (const id of reqIds) void api.aiCancel(id).catch(() => {});
  }
}
