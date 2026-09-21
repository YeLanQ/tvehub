// ---------------------------------------------------------------------------
// 统一扫描 · 发现（Finding）模型、评审台账（ledger）与门禁判定。
//
// 分级（对齐任务门禁口径）：
//   blocker  硬编码真实密钥 / 可直达 RCE 的模式 —— 一票否决
//   critical 安全：注入/XSS 可达外部输入；质量：吞异常致数据丢失级缺陷
//   high     安全：越权/SSRF/敏感泄露；依赖 CVE high|critical
//   major    需排期修复（空 catch、超长函数、大段重复、unwrap 于命令路径）
//   minor    风格债（命名、console、文件超 200 行）
//   info     备查（TODO、设计内模式）
//
// 门禁（scan.mjs --gate，默认开）：存在未接受（非台账 accepted）的
// blocker/critical（任意维度）或 high（仅安全/依赖）→ 退出码 1。
// 台账 reports/audit/ledger.json 记录"设计内接受"项：rule + file + 代码签名
// 三元组命中才生效，代码漂移后自动失效（防止接受项变成永久免死金牌）。
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "./collect.mjs";

export const RANK = { blocker: 0, critical: 1, high: 2, major: 3, minor: 4, info: 5 };
// 台账入库（tests/ 与 ISSUES.md 同级）：评审接受记录跨机共享；reports/ 整体
// gitignore，只放本地产物（报告快照与差分基线）
export const LEDGER_PATH = join(ROOT, "tests", "AUDIT-LEDGER.json");

/** 代码签名：去除空白后取片段哈希前 10 位 —— 行号移动不失效，代码改动即失效 */
export function snippetSig(snippet) {
  return createHash("sha1").update((snippet ?? "").replace(/\s+/g, "")).digest("hex").slice(0, 10);
}

export function makeFinding({ rule, dimension, category, severity, file, line, snippet, message, fix }) {
  const sig = snippetSig(snippet);
  return {
    rule, dimension, category, severity,
    file, line: line || 1,
    snippet: (snippet ?? "").trim().slice(0, 160),
    message, fix,
    token: `${rule}@${file}@${sig}`, // 台账接受凭据（--accept 用）
  };
}

export function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return [];
  try {
    return JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
  } catch (e) {
    console.error(`[audit] 台账解析失败（${e.message}），按空台账处理`);
    return [];
  }
}

/** 就地标注 accepted 并返回未接受集合；命中条件 = rule+file+sig 三元组 */
export function applyLedger(findings, ledger) {
  const byToken = new Map(ledger.map((e) => [`${e.rule}@${e.file}@${e.sig}`, e]));
  for (const f of findings) {
    const hit = byToken.get(f.token);
    if (hit && (!hit.expires || hit.expires > new Date().toISOString())) {
      f.accepted = true;
      f.acceptReason = hit.reason ?? "";
      f.acceptDate = hit.date ?? "";
    }
  }
  return findings.filter((f) => !f.accepted);
}

export function addAcceptance(token, reason, months = 12) {
  const [rule, file, sig] = token.split("@");
  if (!rule || !file || !sig || !/^[0-9a-f]{10}$/.test(sig)) {
    console.error(`[audit] --accept 凭据格式非法：${token}`);
    process.exit(1);
  }
  const ledger = loadLedger();
  if (ledger.some((e) => `${e.rule}@${e.file}@${e.sig}` === token)) {
    console.log(`[audit] 该项已在台账：${token}`);
    return;
  }
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  ledger.push({ rule, file, sig, reason, date: new Date().toISOString(), expires: d.toISOString() });
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n", "utf8");
  console.log(`[audit] 已入台账（${months} 个月有效，代码漂移自动失效）：${token}`);
}

/** 门禁判定：返回 { pass, breaches[] } —— breaches 为破防线目（含失败原因） */
export function evaluateGate(findings, opts) {
  const breaches = [];
  for (const f of findings) {
    if (RANK[f.severity] <= RANK.critical) {
      breaches.push(`${f.severity.toUpperCase()} ${f.rule} ${f.file}:${f.line} ${f.message}`);
    } else if (f.dimension === "security" || f.dimension === "dependency") {
      if (f.severity === "high") {
        breaches.push(`HIGH ${f.rule} ${f.file}:${f.line} ${f.message}`);
      }
    }
  }
  if (opts?.requireCoverage && !opts.coverageSettled) {
    breaches.push(`COVERAGE 覆盖率未结算（需先跑 pnpm test:coverage 产出 coverage/coverage-summary.json）`);
  }
  if (opts?.cveError) breaches.push(`CVE 依赖扫描执行失败：${opts.cveError}`);
  return { pass: breaches.length === 0, breaches };
}

/** 与上次扫描（last.json）比对，产出 新增/已修复 —— 闭环跟踪的差分基线 */
export function diffLast(findings) {
  const lastPath = join(ROOT, "reports", "audit", "last.json");
  const cur = new Set(findings.map((f) => f.token));
  let added = 0;
  let resolved = 0;
  if (existsSync(lastPath)) {
    try {
      const prev = new Set(JSON.parse(readFileSync(lastPath, "utf8")).map((f) => f.token));
      added = [...cur].filter((t) => !prev.has(t)).length;
      resolved = [...prev].filter((t) => !cur.has(t)).length;
    } catch {
      /* 基线损坏按无基线处理 */
    }
  } else {
    added = cur.size;
  }
  return { added, resolved, lastPath };
}
