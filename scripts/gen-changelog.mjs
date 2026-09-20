// CHANGELOG 生成器：git 历史 → CHANGELOG.md（全量再生，幂等）。
//
// 用法：
//   pnpm changelog            全量再生 CHANGELOG.md
//   pnpm changelog --check    只校验文件是否为最新（过期则退出码 1）
//   node scripts/gen-changelog.mjs --limit <n>   只生成最近 n 个版本段（调试用）
//
// 文件是产物不是手写文档：改提交信息后重跑本脚本即可。头部声明此约定，
// 手改内容会在下次再生时丢失。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { groupCommits, splitByRelease, currentVersion } from "./changelog-core.mjs";

const HEADER = `# 更新日志

本文件由 scripts/gen-changelog.mjs 从 Conventional Commits 自动生成，**请勿手改**。

- 全量再生：\`pnpm changelog\`（发版提交 \`chore(version): vX.Y.Z\` / git tag 即发布锚点）；
- \`pnpm version:bump auto\` 按未发布提交的类型自动递增版本（feat→minor、fix→patch、
  破坏性→major，0.x 阶段破坏性按 semver 惯例只升 minor），并把新版本段写进本文件。

`;

// 单条目截断：旧提交主题常是整段说明文，CHANGELOG 只留一行
const ENTRY_MAX = 120;

function renderEntries(entries) {
  return entries.map((e) => {
    let text = e.text.length > ENTRY_MAX ? e.text.slice(0, ENTRY_MAX).replace(/\s+\S*$/, "") + "…" : e.text;
    const scope = e.scope ? `**${e.scope}**: ` : "";
    const mark = e.breaking ? " **【破坏性】**" : "";
    return `- ${scope}${text}${mark}`;
  });
}

function renderSection(section, dupLabel) {
  const suffix = section.date
    ? `（${section.date}${dupLabel ? "，早期同名版本" : ""}）`
    : "（未发布）";
  const title = `## v${section.label.replace(/^v/, "")}${suffix}`;
  const groups = groupCommits(section.commits);
  const body = groups.map((g) => [`### ${g.title}`, ...renderEntries(g.entries), ""].join("\n"));
  // 破坏性变更置顶提示
  const breaking = groups.flatMap((g) => g.entries).filter((e) => e.breaking);
  const warn = breaking.length ? `> ⚠️ 本版本含破坏性变更，升级前请阅读相关条目。\n\n` : "";
  return [title, "", ...(warn ? [warn] : []), ...(body.length ? body : ["（无）", ""]), ""].join("\n");
}

export function renderChangelog(root, { limit } = {}) {
  const sections = splitByRelease(root);
  const unreleased = sections.find((s) => s.label === null);
  const released = sections.filter((s) => s.label !== null).slice(0, limit ?? Infinity);
  // 未发布段：仅当存在未发布提交时才出段（版本号取事实源）
  const current = currentVersion(root);
  const showUnreleased = unreleased && unreleased.commits.length > 0;
  const parts = [];
  if (showUnreleased) parts.push(renderSection({ ...unreleased, label: current }));
  const seen = new Set();
  parts.push(...released.map((s) => {
    const key = s.label.replace(/^v/, ""); // tag 带 v 前缀、裸版本提交不带，显示前先归一
    const dup = seen.has(key);
    seen.add(key);
    return renderSection(s, dup);
  }));
  return HEADER + parts.join("");
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  let root = path.resolve(scriptDir, "..");
  let check = false;
  let limit;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") { root = path.resolve(args[i + 1] ?? "."); i++; }
    else if (args[i] === "--check") check = true;
    else if (args[i] === "--limit") { limit = Number(args[i + 1] ?? Infinity); i++; }
    else if (args[i] === "--help" || args[i] === "-h") { console.log(readFileSync(new URL(import.meta.url), "utf8")); process.exit(0); }
  }

  const file = path.join(root, "CHANGELOG.md");
  const next = renderChangelog(root, Number.isFinite(limit) ? { limit } : undefined);
  if (check) {
    const cur = readFileSync(file, "utf8");
    if (cur !== next) { console.error("✗ CHANGELOG.md 已过期：运行 pnpm changelog 再生"); process.exit(1); }
    console.log("✓ CHANGELOG.md 已是最新");
    return;
  }
  writeFileSync(file, next);
  const count = next.split("\n").filter((l) => l.startsWith("## ")).length;
  console.log(`✓ CHANGELOG.md 再生完成（${count} 个版本段）`);
}

// 被 sync-version.mjs import 时只复用渲染，不执行 CLI
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
