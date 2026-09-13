// ---------------------------------------------------------------------------
// 类型自动导入的纯逻辑核心（不依赖 Monaco，可被冒烟测试直接驱动）：
// - tveAutoImportEdits / scriptTypeImportEdits：把「补全项被接受」翻译为最小
//   文本编辑——优先合并进既有 import 语句（tve 命名导入 / 脚本 type-only 命名
//   导入），没有则在前导注释（文件头说明块）之后插入一条新 import；
// - collectImportedNames / localDeclaredNames：建议去重（已导入 / 本地已声明的
//   名字不再建议）；基于正则扫描（名字集合用途，容忍注释/字符串误报）；
// - insideImportClause / looksLikeCodeContext：粗粒度上下文判定，跳过 import
//   子句内部、注释与字符串字面量中的误建议；
// - relativeSpecifier：脚本 A 引用脚本 B 的相对导入说明符（去扩展名，./ 前缀）。
// 编辑适配（把 TextOp 转成 Monaco additionalTextEdits）在同目录 auto-import.ts。
// ---------------------------------------------------------------------------

/** 最小文本编辑（文档偏移量坐标；start === end 表示纯插入） */
export interface TextOp {
  start: number;
  end: number;
  text: string;
}

/** 文件头前导区（空白行 + 行注释 + 块注释）结束、第一行业务代码的起始偏移。
 *  新 import 插在该偏移（前导说明注释保持在文件最上方，与 VS Code 行为一致）。 */
export function prologEndOffset(source: string): number {
  const lines = source.split("\n");
  let offset = 0;
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      offset += raw.length + 1;
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line === "" || line.startsWith("//")) {
      offset += raw.length + 1;
      continue;
    }
    if (line.startsWith("/*")) {
      // 单行内闭合的块注释不算前导区结尾，但也不再向后找
      if (!line.includes("*/")) inBlock = true;
      offset += raw.length + 1;
      continue;
    }
    break;
  }
  return Math.min(offset, source.length);
}

/** 找既有 `import { … } from "tve"`（单双引号均可）并返回 { 花括号内容, 花括号后偏移 } */
function findTveNamedImport(
  source: string,
): { inner: string; insertAt: number } | null {
  const re = /import\s*\{([^}]*)\}\s*from\s*(['"])tve\2/;
  const m = re.exec(source);
  if (!m) return null;
  const braceAt = m.index + m[0].indexOf("{");
  return { inner: m[1], insertAt: braceAt + 1 };
}

/** 接受 tve 导出名的补全 → import 编辑（合并进既有 tve import，或新插一行） */
export function tveAutoImportEdits(source: string, name: string): TextOp[] {
  const existing = findTveNamedImport(source);
  if (existing) {
    if (new RegExp(`\\b${escapeRe(name)}\\b`).test(existing.inner)) return [];
    const text = mergeNamedInsert(existing.inner, name);
    return [{ start: existing.insertAt, end: existing.insertAt, text }];
  }
  const at = prologEndOffset(source);
  return [{ start: at, end: at, text: `import { ${name} } from "tve";\n` }];
}

/** 在既有命名导入的花括号内插入 name 的文本：
 *  空导出 {} → ` name `；多行 import → 插为独立首行（沿用两格缩进）；
 *  单行 `{ X }` → ` name,`（保持两侧空格）；紧凑写法 `{X}` → `name, `。
 *  四种形态均保持语法成立且贴近 prettier 习惯 */
function mergeNamedInsert(inner: string, name: string): string {
  if (inner.trim() === "") return ` ${name} `;
  if (/^\s*\n/.test(inner)) return `\n  ${name},`;
  if (/^\s/.test(inner)) return ` ${name},`;
  return `${name}, `;
}

/** 脚本间引用一律 type-only（编译期擦除，运行时脚本类全局可见，不产生模块依赖）。
 *  isDefault = 目标脚本的 default 导出（`import type X from "./x"`）；
 *  否则命名导入（`import type { X } from "./x"`），同说明符既有 type import 则合并。 */
export function scriptTypeImportEdits(
  source: string,
  name: string,
  specifier: string,
  isDefault: boolean,
): TextOp[] {
  if (isDefault) {
    const re = new RegExp(
      `import\\s+type\\s+\\w+\\s+from\\s*(['"])${escapeRe(specifier)}\\1`,
    );
    if (re.test(source)) return [];
    const at = prologEndOffset(source);
    return [{ start: at, end: at, text: `import type ${name} from "${specifier}";\n` }];
  }
  const re = new RegExp(
    `import\\s+type\\s*\\{([^}]*)\\}\\s*from\\s*(['"])${escapeRe(specifier)}\\2`,
  );
  const m = re.exec(source);
  if (m) {
    if (new RegExp(`\\b${escapeRe(name)}\\b`).test(m[1])) return [];
    const braceAt = m.index + m[0].indexOf("{");
    const at = braceAt + 1;
    return [{ start: at, end: at, text: mergeNamedInsert(m[1], name) }];
  }
  const at = prologEndOffset(source);
  return [{ start: at, end: at, text: `import type { ${name} } from "${specifier}";\n` }];
}

/** 当前文件已通过 import 引入的名字集合（含 import type；默认导出本地名也计入） */
export function collectImportedNames(source: string): Set<string> {
  const names = new Set<string>();
  // 默认导入：import X from / import type X from / import X, { … } from
  const reDefault = /\bimport\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from\b)/g;
  for (const m of source.matchAll(reDefault)) names.add(m[1]);
  // 命名导入（含复合形式 import Default, { A as B }）：取 as 右侧别名（A as B → B；
  // default as B → B）
  const reBraces = /\bimport\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}/g;
  for (const m of source.matchAll(reBraces)) {
    for (const el of m[1].split(",")) {
      const item = el.trim();
      if (!item) continue;
      const asRe = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(item);
      names.add(asRe ? asRe[1] : item);
    }
  }
  return names;
}

