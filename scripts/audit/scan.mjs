// ---------------------------------------------------------------------------
// 统一质量与安全扫描 · 主入口（本地预检 / CI / CD / 上线后复扫共用同一口径）。
//
// 用法：
//   node scripts/audit/scan.mjs                        全量扫描 + 门禁（默认）
//   node scripts/audit/scan.mjs --no-cve               离线环境跳过依赖 CVE
//   node scripts/audit/scan.mjs --require-coverage     发版/复扫：覆盖率必须已结算
//   node scripts/audit/scan.mjs --archive              归档到 reports/<日期>/audit/
//   node scripts/audit/scan.mjs --accept <token> --reason "…"   设计内项入台账
//
// 产物：reports/audit/audit-report.{md,json}（本次）+ last.json（差分基线）
//       + ledger.json（评审台账，闭环跟踪）。
// 退出码：门禁通过 0；破防线 1（CI-ready）。
// 接入：ci:local 的 audit 步（提交前）→ pnpm build（CD 门）→ rescan.mjs（上线后）。
// ---------------------------------------------------------------------------
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, collectAll } from "./lib/collect.mjs";
import { addAcceptance, applyLedger, diffLast, evaluateGate, loadLedger } from "./lib/finding.mjs";
import { renderMarkdown, renderSummaryLine } from "./lib/report.mjs";
import { scanSecrets } from "./rules/secrets.mjs";
import { scanSecurityWeb } from "./rules/security-web.mjs";
import { scanSecurityRust } from "./rules/security-rust.mjs";
import { scanSecurityConfig } from "./rules/security-config.mjs";
import { scanQualityCode } from "./rules/quality-code.mjs";
import { scanNaming } from "./rules/quality-naming.mjs";
import { scanDuplication } from "./rules/quality-dup.mjs";
import { scanCve } from "./cve.mjs";
import { settleCoverage } from "./coverage.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);

// 台账接受模式（不扫描）
if (has("--accept")) {
  addAcceptance(val("--accept") ?? "", val("--reason") ?? "");
  process.exit(0);
}

const t0 = Date.now();
console.log("[audit] 收集扫描面 …");
const files = collectAll();
const cveResult = has("--no-cve") ? { findings: [], ran: false, error: null } : scanCve();
const cov = settleCoverage();

const packs = [
  ["密钥", scanSecrets(files)],
  ["安全·Web", scanSecurityWeb(files)],
  ["安全·Rust", scanSecurityRust(files)],
  ["安全·配置", scanSecurityConfig()],
  ["质量·代码", scanQualityCode(files)],
  ["质量·命名", scanNaming(files)],
  ["质量·重复", scanDuplication(files)],
];
for (const [name, found] of packs) console.log(`[audit] ${name.padEnd(8)} ${found.length} 项`);
if (cveResult.ran) console.log(`[audit] 依赖CVE  ${cveResult.findings.length} 项`);

const all = [...packs.flatMap(([, f]) => f), ...cveResult.findings, ...(cov.findings ?? [])];
const ledger = loadLedger();
const open = applyLedger(all, ledger);
const accepted = all.filter((f) => f.accepted);

const requireCoverage = has("--require-coverage");
const gate = evaluateGate(open, {
  requireCoverage,
  coverageSettled: cov.settled && !cov.stale,
  // CVE 扫描失败只在发版/复扫模式破防（本地断网不阻塞日常构建，如实记未覆盖）
  cveError: cveResult.error && requireCoverage && !has("--no-cve") ? cveResult.error : null,
});

const diff = diffLast(open);
const meta = {
  time: new Date().toISOString(), seconds: ((Date.now() - t0) / 1000).toFixed(1),
  mode: requireCoverage ? "发版/复扫（覆盖率必须结算）" : "本地预检",
  files: files.length, tsFiles: files.filter((f) => ["ts", "vue", "runtime"].includes(f.kind)).length,
  rsFiles: files.filter((f) => f.kind === "rs").length,
  otherFiles: files.filter((f) => ["config", "env", "script"].includes(f.kind)).length,
};

const notCovered = [
  "Rust 测试覆盖率（tarpaulin Windows 不可用）：以 cargo test --lib 全绿 + 发版人工核对兜底",
  ...(cov.stale ? [`前端覆盖率报告已过期（>24h）：本地预检放行，发版前须 pnpm test:coverage 重结算`] : []),
  ...(cveResult.error ? [`依赖 CVE 扫描未完成：${cveResult.error}`] : []),
  ...(has("--no-cve") ? ["依赖 CVE 扫描被 --no-cve 跳过"] : []),
  "Rust 依赖 CVE（cargo-audit 不可用）：Cargo.lock 共 10 个直接依赖，升级时人工核对 advisories",
];

const md = renderMarkdown({ meta, findings: open, accepted, gate, coverage: { ...cov, require: requireCoverage }, notCovered, diff });
const outDir = join(ROOT, "reports", "audit");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "audit-report.md"), md, "utf8");
writeFileSync(join(outDir, "audit-report.json"), JSON.stringify({ meta, gate: { pass: gate.pass }, findings: open, accepted, notCovered }, null, 2), "utf8");
writeFileSync(join(outDir, "last.json"), JSON.stringify(open.map((f) => ({ token: f.token, rule: f.rule, file: f.file, line: f.line, severity: f.severity })), null, 2), "utf8");
if (has("--archive")) {
  const day = new Date().toISOString().slice(0, 10);
  const dest = join(ROOT, "reports", day, "audit");
  mkdirSync(dest, { recursive: true });
  cpSync(join(outDir, "audit-report.md"), join(dest, "audit-report.md"));
  cpSync(join(outDir, "audit-report.json"), join(dest, "audit-report.json"));
  console.log(`[audit] 已归档 reports/${day}/audit/`);
}

console.log(`\n[audit] 未接受发现：${renderSummaryLine(open, gate)}（另台账接受 ${accepted.length} 项）`);
console.log(`[audit] 报告：reports/audit/audit-report.md`);
if (gate.pass) {
  console.log("[audit] 门禁：✅ 通过");
  process.exit(0);
}
console.error("[audit] 门禁：❌ 未通过 —— 破防线目：");
for (const b of gate.breaches) console.error(`  - ${b}`);
console.error("[audit] 修复后重扫；设计内项：node scripts/audit/scan.mjs --accept <token> --reason \"理由\"（token 见报告 JSON）");
process.exit(1);
