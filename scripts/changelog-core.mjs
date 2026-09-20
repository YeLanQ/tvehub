// CHANGELOG 数据层：从 git 历史解析出「发布分段 + 提交分类」，供
// gen-changelog.mjs（渲染 CHANGELOG.md）与 sync-version.mjs（auto 级别判定）
// 共用。
//
// 发布锚点（新到旧）＝ 同时满足：
//   1. git tag 指向该提交（标签名即版本名），或
//   2. 提交主题形如 `chore(version): v0.1.3+1` / `0.1.2`（裸版本号提交）。
// 锚点之间的提交归入较新的锚点段；最新锚点之后的提交为「未发布」段，
// 版本号取 tauri.conf.json 的事实源版本。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// 主题即版本号的提交（含 chore(version): 前缀；裸 "0.1" 这类也认）
const VERSION_SUBJECT_RE = /^(?:chore\(version\):\s*)?(v\d[\w.+-]*|\d+(?:\.\d+)+)$/;
// Conventional Commits：type(scope)!: subject（type 白名单外按普通主题处理）
const CONVENTIONAL_RE = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s(.+)$/;

/** 提交类型 → 分组标题（顺序即 CHANGELOG 组顺序；未命中进「其他」） */
const TYPE_GROUPS = [
  ["feat", "新特性"],
  ["fix", "问题修复"],
  ["perf", "性能优化"],
  ["refactor", "重构"],
  ["docs", "文档"],
  ["test", "测试"],
];

/** 读 git log（一次全量，新到旧）与 tag → commit 映射 */
function loadGitHistory(root) {
  const git = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const commits = git(["log", "--date=short", "--format=%H%x09%ad%x09%s"])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, date, ...rest] = line.split("\t");
      return { hash, date, subject: rest.join("\t") };
    });
  const tagTargets = new Map(); // commit hash → tag 名（同提交多 tag 取第一个）
  for (const line of git(["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/tags"]).split("\n")) {
    if (!line) continue;
    const [name, hash] = line.split("\t");
    // annotated tag 的 objectname 是 tag 对象，先解引用到提交
    let target = hash;
    try {
      target = git(["rev-parse", `${name}^{commit}`]).trim();
    } catch { /* 剥离 tag 解析失败则跳过该 tag */ continue; }
    if (!tagTargets.has(target)) tagTargets.set(target, name);
  }
  return { commits, tagTargets };
}

function classify(subject) {
  const m = CONVENTIONAL_RE.exec(subject);
  if (!m) return { type: "", scope: "", breaking: false, text: subject };
  return { type: m[1].toLowerCase(), scope: m[2] ?? "", breaking: m[3] === "!", text: m[4] };
}

/**
 * 把线性提交历史按锚点切段。返回段列表（新到旧）：
 * [{ label, date, commits: [{ hash, date, subject, ...classify }] }]
 * label 为 null 的段是「未发布」。段 = 严格介于相邻两锚点之间的提交，
 * 归属其中较新的锚点（锚点提交本身只是标记，不进任何段）。
 */
export function splitByRelease(root) {
  const { commits, tagTargets } = loadGitHistory(root);
  const byIndex = new Map(); // 同提交既中 tag 又中裸版本主题时，tag 名优先
  commits.forEach((c, i) => {
    if (byIndex.has(i)) return;
    const tag = tagTargets.get(c.hash);
    const m = VERSION_SUBJECT_RE.exec(c.subject);
    if (tag) byIndex.set(i, tag);
    else if (m) byIndex.set(i, m[1]);
  });
  const anchors = [...byIndex].map(([index, label]) => ({ index, label })).sort((a, b) => a.index - b.index);

  const sections = [];
  const first = anchors[0];
  sections.push({ label: null, date: null, commits: commits.slice(0, first ? first.index : commits.length) });
  anchors.forEach((a, i) => {
    const older = anchors[i + 1];
    // 段 = 严格介于本锚点与下一个更旧锚点之间的提交（下标更大者更旧）；
    // 没有更旧锚点（最早的发布）则取它之后的全部历史
    const end = older ? older.index : commits.length;
    sections.push({ label: a.label, date: commits[a.index].date, commits: commits.slice(a.index + 1, end) });
  });
  for (const s of sections) s.commits = s.commits.map((c) => ({ ...c, ...classify(c.subject) }));
  return sections;
}

/** 按类型分组提交：[{ title, entries: [{ scope, text, breaking }] }]；版本标记提交剔除 */
export function groupCommits(commits) {
  const isMarker = (c) => c.type === "chore" && c.scope === "version" && /^v?\d/.test(c.text);
  const groups = [...TYPE_GROUPS.map(([type, title]) => ({ title, entries: [] })), { title: "其他", entries: [] }];
  const pick = (type) => {
    const i = TYPE_GROUPS.findIndex(([t]) => t === type);
    return i === -1 ? groups[groups.length - 1] : groups[i];
  };
  for (const c of commits) {
    if (isMarker(c)) continue;
    pick(c.type).entries.push({ scope: c.scope, text: c.text, breaking: c.breaking });
  }
  return groups.filter((g) => g.entries.length > 0);
}

/** 未发布提交 → 语义化 bump 级别；无未发布提交返回 null（调用方报错） */
export function autoBumpLevel(commits, currentMajor) {
  const real = commits.filter((c) => !(c.type === "chore" && c.scope === "version" && /^v?\d/.test(c.text)));
  if (real.length === 0) return null;
  const breaking = real.some((c) => c.breaking || /BREAKING CHANGE/i.test(c.subject));
  const hasFeat = real.some((c) => c.type === "feat");
  if (breaking) return currentMajor === 0 ? "minor" : "major"; // 0.x 按 semver 约定破坏性只升 minor
  if (hasFeat) return "minor";
  return "patch";
}

/** 当前事实源版本（tauri.conf.json） */
export function currentVersion(root) {
  const conf = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  if (!conf.version) throw new Error("tauri.conf.json 缺少 version 字段");
  return conf.version;
}
