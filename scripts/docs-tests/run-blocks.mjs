// 块执行：文档块转译为 ES2020 ESM → "tve" 重定向到运行时编译产物 → Node import。
// 断言改写：`expr; // => 期望` → `__docExpect(expr, "期望", "块id:行号")`。
// 产物策略：public/engine/core/tve.mjs 存在且不旧于 src/runtime 源 → 直接用；
// 否则 buildRuntime() 全量再生（幂等）。

import ts from "typescript";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildRuntime } from "../build-runtime.mjs";
import { resetFailures, drainFailures } from "./expect.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNTIME_SRC = join(ROOT, "src", "runtime");
const TVE_MJS = join(ROOT, "public", "engine", "core", "tve.mjs");
const THREE_MJS = join(ROOT, "public", "engine", "core", "three.module.min.js");
const RUN_DIR = join(ROOT, ".tmp", "docs-tests", "run");
const EXPECT_REL = relative(RUN_DIR, join(ROOT, "scripts", "docs-tests", "expect.mjs"))
  .split("\\")
  .join("/");

// 断言行形式：表达式语句 + 行尾 // => 期望（transformBlock 内逐行匹配）

function latestMtime(dir) {
  let latest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) latest = Math.max(latest, latestMtime(full));
    else if (e.name.endsWith(".ts")) latest = Math.max(latest, statSync(full).mtimeMs);
  }
  return latest;
}

/** tve 产物可用性：存在 + three 副本存在 + 不旧于源（陈旧产物会测出假绿） */
async function ensureTveArtifact() {
  const fresh =
    existsSync(TVE_MJS) && existsSync(THREE_MJS) && statSync(TVE_MJS).mtimeMs >= latestMtime(RUNTIME_SRC);
  if (fresh) return;
  console.log("[docs-tests] 运行时产物缺失/陈旧，重建 public/engine ……");
  await buildRuntime("docs-tests");
  // buildRuntime 幂等：内容一致时不落盘（mtime 不动，下次仍判陈旧）→
  // 主动 touch 标记"本机已按当前源重建过"。engine 为 gitignore 产物目录，
  // dev 启动自身也会全量重建，touch 不引入额外失真。
  if (existsSync(TVE_MJS)) utimesSync(TVE_MJS, new Date(), new Date());
}

function toPosixImport(fromDir, target) {
  let rel = relative(fromDir, target).split("\\").join("/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

/** 块源码 → 可执行模块文本：断言行改写（tag = 块id:块内行号）+ tve 重定向 + 转译 */
export function transformBlock(code, id) {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  const out = lines.map((ln, i) => {
    const m = ln.match(/^[ \t]*(.+?);[ \t]*\/\/[ \t]*=>[ \t]*(.+)$/);
    if (!m) return ln;
    const indent = ln.slice(0, ln.length - ln.trimStart().length);
    return `${indent}__docExpect((${m[1]}), ${JSON.stringify(m[2])}, ${JSON.stringify(`${id}:${i + 1}`)});`;
  });
  let src = out.join("\n");
  const tveSpec = toPosixImport(RUN_DIR, TVE_MJS);
  src = src
    .replace(/(from\s*)["']tve["']/g, `$1"${tveSpec}"`)
    .replace(/(import\s*\(\s*)["']tve["']/g, `$1"${tveSpec}"`);
  const header = `import { __docExpect } from "${EXPECT_REL}";\n`;
  return ts.transpileModule(header + src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      experimentalDecorators: true,
    },
  }).outputText;
}

/**
 * 执行全部块（串行；console.log 静音避免 engine.log 刷屏）。
 * @returns {Array<{id: string, errors: string[]}>}
 */
export async function runBlocks(blocks) {
  await ensureTveArtifact();
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });

  const results = [];
  const realLog = console.log;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const file = join(RUN_DIR, `block-${String(i).padStart(4, "0")}.mjs`);
    writeFileSync(file, transformBlock(b.code, b.id), "utf8");
    resetFailures();
    const errors = [...drainFailures()];
    console.log = () => {};
    try {
      await import(pathToFileURL(file).href);
    } catch (e) {
      errors.push(String(e?.stack ?? e).split("\n").slice(0, 4).join("\n  "));
    } finally {
      console.log = realLog;
    }
    errors.push(...drainFailures());
    if (errors.length) results.push({ id: b.id, errors });
  }
  return results;
}
