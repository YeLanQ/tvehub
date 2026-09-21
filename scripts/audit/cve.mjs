// ---------------------------------------------------------------------------
// 依赖 CVE 扫描：pnpm audit（显式走 registry.npmjs.org —— 本机默认 npmmirror
// 镜像无 audit 端点）。prod 依赖的 critical/high 破防线；dev 依赖降一级只报。
// Rust 侧 cargo-audit 本机工具链不可用（镜像 404），如实声明"未覆盖"，
// Cargo.lock 依赖面以 cargo test --lib + 发版人工核对兜底。
// ---------------------------------------------------------------------------
import { spawnSync } from "node:child_process";
import { makeFinding } from "./lib/finding.mjs";

const REGISTRY = "https://registry.npmjs.org";

export function scanCve() {
  const out = [];
  let ran = false;
  try {
    const r = spawnSync("pnpm", ["audit", "--json", `--registry=${REGISTRY}`], {
      encoding: "utf8",
      timeout: 120_000,
      shell: true,
      cwd: process.cwd(),
    });
    if (r.status === 0 || (r.stdout && r.stdout.trim().startsWith("{"))) {
      ran = true;
      const body = JSON.parse(r.stdout);
      const advisories = body?.advisories ?? {};
      const prodDeps = collectProdDepNames(); // null = 解析失败，全部按 prod 从严
      for (const adv of Object.values(advisories)) {
        const isProd = !prodDeps || prodDeps.has(adv.module_name);
        const sev = String(adv.severity).toLowerCase();
        if (!["critical", "high", "moderate", "low"].includes(sev)) continue;
        out.push(makeFinding({
          rule: `cve.${sev}`, dimension: "dependency", category: "依赖 CVE",
          severity: sev === "critical" || sev === "high" ? (isProd ? "high" : "major") : "minor",
          file: "package.json", line: 1,
          snippet: `${adv.module_name}@${adv.findings?.[0]?.version ?? "?"} ${adv.title}`,
          message: `${adv.module_name}（${isProd ? "生产依赖" : "开发依赖"}）存在 ${sev} 级公告：${adv.title} [${adv.url}]`,
          fix: `升级到已修复版本（pnpm update ${adv.module_name}）或评估缓解；dev 依赖不参与分发可入台账`,
        }));
      }
    } else {
      return { findings: out, ran: false, error: `pnpm audit 退出码 ${r.status}：${(r.stderr || "").slice(0, 160)}` };
    }
  } catch (e) {
    return { findings: out, ran: false, error: e.message };
  }
  return { findings: out, ran, error: null };
}

/** prod 依赖名集合（audit 分级用；解析失败按 prod 从严处理） */
function collectProdDepNames() {
  try {
    const pkg = JSON.parse(spawnSync("node", ["-e", "console.log(JSON.stringify(require('./package.json').dependencies))"], { encoding: "utf8", shell: true }).stdout);
    return new Set(Object.keys(pkg ?? {}));
  } catch {
    return null;
  }
}
