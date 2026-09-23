// 文档代码块提取：扫描 public/docs/**/*.md，收集 ```ts tve 标记块。
// 块 id 用 file:line 定位（报告可直接跳转）。普通 ```ts 块不纳管。

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 递归收集目录下全部 .md（跳过隐藏目录） */
export function listMarkdownFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...listMarkdownFiles(full));
    else if (e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

// fence：行首 ```ts tve↵ … 行首 ```（info 以空白分隔；首 token = 语言，含 tve 才纳管）。
// 行首锚定避免把行文/注释里出现的反引号文本误认成 fence。
const FENCE_RE = /^```([^\n`]*)\n([\s\S]*?)^```/gm;

/** 提取单个 md 文本的标记块；line = fence 起始行（1 基） */
export function extractBlocks(text) {
  const blocks = [];
  for (const m of text.matchAll(FENCE_RE)) {
    const info = m[1].trim().split(/\s+/);
    if (info[0] !== "ts" || !info.includes("tve")) continue;
    const line = text.slice(0, m.index).split(/\r?\n/).length;
    blocks.push({ line, code: m[2].replace(/\r\n/g, "\n") });
  }
  return blocks;
}

/** 扫描 docs 根目录 → 全部标记块（id = 相对路径:行号） */
export function extractDocBlocks(docsDir) {
  const results = [];
  for (const abs of listMarkdownFiles(docsDir)) {
    const rel = relative(docsDir, abs).split("\\").join("/");
    for (const b of extractBlocks(readFileSync(abs, "utf8"))) {
      results.push({ id: `${rel}:${b.line}`, file: rel, line: b.line, code: b.code });
    }
  }
  return results;
}
