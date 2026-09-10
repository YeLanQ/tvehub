// ---------------------------------------------------------------------------
// 创意工坊资源仓库（public/repos）：分类 = 仓库子目录，文件 = 分类目录下的独立文件。
// - 分类标签名 = 目录名首字母大写（自动匹配，新增 public/repos/<目录> 即出现同名标签）；
// - 原型分类（见 PROTOTYPE_EXTS）：文件可增删改，新增文件按该分类的扩展名落盘
//   （code → .ts 脚本原型；effect → .shader 效果原型）；
// - 非原型分类：只读浏览，内容直接维护目录；
// - 文件描述写在首部注释 "// @desc: 描述"（可选），分类扫描只回元信息；
//   文本文件内容按需读取（二进制文件不读取，避免把字节当文本）。
// ---------------------------------------------------------------------------

import { api, type RepoFileEntry } from "../../lib/api";

/** 文本扩展名（与后端 repos.rs 的 TEXT_EXTS 同规则；其它按二进制处理） */
const TEXT_EXTS = new Set([
  "ts",
  "js",
  "mjs",
  "cjs",
  "tsx",
  "json",
  "md",
  "txt",
  "shader",
  "glsl",
  "hlsl",
  "cg",
  "css",
  "scss",
  "html",
  "xml",
  "yml",
  "yaml",
]);

/**
 * 可增删改原型的分类 → 新文件扩展名（首页工坊「添加原型」落盘用）。
 * 不在表中的分类只读浏览；需要新分类可写时在此加一行即可。
 */
const PROTOTYPE_EXTS: Record<string, string> = {
  code: "ts",
  effect: "shader",
};

/** 已知分类的一句话说明（未知分类给出通用说明） */
const CATEGORY_HINTS: Record<string, string> = {
  code: "脚本原型：资产面板「新建脚本」时按此处的模板创建脚本",
  effect: "效果原型：自定义着色器（复制到项目 assets/shaders/ 后挂到材质上）",
};

/** 仓库文件（含按需读取的文本内容） */
export interface RepoFile extends RepoFileEntry {
  /** 文本内容（二进制文件或读取失败为空串） */
  code: string;
  /** 是否文本文件（决定是否展示内容预览） */
  text: boolean;
}

/** 仓库分类（含文件清单） */
export interface RepoCategory {
  /** 分类 id（= 目录名，如 "code"） */
  id: string;
  /** 分类目录绝对路径 */
  dir: string;
  /** 展示名（= 目录名首字母大写，自动匹配） */
  label: string;
  /** 一句话说明（内容栏副标题） */
  hint: string;
  /** 新原型文件的扩展名（null = 该分类只读浏览，不支持在工坊里增删改） */
  prototypeExt: string | null;
  files: RepoFile[];
}

/** 是否文本文件（二进制不读取内容） */
export function isTextRepoFile(ext: string): boolean {
  return TEXT_EXTS.has(ext.toLowerCase());
}

/** 分类的原型扩展名（null = 只读分类） */
export function repoPrototypeExt(id: string): string | null {
  return PROTOTYPE_EXTS[id] ?? null;
}

/** 分类说明（内容栏副标题；未知分类给通用说明） */
export function repoCategoryHint(id: string): string {
  return CATEGORY_HINTS[id] ?? "仓库分类：直接维护 public/repos 下对应目录的内容";
}

/** 目录名 → 标签名：首字母大写（目录名其余字符原样；中文等无大小写字符不受影响） */
function repoLabel(id: string): string {
  return id.length > 0 ? id[0].toUpperCase() + id.slice(1) : id;
}

/** 最近一次分类扫描结果（模块级缓存：分区重挂载时先出内容再后台刷新，避免闪一下「读取中」） */
let cachedCategories: RepoCategory[] | null = null;

/** 缓存的分类清单（未扫描过返回 null） */
export function cachedRepoCategories(): RepoCategory[] | null {
  return cachedCategories;
}

/** 扫描仓库全部分类（元信息；文件内容按需 loadRepoCategoryTexts） */
export async function listRepoCategories(): Promise<RepoCategory[]> {
  const cats = await api.listRepoCategories().catch(() => []);
  const mapped = cats.map((c) => ({
    id: c.id,
    dir: c.dir,
    // 标签名 = 子目录名首字母大写（不维护映射表，目录即分类）
    label: repoLabel(c.id),
    hint: repoCategoryHint(c.id),
    prototypeExt: repoPrototypeExt(c.id),
    files: c.files.map((f) => toRepoFile(f)),
  }));
  cachedCategories = mapped;
  return mapped;
}

function toRepoFile(f: RepoFileEntry, code = ""): RepoFile {
  return { ...f, code, text: isTextRepoFile(f.ext) };
}

/** 读取分类内全部文本文件内容（二进制跳过；读取失败留空） */
export async function loadRepoCategoryTexts(category: RepoCategory): Promise<RepoCategory> {
  const files = await Promise.all(
    category.files.map(async (f) => {
      if (!f.text) return f;
      const code = await api.readRepoFile(category.id, f.file).catch(() => "");
      return { ...f, code };
    }),
  );
  return { ...category, files };
}

/** 读取单个文件内容（编辑表单按需加载用） */
export async function readRepoFile(category: string, file: string): Promise<string> {
  return api.readRepoFile(category, file).catch(() => "");
}

/** 写入仓库文件（file 含扩展名；描述以首部 // @desc: 注释保存，旧描述行自动剥离防重复堆积） */
export async function writeRepoFile(
  category: string,
  file: string,
  description: string,
  code: string,
): Promise<void> {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && /^\s*\/\/\s*@desc[:：]/.test(lines[0])) lines.shift();
  const head = description.trim() ? `// @desc: ${description.trim()}\n` : "";
  await api.writeRepoFile(category, file, head + lines.join("\n"));
}

/** 删除仓库文件（file 含扩展名） */
export async function deleteRepoFile(category: string, file: string): Promise<void> {
  await api.deleteRepoFile(category, file);
}

/** 文件字节数展示（B/KB/MB；未知大小回退空串） */
export function formatRepoSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