/** 本文件已声明的顶层/任意位置名字（class/interface/… 声明；建议去重用） */
export function localDeclaredNames(source: string): Set<string> {
  const names = new Set<string>();
  const re =
    /\b(?:abstract\s+)?(?:class|interface|enum|type|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of source.matchAll(re)) names.add(m[1]);
  return names;
}

/** 光标是否处于某条 import 语句子句内部（`import {` 之后尚未出现 from/;） */
export function insideImportClause(textBefore: string): boolean {
  const lastImport = textBefore.lastIndexOf("import");
  if (lastImport < 0) return false;
  const tail = textBefore.slice(lastImport);
  if (/\bfrom\b/.test(tail)) return false;
  if (tail.includes(";")) return false;
  return true;
}

/** 光标上下文是否适合给标识符建议（排除注释行 / 单行字符串 / 模板串） */
export function looksLikeCodeContext(source: string, offset: number, lineTextBefore: string): boolean {
  const trimmed = lineTextBefore.trimStart();
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  ) {
    return false;
  }
  for (const q of ['"', "'"]) {
    let count = 0;
    for (let i = 0; i < lineTextBefore.length; i++) {
      if (lineTextBefore[i] === "\\") {
        i += 1;
        continue;
      }
      if (lineTextBefore[i] === q) count += 1;
    }
    if (count % 2 === 1) return false;
  }
  let backticks = 0;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 96) backticks += 1;
  }
  return backticks % 2 === 0;
}

/** 脚本 A（fromRel）引用脚本 B（toRel）的相对导入说明符（去扩展名、./ 前缀） */
export function relativeSpecifier(fromRel: string, toRel: string): string {
  const dir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
  const fromParts = dir ? dir.split("/") : [];
  const toParts = toRel.replace(/\.tsx?$/, "").split("/");
  const file = toParts.pop() as string;
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common += 1;
  }
  const ups = fromParts.length - common;
  const prefix = ups === 0 ? ["."] : Array<string>(ups).fill("..");
  return [...prefix, ...toParts.slice(common), file].join("/");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
