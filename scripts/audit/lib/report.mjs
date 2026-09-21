// ---------------------------------------------------------------------------
// 统一扫描 · 报告渲染：Markdown（人读，含门禁结论/分级统计/分维度明细/
// 已接受清单/未覆盖声明）+ JSON（机读，报告字段同构）。
// ---------------------------------------------------------------------------
import { RANK } from "./finding.mjs";

const SEV_LABEL = { blocker: "Blocker", critical: "Critical", high: "High", major: "Major", minor: "Minor", info: "Info" };
const DIM_LABEL = { security: "安全", quality: "质量", coverage: "覆盖率", dependency: "依赖" };

export function renderMarkdown({ meta, findings, accepted, gate, coverage, notCovered, diff }) {
  const order = [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file));
  const counts = {};
  for (const f of [...findings, ...accepted]) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

  const L = [];
  L.push(`# 统一质量与安全检测报告`, ``);
  L.push(`- 扫描时间：${meta.time}　耗时：${meta.seconds}s　模式：${meta.mode}`);
  L.push(`- 扫描面：${meta.files} 个文件（src ${meta.tsFiles} 前端 / ${meta.rsFiles} Rust / 配置与脚本 ${meta.otherFiles}）`);
  L.push(`- 闭环差分：新增 **${diff.added}** / 已修复 **${diff.resolved}**（对比 ${diff.lastPath.endsWith("last.json") ? "上次扫描" : "基线"}）`);
  L.push(`- 分级统计：${["blocker", "critical", "high", "major", "minor", "info"].map((s) => `${SEV_LABEL[s]} ${counts[s] ?? 0}`).join(" ｜ ")}`);
  L.push(``, `## 门禁结论：${gate.pass ? "✅ 通过" : "❌ 未通过"}`, ``);
  if (!gate.pass) {
    L.push(`破防线目（${gate.breaches.length}）：`, ``);
    for (const b of gate.breaches) L.push(`- ${b}`);
    L.push(``);
  }
  L.push(`门禁标准：无 Blocker/Critical 质量或安全问题、无未接受（台账外）的 High 安全/依赖问题、无硬编码密钥；覆盖率按 vitest 阈值桶结算${coverage.require ? "（本次要求已结算）" : "（本地预检允许 stale，只提示）"}。`, ``);

  if (coverage.buckets?.length) {
    L.push(`## 覆盖率桶结算`, ``);
    L.push(`| 桶 | 结果 | 最差口径 |`, `| --- | --- | --- |`);
    for (const b of coverage.buckets) L.push(`| ${b.name} | ${b.ok ? "✅" : "❌"} | ${b.pct}% |`);
    L.push(``);
  }

  const byDim = new Map();
  for (const f of order) {
    const key = `${f.dimension}/${f.category}`;
    if (!byDim.has(key)) byDim.set(key, []);
    byDim.get(key).push(f);
  }
  L.push(`## 发现明细（未接受）`, ``);
  if (!order.length) L.push(`（无）`, ``);
  for (const [key, list] of byDim) {
    L.push(`### ${key.split("/").map((s, i) => (i === 0 ? DIM_LABEL[s] ?? s : s)).join(" · ")}`, ``);
    for (const f of list) {
      L.push(`- **[${SEV_LABEL[f.severity]}] ${f.rule}** \`${f.file}:${f.line}\``);
      L.push(`  - ${f.message}`);
      if (f.snippet) L.push(`  - 代码：\`${f.snippet.replace(/`/g, "'").slice(0, 140)}\``);
      L.push(`  - 建议：${f.fix}`);
    }
    L.push(``);
  }

  if (accepted.length) {
    L.push(`## 台账接受项（已评审，代码漂移自动失效）`, ``);
    for (const f of accepted) {
      L.push(`- [${SEV_LABEL[f.severity]}] ${f.rule} \`${f.file}:${f.line}\` —— ${f.acceptReason}（${f.acceptDate.slice(0, 10)} 接受）`);
    }
    L.push(``);
  }

  L.push(`## 未覆盖维度声明`, ``);
  for (const n of notCovered) L.push(`- ${n}`);
  L.push(``);
  return L.join("\n");
}

export function renderSummaryLine(findings, gate) {
  const counts = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  const parts = ["blocker", "critical", "high", "major", "minor", "info"]
    .filter((s) => counts[s])
    .map((s) => `${SEV_LABEL[s]}×${counts[s]}`);
  return parts.join(" ") || "0 项发现";
}
