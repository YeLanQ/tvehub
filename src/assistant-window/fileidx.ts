// ---------------------------------------------------------------------------
// 大文件索引注入：@ 引用的大文本文件不整包进 LLM 上下文——发送时让大脑决策
// 中心建模块索引（file.index），只注入"文件摘要 + 模块目录"，模型按需用
// file.search 按语义模糊匹配检索相关段落。纯函数集中本模块（无 Vue/Tauri
// 依赖），可被单测直接覆盖。
// ---------------------------------------------------------------------------

export interface FileIndexBriefModule {
  title: string;
  summary: string;
  lineStart: number;
  lineEnd: number;
}

/** brain.fileidx file.index 的回执（camelCase 对齐 Rust 序列化） */
export interface FileIndexBrief {
  path: string;
  summary: string;
  moduleCount: number;
  modules: FileIndexBriefModule[];
}

/** 超过该字符数的 @ 引用文件转索引模式（小文件保持整包注入不变） */
export const LARGE_FILE_CHARS = 12_000;
/** 模块目录注入条数上限（后端 brief 同口径截断，此处双保险） */
const TOC_MAX = 40;

/** 大文件判定：读取端截断标记或超阈值字符数 */
export function isLargeFile(content: string, truncated?: boolean): boolean {
  return truncated === true || content.length > LARGE_FILE_CHARS;
}

/** asset.read 因"超 512KB 拒读"失败时转索引模式（索引侧上限 2MB） */
export function isOversizeError(error: string): boolean {
  return error.includes("512KB");
}

/**
 * @ 引用文件是否应转索引模式：读取成功看大小/截断标记；读取失败只认超限
 * 错误（文件不存在等其他错误应原样注入失败说明，不转索引）。
 */
export function shouldIndexInstead(
  content: string | undefined,
  truncated: boolean | undefined,
  readError?: string,
): boolean {
  if (readError != null) return isOversizeError(readError);
  return isLargeFile(content ?? "", truncated);
}

/** 注入块：文件摘要 + 模块目录（[L起-止] 行号）+ file.search 使用指令 */
export function buildFileTocBlock(path: string, brief: FileIndexBrief): string {
  const head =
    `\n\n--- 文件：${path}（较大，已建模块索引：共 ${brief.moduleCount} 个模块；摘要：${brief.summary}） ---\n` +
    "模块目录（[L起-止] 为行号）：";
  const listed = brief.modules.slice(0, TOC_MAX);
  const lines = listed.map(
    (m, i) => `${i + 1}. [L${m.lineStart}-${m.lineEnd}] ${m.title}：${m.summary}`,
  );
  if (brief.modules.length > listed.length) {
    lines.push(`…另有 ${brief.modules.length - listed.length} 个模块未列出`);
  }
  const tail =
    `（大文件未整包注入。需要哪段内容就调 file.search 工具：{"path":"${path}","query":"关键词"}，` +
    "按语义模糊匹配返回相关段落与行号；文件有改动时可用 file.index 刷新目录。）\n--- 结束 ---";
  return [head, ...lines, tail].join("\n");
}
