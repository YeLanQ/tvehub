// 块级类型检查：每个标记块写为临时 .ts，模块说明符 "tve" 经 paths 映射到
// src/framework/scripting/tve.d.ts（类型契约唯一事实源），批量 createProgram
// 取语义诊断。strict 口径与根 tsconfig 对齐，保证示例在严格模式下也成立。

import ts from "typescript";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TVE_DTS = join(ROOT, "src", "framework", "scripting", "tve.d.ts");
const WORKDIR = join(ROOT, ".tmp", "docs-tests", "typecheck");

function compilerOptions() {
  return {
    target: ts.ScriptTarget.ES2020,
    // 不指定 lib：随 target 取默认全集（es5..ES2020 + DOM）——用户脚本运行在
    // 浏览器，Math/Date/console 等全局与 Array 基础类型都应可用；显式给
    // ["ES2020","DOM"] 会缺 es5 基础库，接口成员类型连锁解析失败。
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    experimentalDecorators: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    // 文档块是模块片段（含 import/export），不做零引用检查
    noUnusedLocals: false,
    noUnusedParameters: false,
    paths: { tve: [TVE_DTS.split("\\").join("/")] },
    baseUrl: ROOT,
  };
}

/**
 * 类型检查全部块。
 * @param {Array<{id: string, code: string}>} blocks
 * @returns {Array<{id: string, errors: string[]}>} 仅返回有错误的块
 */
export function typeCheckBlocks(blocks) {
  rmSync(WORKDIR, { recursive: true, force: true });
  mkdirSync(WORKDIR, { recursive: true });

  const files = [];
  blocks.forEach((b, i) => {
    // 文件名带序号保序；id 里的 ":" 换成 "_" 避免盘符歧义
    const name = `block-${String(i).padStart(4, "0")}.ts`;
    const abs = join(WORKDIR, name);
    writeFileSync(abs, b.code, "utf8");
    files.push({ block: b, abs });
  });

  const program = ts.createProgram(
    [TVE_DTS, ...files.map((f) => f.abs)],
    compilerOptions(),
  );

// 诊断按文件归属：TS 的 fileName 是正斜杠、块文件 abs 是反斜杠（Windows），
// 且大小写不敏感——两侧统一规范化（正斜杠 + 小写）后再做键。
const normKey = (p) => p.split("\\").join("/").toLowerCase();

  const diagByFile = new Map();
  for (const d of program.getSemanticDiagnostics()) {
    if (!d.file) continue;
    const key = normKey(d.file.fileName);
    const list = diagByFile.get(key) ?? [];
    list.push(d);
    diagByFile.set(key, list);
  }

  return files
    .map(({ block, abs }) => {
      const errors = (diagByFile.get(normKey(abs)) ?? []).map((d) => {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
        const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
        return `  块内 ${line + 1}:${character + 1} — TS${d.code}: ${msg}`;
      });
      return { id: block.id, errors };
    })
    .filter((r) => r.errors.length > 0);
}
