// ---------------------------------------------------------------------------
// 测试覆盖率结算：读取 vitest 产出的 coverage/coverage-summary.json，按
// vitest.config.ts 的 thresholds 桶（正则解析单一事实源）呈现每桶最差口径。
//
// 阈值裁决权归 vitest 本身（`vitest run --coverage` 非零退出即拦截，已挂在
// rescan/run-all 门禁链）——v8 桶装文件（纯 re-export）与加载语义由 vitest
// 定义，本模块重算会漂移（实测已两次）。故本模块职责 = 新鲜度门禁（require
// 模式下 summary 缺失/过期即破防）+ 未达标文件的信息级追踪（不破防）。
// Rust 测试覆盖率（tarpaulin）Windows 不可用，声明未覆盖。
// ---------------------------------------------------------------------------
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { makeFinding } from "./lib/finding.mjs";
import { ROOT } from "./lib/collect.mjs";

const SUMMARY = join(ROOT, "coverage", "coverage-summary.json");

/** vitest.config.ts thresholds 表 → [{ glob, statements, branches, functions, lines }] */
export function loadThresholds() {
  const text = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
  const start = text.indexOf("thresholds:");
  // 取到文件尾（条目正则自锚定，不会误配后续内容；不能用首个 "}," 截断——那是第一条目结尾）
  const seg = text.slice(start);
  const entries = [];
  const re = /"([^"]+)":\s*\{\s*statements:\s*(\d+),\s*branches:\s*(\d+),\s*functions:\s*(\d+),\s*lines:\s*(\d+)\s*\}/g;
  let m;
  while ((m = re.exec(seg))) {
    entries.push({ glob: m[1], statements: +m[2], branches: +m[3], functions: +m[4], lines: +m[5] });
  }
  return entries;
}

function globToRe(g) {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${esc}$`);
}

/**
 * @returns {{ settled:boolean, stale:boolean, findings:F[], buckets:{name,ok,pct}[] }}
 * settled = summary 存在且新鲜（require 模式的门禁语义）；阈值未达标文件仅报 info 级。
 */
export function settleCoverage() {
  const thresholds = loadThresholds();
  if (!existsSync(SUMMARY)) {
    return { settled: false, stale: true, findings: [], buckets: [] };
  }
  const ageH = (Date.now() - statSync(SUMMARY).mtimeMs) / 3_600_000;
  const stale = ageH > 24;
  let summary;
  try {
    summary = JSON.parse(readFileSync(SUMMARY, "utf8"));
  } catch {
    return { settled: false, stale: true, findings: [], buckets: [] };
  }

  // json-summary 的键可能是绝对路径（Windows 反斜杠）——规范化为仓库相对 POSIX 路径
  const rootPrefix = ROOT.split(sep).join("/").replace(/^[A-Za-z]:\//, "");
  const normKey = (k) => {
    const p = k.split(sep).join("/").replace(/^[A-Za-z]:\//, "");
    const idx = p.indexOf(rootPrefix);
    return idx >= 0 ? p.slice(idx + rootPrefix.length).replace(/^\//, "") : p;
  };
  const normSummary = {};
  for (const [k, v] of Object.entries(summary)) normSummary[k === "total" ? "total" : normKey(k)] = v;

  const findings = [];
  const buckets = [];
  for (const t of thresholds) {
    const re = globToRe(t.glob);
    const matched = Object.keys(normSummary).filter((k) => k !== "total" && re.test(k));
    if (!matched.length) {
      if (!t.glob.includes("*")) {
        findings.push(covFinding(t.glob, `桶内文件未出现在覆盖率报告（新文件未跑覆盖？）`));
        buckets.push({ name: t.glob, ok: false, pct: 0 });
      }
      continue;
    }
    // 桶呈现口径 = 匹配文件中最差者（信息级）；无可执行内容（statements.total=0
    // 的桶装 index.ts）与 vitest 一致跳过
    let worst = null;
    for (const k of matched) {
      const s = normSummary[k];
      if ((s.statements?.total ?? 0) === 0) continue;
      const worstPct = Math.min(s.statements.pct, s.branches.pct, s.functions.pct, s.lines.pct);
      if (!worst || worstPct < worst.worstPct) worst = { k, worstPct, s };
    }
    if (!worst) {
      buckets.push({ name: t.glob, ok: true, pct: 100 });
      continue;
    }
    const dims = ["statements", "branches", "functions", "lines"].filter((d) => worst.s[d].pct < t[d]);
    if (dims.length) {
      // 阈值拦截由 vitest 退出码负责；这里只做信息级追踪（报告呈现 + 差分基线）
      findings.push(covFinding(worst.k, `桶内最差文件低于阈值：${dims.map((d) => `${d} ${worst.s[d].pct}%<${t[d]}%`).join("，")}（阈值拦截以 vitest 退出码为准）`));
    }
    buckets.push({ name: t.glob, ok: dims.length === 0, pct: worst.worstPct });
  }
  return { settled: true, stale, findings, buckets };
}

function covFinding(file, detail) {
  return makeFinding({
    rule: "coverage.below-threshold", dimension: "coverage", category: "测试覆盖率",
    severity: "info", file, line: 1, snippet: "",
    message: `覆盖率桶追踪：${detail}`,
    fix: "补对应路径单测（同目录 *.spec.ts）；阈值调整须负向验证 vitest 会拦",
  });
}
