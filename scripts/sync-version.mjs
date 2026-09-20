// 版本号同步：单一事实源 = src-tauri/tauri.conf.json 的 version（产品版本，
// exe 文件版本资源与首页 __APP_VERSION__ 都取它），传播到 package.json 与
// src-tauri/Cargo.toml，避免三处手改遗漏。
//
// 用法：
//   pnpm version:sync            校准 package.json / Cargo.toml 到事实源（默认）
//   pnpm version:check           只校验不写入，不一致则退出码 1（build 链门禁）
//   pnpm version:bump [级别]     先递增事实源再同步，级别 major|minor|patch|build|auto
//                                auto = 按未发布提交自动判定（feat→minor、fix→patch、
//                                破坏性→major；0.x 阶段破坏性按 semver 惯例只升 minor）
//                                build = 递增 "+N" 构建号；major/minor/patch
//                                会清掉 "+N"，下次 version:bump build 从 +1 重新计
//   major/minor/patch（含 auto 判定结果）递增后自动再生 CHANGELOG.md，
//   新版本段以「未发布」出现，发版提交落锚后下次 pnpm changelog 补上日期。
// 可选 --root <dir> 指定仓库根（默认脚本上级目录），供临时目录测试用。
//
// Cargo.lock 不手改：随下次 cargo build 自动再生。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoBumpLevel, splitByRelease } from "./changelog-core.mjs";
import { renderChangelog } from "./gen-changelog.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

// ---- 参数解析 --------------------------------------------------------------

let root = path.resolve(scriptDir, "..");
let check = false;
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root") {
    root = path.resolve(args[i + 1] ?? ".")
    i++;
  } else if (args[i] === "--check") {
    check = true;
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log(readFileSync(new URL(import.meta.url), "utf8"));
    process.exit(0);
  } else {
    positional.push(args[i]);
  }
}

const [cmd = "sync", bumpLevel] = positional;
if (check && cmd === "bump") {
  console.error("--check 与 bump 互斥：bump 本身就会写入并对齐");
  process.exit(1);
}

// ---- 版本号解析 / 递增 -----------------------------------------------------

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:\+([0-9A-Za-z.-]+))?$/;

function parseVersion(text) {
  const m = SEMVER_RE.exec(text.trim());
  if (!m) throw new Error(`非法版本号 "${text}"（期望 major.minor.patch[+构建号]）`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), build: m[4] ?? "" };
}

function fmtVersion(v) {
  return `${v.major}.${v.minor}.${v.patch}` + (v.build === "" ? "" : `+${v.build}`);
}

function bumpVersion(v, level) {
  const next = { ...v };
  switch (level) {
    case "major":
      next.major++; next.minor = 0; next.patch = 0; next.build = "";
      break;
    case "minor":
      next.minor++; next.patch = 0; next.build = "";
      break;
    case "patch":
      next.patch++; next.build = "";
      break;
    case "build":
      if (v.build === "") next.build = "1";
      else if (/^\d+$/.test(v.build)) next.build = String(Number(v.build) + 1);
      else throw new Error(`构建号 "${v.build}" 不是纯数字，无法自动递增，请手改 tauri.conf.json`);
      break;
    default:
      throw new Error(`未知 bump 级别 "${level}"（可用：major | minor | patch | build）`);
  }
  return next;
}

// ---- 三个文件的读写 --------------------------------------------------------

const tauriConfPath = path.join(root, "src-tauri", "tauri.conf.json");
const pkgPath = path.join(root, "package.json");
const cargoPath = path.join(root, "src-tauri", "Cargo.toml");

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, conf, keepEol) {
  const raw = readFileSync(file, "utf8");
  const eol = keepEol && raw.endsWith("\n") ? "\n" : "";
  writeFileSync(file, JSON.stringify(conf, null, 2) + eol);
}

// Cargo.toml 只替换 [package] 段内第一行 version = "..."，其余（依赖版本）不动
function readCargoVersion() {
  const raw = readFileSync(cargoPath, "utf8");
  const section = raw.slice(raw.indexOf("[package]"));
  const m = /^version\s*=\s*"([^"]*)"/m.exec(section);
  return m ? m[1] : "";
}

function writeCargoVersion(version) {
  const raw = readFileSync(cargoPath, "utf8");
  const at = raw.indexOf("[package]");
  if (at === -1) throw new Error("Cargo.toml 缺少 [package] 段");
  const head = raw.slice(0, at);
  const tail = raw.slice(at);
  if (!/^version\s*=/m.test(tail)) throw new Error("Cargo.toml [package] 段缺少 version 行");
  writeFileSync(cargoPath, head + tail.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`));
}

const targets = [
  {
    name: "package.json",
    read: () => readJson(pkgPath).version ?? "",
    write: (v) => {
      const conf = readJson(pkgPath);
      conf.version = v;
      writeJson(pkgPath, conf, true);
    },
  },
  {
    name: "src-tauri/Cargo.toml",
    read: readCargoVersion,
    write: writeCargoVersion,
  },
];

// ---- 主流程 ----------------------------------------------------------------

// 是否需要在同步后再生 CHANGELOG（major/minor/patch 递增才算内容发版）
let regenChangelog = false;

function targetVersion() {
  const conf = readJson(tauriConfPath);
  if (!conf.version) throw new Error("tauri.conf.json 缺少 version 字段（它是版本号唯一事实源）");
  let v = parseVersion(conf.version);
  if (cmd === "bump") {
    let level = bumpLevel ?? "patch";
    if (level === "auto") {
      const unreleased = splitByRelease(root).find((s) => s.label === null);
      const resolved = autoBumpLevel(unreleased?.commits ?? [], v.major);
      if (!resolved) {
        console.error("✗ 没有未发布的提交（上个发版锚点之后无内容），无法 auto 递增；请显式指定 major|minor|patch|build");
        process.exit(1);
      }
      level = resolved;
      console.log(`auto 判定：未发布提交 → ${level}`);
    }
    const next = bumpVersion(v, level);
    conf.version = fmtVersion(next);
    writeJson(tauriConfPath, conf, true);
    console.log(`✓ src-tauri/tauri.conf.json: ${fmtVersion(v)} → ${fmtVersion(next)}`);
    v = next;
    regenChangelog = level !== "build";
  }
  return fmtVersion(v);
}

const target = targetVersion();
console.log(`事实源 tauri.conf.json → 目标版本 ${target}\n`);

let drifted = false;
for (const t of targets) {
  const current = t.read();
  if (current === target) {
    console.log(`✓ ${t.name} 已是 ${target}`);
    continue;
  }
  if (check) {
    console.error(`✗ ${t.name} = ${current || "<缺失>"}，应为 ${target}`);
    drifted = true;
    continue;
  }
  t.write(target);
  console.log(`✓ ${t.name}: ${current || "<缺失>"} → ${target}`);
}

if (drifted) {
  console.error("\n版本号漂移：运行 pnpm version:sync 校准后重试");
  process.exit(1);
}

if (regenChangelog) {
  writeFileSync(path.join(root, "CHANGELOG.md"), renderChangelog(root));
  console.log("✓ CHANGELOG.md 已写入新版本段（未发布，发版提交后 pnpm changelog 补日期）");
}

console.log(`\n版本统一为 ${target}（Cargo.lock 随下次 cargo build 自动更新）`);
