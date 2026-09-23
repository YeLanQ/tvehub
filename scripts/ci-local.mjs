// ---------------------------------------------------------------------------
// 本地自动 CI（一键门禁链）：提交/发版前的本地全量自检，与 dev/build 门禁同源。
//
// 步骤（默认）：
//   skills  = node scripts/check-skills.mjs        技能文档漂移校验（自演化检测网）
//   docs    = pnpm gen:api-docs && pnpm docs:test  文档再生成（示例覆盖门禁）+
//                                                  文档代码块测试（类型+真实执行）
//   types   = pnpm exec vue-tsc --noEmit           类型检查（根 tsconfig strict）
//   layers  = node scripts/check-layers.mjs        分层门禁（仅 src/lib 可碰 Tauri API）
//   audit   = node scripts/audit/scan.mjs          质量+安全统一扫描（密钥/XSS/穿越/
//                                                  CVE/覆盖率/复杂度/重复，分级门禁）
//   unit    = pnpm exec vitest run                 单元/组件测试（351 例）
//   smoke   = node scripts/smoke/runner.mjs --core P0 核心回归（必须全绿）
//
// 用法：
//   pnpm ci:local                     全链（任一步失败即停，退出码非 0）
//   pnpm ci:local --full              末尾追加全量归档（node scripts/test/run-all.mjs：
//                                     覆盖率阈值结算 + smoke 全量 + reports/<日期>/）
//   pnpm ci:local --only skills,unit  只跑指定步骤（逗号分隔）
//   pnpm ci:local --skip smoke        跳过指定步骤（快速迭代用，结果要注明跳过项）
//   退出码：全部通过 0；任一失败/未知步骤名 1。
// 设计：与 package.json 既有脚本一一对应（不另造口径），失败即停并打印下一步建议。
// ---------------------------------------------------------------------------
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : undefined;
};

const full = argv.includes("--full");
const only = typeof flag("--only") === "string" ? flag("--only").split(",") : null;
const skip = typeof flag("--skip") === "string" ? flag("--skip").split(",") : [];

/** 步骤表：cmd 为 shell 字符串（Windows 下经 shell 解析 .cmd/.cmd 垫片） */
const STEPS = [
  { name: "skills", title: "技能文档校验", cmd: "node scripts/check-skills.mjs" },
  {
    name: "docs",
    title: "文档生成与代码块测试",
    cmd: "pnpm gen:api-docs && pnpm docs:test",
    hint: "缺示例/坏块定位 scripts/api-docs/examples/ 与 scripts/docs-tests/README.md",
  },
  { name: "types", title: "类型检查", cmd: "pnpm exec vue-tsc --noEmit" },
  { name: "layers", title: "分层门禁", cmd: "node scripts/check-layers.mjs" },
  {
    name: "audit",
    title: "质量+安全统一扫描",
    cmd: "node scripts/audit/scan.mjs",
    hint: "报告 reports/audit/audit-report.md；设计内项用 --accept <token> --reason 入台账",
  },
  { name: "unit", title: "单元/组件测试", cmd: "pnpm exec vitest run" },
  {
    name: "smoke",
    title: "P0 核心回归",
    cmd: "node scripts/smoke/runner.mjs --core",
    hint: "P1 已知漂移见 tests/ISSUES.md；套件定位：pnpm smoke --list",
  },
  ...(full
    ? [{ name: "all", title: "全量归档（覆盖率阈值 + smoke 全量 + reports/）", cmd: "node scripts/test/run-all.mjs" }]
    : []),
];

const unknown = [...(only ?? []), ...skip].filter((n) => !STEPS.some((s) => s.name === n));
if (unknown.length) {
  console.error(`✗ 未知步骤名：${unknown.join(", ")}（可选：${STEPS.map((s) => s.name).join(", ")}）`);
  process.exit(1);
}

const chosen = STEPS.filter(
  (s) => (!only || only.includes(s.name)) && !skip.includes(s.name),
);

console.log(`\n本地 CI：${chosen.map((s) => s.name).join(" → ") || "（无步骤）"}\n`);
const results = [];

for (const step of chosen) {
  const t0 = Date.now();
  process.stdout.write(`▶ [${step.name}] ${step.title}\n`);
  const r = spawnSync(step.cmd, {
    cwd: ROOT,
    shell: true,
    stdio: step.name === "smoke" || step.name === "all" ? "inherit" : ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  const ok = r.status === 0;
  results.push({ ...step, ok, seconds });
  if (ok) {
    process.stdout.write(`✔ [${step.name}] 通过（${seconds}s）\n\n`);
    continue;
  }
  // 失败即停：stdout 已在 pipe 模式下丢弃，指引用户单跑看全量输出
  process.stderr.write(`✗ [${step.name}] 失败（${seconds}s）\n`);
  if (step.hint) process.stderr.write(`  提示：${step.hint}\n`);
  process.stderr.write(`  单跑排查：${step.cmd}\n`);
  printSummary(results);
  process.exit(1);
}

printSummary(results);
if (skip.length) console.log(`\n注意：本次跳过了 ${skip.join(", ")}——结果不构成完整门禁结论。`);
process.exit(0);

function printSummary(list) {
  console.log("\n──────── 本地 CI 结果 ────────");
  for (const r of list) {
    console.log(`${r.ok ? "✔" : "✗"} ${r.name.padEnd(7)} ${r.title}（${r.seconds}s）`);
  }
  console.log("");
}
