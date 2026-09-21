// ---------------------------------------------------------------------------
// smoke 结果落盘（CI-ready）：JUnit XML + summary.json。
// 由 runner.mjs 在指定 --report-dir 时调用；格式按主流 CI 约定（testsuite/
// testcase/ failure 消息 = 套件输出尾部），退出码语义与终端一致（失败 → 1）。
// ---------------------------------------------------------------------------
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {Object} SuiteResult
 * @property {{id: string; kind: string; desc: string; priority: string}} suite
 * @property {boolean} ok
 * @property {number} code
 * @property {number|null} passed
 * @property {number|null} failed
 * @property {number} ms
 * @property {string} output
 */

/** XML 文本转义（属性与文本节点共用） */
function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 套件输出尾部（失败详情；避免 XML 膨胀） */
function tail(text, n = 40) {
  const lines = String(text).trimEnd().split(/\r?\n/);
  return lines.slice(-n).join("\n");
}

/**
 * 把 smoke 运行结果写进 reportDir：
 * - smoke-junit.xml   —— JUnit 格式（testsuite/testcase，失败带输出尾部）
 * - smoke-summary.json —— 机器可读汇总（含每套件耗时，供性能基线比对）
 * @param {SuiteResult[]} results
 * @param {{startedAt: string; totalMs: number}} meta
 */
export function writeSmokeReport(reportDir, results, meta) {
  mkdirSync(reportDir, { recursive: true });
  const bad = results.filter((r) => !r.ok);
  const totalPassed = results.reduce((n, r) => n + (r.passed ?? 0), 0);
  const totalFailed = results.reduce((n, r) => n + (r.failed ?? (r.ok ? 0 : 1)), 0);

  const cases = results
    .map((r) => {
      const name = esc(r.suite.id);
      const attrs = `name="${name}" classname="smoke.${name}" time="${(r.ms / 1000).toFixed(3)}"`;
      if (r.ok) return `    <testcase ${attrs} />`;
      const msg = esc(`套件失败（exit ${r.code}）：${tail(r.output, 20)}`);
      return `    <testcase ${attrs}>\n      <failure message="${esc(`smoke 套件 ${r.suite.id} 失败`)}">${msg}</failure>\n    </testcase>`;
    })
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="smoke" tests="${results.length}" failures="${bad.length}" time="${(meta.totalMs / 1000).toFixed(3)}">
  <testsuite name="smoke-regression" tests="${results.length}" failures="${bad.length}">
${cases}
  </testsuite>
</testsuites>
`;
  writeFileSync(join(reportDir, "smoke-junit.xml"), xml, "utf8");

  const summary = {
    kind: "smoke",
    startedAt: meta.startedAt,
    totalMs: meta.totalMs,
    suites: results.map((r) => ({
      id: r.suite.id,
      kind: r.suite.kind,
      priority: r.suite.priority,
      ok: r.ok,
      passed: r.passed,
      failed: r.failed,
      ms: r.ms,
    })),
    totals: { suites: results.length, ok: results.length - bad.length, failed: bad.length, passed: totalPassed, failedAssertions: totalFailed },
  };
  writeFileSync(join(reportDir, "smoke-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  return summary;
}
