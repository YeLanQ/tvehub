// 文档代码块测试入口：pnpm docs:test
// 编排：提取 public/docs 标记块 → 类型检查 → 真实执行 → 汇总报告。
// 全部通过退出码 0；任一失败非 0（CI-ready 语义，已挂 ci:local docs 步）。

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractDocBlocks } from "./extract-blocks.mjs";
import { typeCheckBlocks } from "./type-check.mjs";
import { runBlocks } from "./run-blocks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS_DIR = join(ROOT, "public", "docs");

const blocks = extractDocBlocks(DOCS_DIR);
if (blocks.length === 0) {
  console.error("[docs-tests] public/docs 下没有 ```ts tve 标记块——标记语法见 scripts/docs-tests/README.md");
  process.exit(1);
}
console.log(`[docs-tests] 提取到 ${blocks.length} 个标记块（public/docs）`);

const failures = [];

const t0 = Date.now();
const typeErrors = typeCheckBlocks(blocks);
for (const { id, errors } of typeErrors) failures.push({ stage: "类型检查", id, errors });
console.log(
  `[docs-tests] 类型检查：${blocks.length - typeErrors.length}/${blocks.length} 通过` +
    `（${((Date.now() - t0) / 1000).toFixed(1)}s）`,
);

const runErrors = await runBlocks(blocks);
for (const { id, errors } of runErrors) failures.push({ stage: "执行", id, errors });
console.log(`[docs-tests] 真实执行：${blocks.length - runErrors.length}/${blocks.length} 通过`);

if (failures.length) {
  console.error(`\n✗ 文档代码块测试失败（${failures.length} 个块）：`);
  for (const f of failures) {
    console.error(`\n[${f.stage}] ${f.id}`);
    for (const e of f.errors) console.error(`  ${e}`);
  }
  process.exit(1);
}
console.log(`\n✔ 文档代码块测试全部通过（${blocks.length} 块）`);
