// ---------------------------------------------------------------------------
// 安全规则 · 硬编码密钥扫描（覆盖源码/脚本/配置/.env*）。
// 具名平台前缀（AKIA/sk-/ghp_/xox/AIza/私钥块）→ blocker（一票否决）；
// 通用赋值模式（password/token/secret = 字面量）→ high；占位符白名单放行。
// ---------------------------------------------------------------------------
import { makeFinding } from "../lib/finding.mjs";

/** 具名平台密钥形态（命中即 blocker，不做白名单——真密钥不该出现在任何文件） */
const NAMED = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, name: "私钥文件内容" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, name: "AWS AccessKey" },
  { re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/, name: "OpenAI 风格 Key" },
  { re: /\bghp_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/, name: "GitHub Token" },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, name: "Slack Token" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, name: "Google API Key" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, name: "JWT 字面量" },
];

/** 通用密钥名赋值（password/secret/token/api_key 等 = 非空字面量） */
const GENERIC = /(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["'`]([^"'`\s]{12,})["'`]/i;

/** 占位符/示例值白名单（值本体已保证 ≥12 字符，这里只判形态） */
function isPlaceholder(v) {
  return (
    /^(x{3,}|0+|test\w*|dummy\w*|fake\w*|example\w*|sample\w*|placeholder\w*|changeme|your[-_\w]*|<[^>]*>|\$\{.*\}|\{\{.*\}\}|[A-Za-z_-]*key-here)$/i.test(v) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) // UUID 常量（存储键名等）
  );
}

export function scanSecrets(files) {
  const out = [];
  for (const f of files) {
    if (!["ts", "vue", "runtime", "rs", "script", "config", "env"].includes(f.kind)) continue;
    const isEnv = f.kind === "env";
    f.lines.forEach((ln, i) => {
      if (!isEnv && /^\s*(\/\/|\/\*|\*|#|<!--|--)/.test(ln)) return;
      for (const n of NAMED) {
        if (n.re.test(ln)) {
          out.push(makeFinding({
            rule: "secret.named", dimension: "security", category: "硬编码密钥",
            severity: "blocker", file: f.rel, line: i + 1, snippet: ln.slice(0, 120),
            message: `疑似 ${n.name} 硬编码`,
            fix: "立即从代码移除并轮换该密钥；密钥放运行时配置/环境变量",
          }));
          return;
        }
      }
      const g = ln.match(GENERIC);
      if (g && !isPlaceholder(g[1])) {
        out.push(makeFinding({
          rule: "secret.generic", dimension: "security", category: "硬编码密钥",
          severity: isEnv ? "blocker" : "high", file: f.rel, line: i + 1, snippet: ln.slice(0, 120),
          message: `密钥类字段被赋字面量值（${g[1].slice(0, 4)}***）`,
          fix: "改环境变量/系统凭据库；示例值请写成显式占位符（your-key-here 等）",
        }));
      }
    });
  }
  return out;
}
