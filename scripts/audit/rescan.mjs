// ---------------------------------------------------------------------------
// 上线后复扫（pnpm audit:rescan）：刷新覆盖率 → 全量扫描（含 CVE，覆盖率必须
// 已结算）→ 归档 reports/<日期>/audit/ → 追加 reports/history.jsonl 趋势行。
// 与 ci:local --full 的归档口径一致（见 scripts/test/run-all.mjs）。
// ---------------------------------------------------------------------------
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./lib/collect.mjs";

const HIST = join(ROOT, "reports", "history.jsonl");

// ① 覆盖率重结算（vitest 阈值以退出码说话）
console.log("[audit:rescan] ① 覆盖率重结算（vitest run --coverage）");
const cov = spawnSync("pnpm", ["exec", "vitest", "run", "--coverage"], {
  cwd: ROOT, shell: true, stdio: "inherit", timeout: 1_200_000,
});
if (cov.status !== 0) {
  console.error("[audit:rescan] 覆盖率结算失败（阈值未达标或测试红）—— 复扫终止");
  process.exit(1);
}

// ② 全量扫描：--require-coverage --archive
console.log("[audit:rescan] ② 统一扫描（含 CVE，覆盖率强制结算，归档）");
const scan = spawnSync("node", [join("scripts", "audit", "scan.mjs"), "--require-coverage", "--archive"], {
  cwd: ROOT, shell: true, stdio: "inherit", timeout: 600_000,
});
if (scan.status !== 0) {
  console.error("[audit:rescan] 扫描门禁未通过 —— 复扫终止");
  process.exit(1);
}

// ③ 趋势流水（与 run-all.mjs 的 history.jsonl 同流不同 type，便于同表观察）
let total = 0;
let breaches = 0;
try {
  const rep = JSON.parse(readFileSync(join(ROOT, "reports", "audit", "audit-report.json"), "utf8"));
  total = rep.findings?.length ?? 0;
  breaches = rep.findings?.filter((f) => ["blocker", "critical"].includes(f.severity) || (f.severity === "high" && f.dimension !== "quality")).length ?? 0;
} catch { /* 报告缺失不阻塞流水 */ }
appendFileSync(HIST, JSON.stringify({ type: "audit-rescan", date: new Date().toISOString(), openFindings: total, gateBreaches: breaches }) + "\n", "utf8");
console.log(`[audit:rescan] ③ 趋势已入 ${existsSync(HIST) ? "reports/history.jsonl" : HIST}（open=${total}, breaches=${breaches}）`);
console.log("[audit:rescan] ✅ 复扫完成");
