// ---------------------------------------------------------------------------
// 安全规则 · 配置面：Tauri CSP / capabilities 权限 / .env 入库 / .gitignore /
// vite dev 服务器暴露。配置类问题多数可修（CSP 需回归 monaco/blob worker）。
// ---------------------------------------------------------------------------
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/collect.mjs";
import { makeFinding } from "../lib/finding.mjs";

const DANGEROUS_PERMS = /(shell|process|fs:allow-read|http:default|core:webview:allow)/;

export function scanSecurityConfig() {
  const out = [];
  const confPath = join(ROOT, "src-tauri", "tauri.conf.json");
  if (existsSync(confPath)) {
    let conf;
    try {
      conf = JSON.parse(readFileSync(confPath, "utf8"));
    } catch (e) {
      out.push(makeFinding({
        rule: "conf.parse", dimension: "security", category: "配置错误", severity: "critical",
        file: "src-tauri/tauri.conf.json", line: 1, snippet: e.message,
        message: "tauri.conf.json 解析失败", fix: "修复 JSON 语法",
      }));
    }
    if (conf) {
      if (conf?.app?.security?.csp == null) {
        out.push(makeFinding({
          rule: "conf.csp-null", dimension: "security", category: "配置错误", severity: "major",
          file: "src-tauri/tauri.conf.json", line: 1, snippet: '"csp": null',
          message: "CSP 为 null（未启用内容安全策略）：WebView 注入面缺最后一道兜底",
          fix: "评估收紧 CSP（需回归 monaco blob: worker 与资产协议），短期入台账并排期",
        }));
      }
    }
  }
  // capabilities 权限面
  const capDir = join(ROOT, "src-tauri", "capabilities");
  if (existsSync(capDir)) {
    for (const name of readdirSafe(capDir)) {
      const p = join(capDir, name);
      if (!name.endsWith(".json")) continue;
      const text = readFileSync(p, "utf8");
      text.split(/\r?\n/).forEach((ln, i) => {
        if (DANGEROUS_PERMS.test(ln)) {
          out.push(makeFinding({
            rule: "conf.capability-broad", dimension: "security", category: "越权/配置", severity: "major",
            file: `src-tauri/capabilities/${name}`, line: i + 1, snippet: ln,
            message: "capabilities 含宽权限项：核对是否最小化授权",
            fix: "按实际使用裁剪权限标识",
          }));
        }
      });
    }
  }
  // .env 入库检查
  const gitignore = existsSync(join(ROOT, ".gitignore")) ? readFileSync(join(ROOT, ".gitignore"), "utf8") : "";
  const envCommitted = existsSync(join(ROOT, ".env")) || existsSync(join(ROOT, ".env.local"));
  if (envCommitted && !/^\.env/m.test(gitignore)) {
    out.push(makeFinding({
      rule: "conf.env-untracked-missing", dimension: "security", category: "敏感数据泄露", severity: "high",
      file: ".gitignore", line: 1, snippet: "",
      message: "存在 .env 文件但 .gitignore 未覆盖 .env —— 凭据可能被提交",
      fix: ".gitignore 增加 .env 行并确认未入库",
    }));
  }
  // vite dev 暴露面
  const vite = join(ROOT, "vite.config.ts");
  if (existsSync(vite)) {
    const text = readFileSync(vite, "utf8");
    const m = text.match(/host\s*:\s*(true|["']0\.0\.0\.0["'])/);
    if (m) {
      const line = text.slice(0, m.index).split(/\r?\n/).length;
      out.push(makeFinding({
        rule: "conf.devserver-expose", dimension: "security", category: "配置错误", severity: "major",
        file: "vite.config.ts", line, snippet: m[0],
        message: "dev server 绑定 0.0.0.0：局域网可访问开发实例",
        fix: "默认 127.0.0.1；确需联调时临时开并注明",
      }));
    }
  }
  return out;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
