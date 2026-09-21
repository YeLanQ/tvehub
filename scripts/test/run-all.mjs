#!/usr/bin/env node
// ---------------------------------------------------------------------------
// 一键全跑 + 报告归档（跨平台 Node 脚本，不依赖 bash）：
//   ① 单元测试 + 覆盖率（vitest --coverage：HTML / Cobertura XML / JSON 汇总）
//   ② 全量回归（scripts/smoke/runner.mjs --all：JUnit XML + summary JSON）
//   ③ 归档到 reports/<YYYY-MM-DD>/（coverage/ + smoke/ + summary.md），并追加
//      reports/history.jsonl 趋势流水（覆盖率 / 通过数随日期变化一目了然）
//   ④ 性能基线比对（reports/perf-baseline.json，超基线 3× 只告警不失败）
//
// 用法：pnpm test:all [-- --update-baseline] [-- --skip-smoke] [-- --skip-unit]
// 退出码：任一环节失败 → 1（CI-ready：报告在 reports/，格式 XML/JSONL 规范）。
// ---------------------------------------------------------------------------
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const REPORTS = join(ROOT, "reports");
const BASELINE = join(REPORTS, "perf-baseline.json");
const PERF_TOLERANCE = 3; // 超基线 3× 视为显著偏差（跨机器/负载差异留量）

const flags = new Set(process.argv.slice(2));
const day = new Date().toISOString().slice(0, 10);
const outDir = join(REPORTS, day);

/** 子进程转发运行（windowsHide：GUI 子系统下裸 spawn 会弹黑窗） */
function run(cmd, args, label) {
  console.log(`\n━━━ ${label} ━━━`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: false, windowsHide: true });
  return r.status ?? 1;
}

/** vitest 入口（node 直跑 vitest.mjs，免 pnpm 壳） */
function vitestBin() {
  const req = createRequire(join(ROOT, "package.json"));
  return join(dirname(req.resolve("vitest/package.json")), "vitest.mjs");
}

// ---------- ① 单元测试 + 覆盖率 ----------
let unitCode = 0;
if (!flags.has("--skip-unit")) {
  unitCode = run(process.execPath, [vitestBin(), "run", "--coverage"], "单元测试 + 覆盖率");
}

// ---------- ② 全量回归 ----------
let smokeCode = 0;
if (!flags.has("--skip-smoke")) {
  smokeCode = run(
    process.execPath,
    [join("scripts", "smoke", "runner.mjs"), "--all", "-q", "--report-dir", join(outDir, "smoke")],
    "全量回归（smoke）",
  );
}

// ---------- ③ 归档 ----------
mkdirSync(outDir, { recursive: true });
if (existsSync(join(ROOT, "coverage", "index.html"))) {
  mkdirSync(join(outDir, "coverage"), { recursive: true });
  cpSync(join(ROOT, "coverage"), join(outDir, "coverage"), { recursive: true });
}

const covSummaryPath = join(ROOT, "coverage", "coverage-summary.json");
const cov = existsSync(covSummaryPath)
  ? JSON.parse(readFileSync(covSummaryPath, "utf8")).total
  : null;
const smokeSummaryPath = join(outDir, "smoke", "smoke-summary.json");
const smoke = existsSync(smokeSummaryPath)
  ? JSON.parse(readFileSync(smokeSummaryPath, "utf8"))
  : null;

// 性能基线：超差只告警（不同机器负载不可比，偏差记录进 summary 供人工评估）
const perfNotes = checkPerfBaseline(smoke);

const summary = [
  `# 测试报告 ${day}`,
  "",
  "## 单元测试（vitest）",
  unitCode === 0 ? "- 状态：**通过**" : `- 状态：**失败（exit ${unitCode}）**`,
  cov
    ? `- 覆盖率（单测口径，见 vitest.config.ts include）：语句 ${cov.statements.pct}% / 分支 ${cov.branches.pct}% / 函数 ${cov.functions.pct}% / 行 ${cov.lines.pct}%`
    : "- 覆盖率：未生成",
  "- HTML：coverage/index.html；XML：coverage/cobertura-coverage.xml（Cobertura）",
  "",
  "## 回归测试（smoke 全量）",
  smoke
    ? `- 套件：${smoke.totals.ok}/${smoke.totals.suites} 通过 · 断言 ${smoke.totals.passed} 通过 / ${smoke.totals.failedAssertions} 失败`
    : "- 未运行",
  "- XML：smoke/smoke-junit.xml（JUnit）；机器可读：smoke/smoke-summary.json",
  ...(perfNotes.length ? ["", "## 性能基线偏差（仅告警）", ...perfNotes.map((n) => `- ${n}`)] : []),
  "",
  "## 优先级口径",
  "- P0 核心回归（pnpm test:regression:core）须全绿；P1 套件含已知契约漂移（tests/ISSUES.md）。",
  "",
].join("\n");
writeFileSync(join(outDir, "summary.md"), summary, "utf8");

// 趋势流水（JSONL：每行一次全跑）
const historyLine = {
  date: new Date().toISOString(),
  unit: { ok: unitCode === 0 },
  coverage: cov ? { statements: cov.statements.pct, branches: cov.branches.pct, functions: cov.functions.pct, lines: cov.lines.pct } : null,
  smoke: smoke ? { ok: smoke.totals.failed === 0 && smokeCode === 0, suites: smoke.totals.suites, okSuites: smoke.totals.ok, passed: smoke.totals.passed, failed: smoke.totals.failedAssertions } : null,
  perfNotes,
};
mkdirSync(REPORTS, { recursive: true });
writeFileSync(join(REPORTS, "history.jsonl"), JSON.stringify(historyLine) + "\n", { flag: "a" });

console.log(`\n━━━ 归档 ━━━`);
console.log(`报告目录：${join(outDir)}`);
console.log(summary);
process.exitCode = unitCode !== 0 || smokeCode !== 0 ? 1 : 0;

// ---------- ④ 性能基线比对 / 更新 ----------
function checkPerfBaseline(smokeSummary) {
  const notes = [];
  if (!smokeSummary) return notes;
  const current = {};
  for (const s of smokeSummary.suites) current[s.id] = s.ms;
  if (flags.has("--update-baseline") || !existsSync(BASELINE)) {
    writeFileSync(BASELINE, JSON.stringify({ recordedAt: new Date().toISOString(), suites: current }, null, 2), "utf8");
    console.log(`性能基线已${flags.has("--update-baseline") ? "更新" : "创建"}：reports/perf-baseline.json`);
    return notes;
  }
  const base = JSON.parse(readFileSync(BASELINE, "utf8")).suites;
  for (const [id, ms] of Object.entries(current)) {
    const b = base[id];
    if (b && b > 0 && ms > b * PERF_TOLERANCE) {
      notes.push(`套件 ${id} 耗时 ${ms.toFixed(0)}ms 超基线 ${b.toFixed(0)}ms 的 ${PERF_TOLERANCE}×`);
    }
  }
  return notes;
}
