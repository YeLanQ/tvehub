// ---------------------------------------------------------------------------
// 统一扫描 · 文件收集与语言分类（scripts/audit 的公共底座）。
//
// 扫描面：前端 src/**（ts/vue）、后端 src-tauri/src/**（rs）、工程配置
// （tauri.conf.json / vite.config.ts / .env* / capabilities）。产物目录
// （dist/coverage/public/engine 构建产物）、生成代码（generated）、第三方
// （node_modules）不进扫描面。规范见 scripts/audit/scan.mjs 头注。
// ---------------------------------------------------------------------------
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** 相对仓库根的 POSIX 风格路径（报告与台账统一用这个格式，可点检） */
export function toRel(abs) {
  return relative(ROOT, abs).split(sep).join("/");
}

const IGNORE_DIRS = new Set([
  "node_modules", "dist", "coverage", "reports", ".git", "target",
  ".tmp-smoke", "public", "docs", "extra", ".zcode", ".agents", ".vscode",
]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") && name !== ".env" && !name.startsWith(".env.")) {
      if (name !== ".gitignore") continue;
    }
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!IGNORE_DIRS.has(name)) yield* walk(full);
    } else yield full;
  }
}

/** 单文件语言分类；返回 null 表示不进扫描面 */
export function classify(abs) {
  const rel = toRel(abs);
  if (rel.startsWith("src-tauri/target/") || rel.includes("/generated/")) return null;
  if (/\.spec\.ts$/.test(rel)) return null; // 测试文件不进质量/安全规则面
  if (/\.d\.ts$/.test(rel)) return null;
  if (rel.startsWith("src/runtime/")) return "runtime"; // 播放运行时（独立口径，仅安全规则）
  if (rel.startsWith("src/")) return rel.endsWith(".vue") ? "vue" : rel.endsWith(".ts") ? "ts" : null;
  if (rel.startsWith("src-tauri/src/")) return rel.endsWith(".rs") ? "rs" : null;
  if (rel.startsWith("scripts/")) return /\.(mjs|cjs|ts)$/.test(rel) ? "script" : null;
  if (/(^|\/)(tauri\.conf\.json|vite\.config\.ts|vitest\.config\.ts|package\.json)$/.test(rel)) return "config";
  if (/^\.env/.test(rel.split("/").pop() ?? "")) return "env";
  if (rel.startsWith("src-tauri/capabilities/")) return "config";
  return null;
}

/**
 * 收集全部待扫描文件：[{ rel, abs, kind, text, lines }]
 * kind ∈ ts | vue | runtime | rs | script | config | env
 */
export function collectAll() {
  const out = [];
  for (const abs of walk(ROOT)) {
    const kind = classify(abs);
    if (!kind) continue;
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    out.push({ rel: toRel(abs), abs, kind, text, lines: text.split(/\r?\n/) });
  }
  return out;
}

/** vue 文件只取 <script> 段（模板交给安全规则单独看 v-html 等） */
export function vueScriptOf(file) {
  const m = file.text.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  return m ? m[1] : "";
}

/** 排除 Rust #[cfg(test)] 模块后的正文（测试代码不进质量规则） */
export function rsNonTestOf(file) {
  let out = [];
  let skipping = false;
  let depth = 0;
  for (const ln of file.lines) {
    if (!skipping && /#\[\s*cfg\s*\(\s*test\s*\)\s*\]/.test(ln)) {
      skipping = true;
      out.push(""); // 保行号对齐
      continue;
    }
    if (skipping) {
      depth += (ln.match(/\{/g) || []).length - (ln.match(/\}/g) || []).length;
      out.push("");
      if (depth <= 0) skipping = false;
      continue;
    }
    out.push(ln);
  }
  return out;
}

export { existsSync };
