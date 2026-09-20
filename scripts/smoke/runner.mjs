#!/usr/bin/env node
// ---------------------------------------------------------------------------
// smoke 统一测试入口 —— 动态注册 + 集中管理 scripts/smoke/tracker/ 下的全部套件。
// 套件无需注册：registry.mjs 运行时扫描 tracker/ 目录，新脚本丢进去即被发现。
//
// 用法：
//   pnpm smoke                    交互菜单（↑↓ 移动，空格勾选，回车运行）
//   pnpm smoke <id> [<id>…]       运行指定套件
//   pnpm smoke --all              全量回归
//   pnpm smoke --filter <关键词>   按名称/描述筛选（支持正则）
//   pnpm smoke --list             列出全部套件
// 选项：--skip-build 复用 ssr 已有产物；--fail-fast 首败即停；-q/--quiet 只看失败与汇总。
//
// 执行模型：顺序运行各套件（子进程），实时转发输出并缓冲，从套件结尾的
// 「结果：X 通过，Y 失败」行（harness.finish() 输出）解析断言数，末尾打印
// 汇总表；任一失败 exit 1。
// ssr 套件（.ts）每套件独立输出目录 .tmp-smoke/<id>/，避免互相覆盖。
// ---------------------------------------------------------------------------
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import readline from "node:readline";
import { basename, dirname, join, resolve } from "node:path";
import { discoverSuites } from "./registry.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");
process.env.TVE_SMOKE_ROOT ??= ROOT;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { all: false, list: false, filter: null, skipBuild: false, failFast: false, quiet: false, help: false, ids: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--all": opts.all = true; break;
      case "--list": opts.list = true; break;
      case "--filter": opts.filter = argv[++i] ?? ""; break;
      case "--skip-build": opts.skipBuild = true; break;
      case "--fail-fast": opts.failFast = true; break;
      case "-q": case "--quiet": opts.quiet = true; break;
      case "-h": case "--help": opts.help = true; break;
      default:
        if (a.startsWith("--")) {
          console.error(`未知参数：${a}（pnpm smoke --help 查看用法）`);
          process.exit(2);
        }
        opts.ids.push(a);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`smoke 统一测试入口（套件由 scripts/smoke/tracker/smoke-*.{mjs,ts} 动态发现）

用法：pnpm smoke [id…] [选项]

  id…            运行指定套件（pnpm smoke --list 查看全部）
  --all          全量回归
  --filter <词>  按名称/描述筛选（支持正则）
  --list         列出全部套件
  --skip-build   ssr 套件复用 .tmp-smoke/<id>/ 已有产物，跳过 vite 构建
  --fail-fast    首个失败即停
  -q, --quiet    只输出失败详情与汇总

无参数且为交互终端时弹出多选菜单。`);
}

// ---------------------------------------------------------------------------
// 选择
// ---------------------------------------------------------------------------
function selectSuites(suites, opts) {
  const byId = new Map(suites.map((s) => [s.id, s]));
  const picked = new Set();
  for (const id of opts.ids) {
    if (!byId.has(id)) {
      console.error(`未找到套件「${id}」。pnpm smoke --list 查看全部。\n相近套件：${suggest(suites, id)}`);
      process.exit(2);
    }
    picked.add(id);
  }
  if (opts.filter) {
    let re = null;
    try {
      re = new RegExp(opts.filter, "i");
    } catch {
      /* 非法正则退化为子串匹配 */
    }
    for (const s of suites) {
      const hit = re ? re.test(s.id) || re.test(s.desc) : s.id.toLowerCase().includes(opts.filter.toLowerCase()) || s.desc.toLowerCase().includes(opts.filter.toLowerCase());
      if (hit) picked.add(s.id);
    }
  }
  if (opts.all) for (const s of suites) picked.add(s.id);
  return suites.filter((s) => picked.has(s.id)); // 保持发现顺序
}

function suggest(suites, id) {
  const kw = id.toLowerCase();
  const near = suites.filter((s) => s.id.toLowerCase().includes(kw) || kw.includes(s.id.toLowerCase().split("-")[0])).slice(0, 5);
  return near.length ? near.map((s) => s.id).join("、") : "无";
}

function printList(suites) {
  for (const s of suites) {
    console.log(`  ${s.id.padEnd(22)} ${s.kind.padEnd(5)} ${s.desc}`);
  }
}

// ---------------------------------------------------------------------------
// 交互菜单（零依赖：readline keypress 多选）
// ---------------------------------------------------------------------------
async function pickInteractively(suites) {
  if (!suites.length) return [];
  console.log(`smoke 套件菜单（共 ${suites.length} 项）—— ↑↓ 移动 · 空格勾选 · a 全选/清空 · 回车运行 · q 退出`);
  const checked = suites.map(() => false);
  checked[0] = true;
  let cursor = 0;
  let lastLines = 0;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?25l"); // 隐藏光标

  const width = () => process.stdout.columns ?? 100;
  function frame() {
    const lines = [`  已选 ${checked.filter(Boolean).length}/${suites.length}`];
    const H = Math.min(14, suites.length);
    const start = Math.max(0, Math.min(cursor - (H >> 1), suites.length - H));
    for (let i = start; i < start + H && i < suites.length; i++) {
      const s = suites[i];
      const pointer = i === cursor ? "❯" : " ";
      const box = checked[i] ? "◉" : "○";
      const descMax = Math.max(12, width() - 40);
      const desc = s.desc.length > descMax ? `${s.desc.slice(0, descMax)}…` : s.desc;
      lines.push(`${pointer} ${box} ${s.id.padEnd(22)} ${s.kind.padEnd(4)} ${desc}`);
    }
    return lines.join("\n");
  }
  function draw() {
    const f = frame();
    if (lastLines > 0) process.stdout.write(`\x1b[${lastLines}A`);
    process.stdout.write(`${f.split("\n").map((l) => `${l}\x1b[0K`).join("\n")}\n`);
    lastLines = f.split("\n").length;
  }

  return await new Promise((resolveP) => {
    function cleanup() {
      process.stdin.removeListener("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h"); // 恢复光标
      if (lastLines > 0) process.stdout.write(`\x1b[${lastLines}A\x1b[J`); // 清掉菜单帧
    }
    function onKey(str, key) {
      if (key.ctrl && key.name === "c") {
        cleanup();
        resolveP(null);
        return;
      }
      switch (key.name) {
        case "up": cursor = Math.max(0, cursor - 1); break;
        case "down": cursor = Math.min(suites.length - 1, cursor + 1); break;
        case "space": checked[cursor] = !checked[cursor]; break;
        case "a": {
          const on = !checked.every(Boolean);
          for (let i = 0; i < checked.length; i++) checked[i] = on;
          break;
        }
        case "return": case "enter": {
          cleanup();
          const sel = suites.filter((_, i) => checked[i]);
          resolveP(sel.length ? sel : null);
          return;
        }
        case "escape": case "q":
          cleanup();
          resolveP(null);
          return;
        default:
          return;
      }
      draw();
    }
    process.stdin.on("keypress", onKey);
    draw();
  });
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------
const tail = (text, n = 20) => {
  const lines = String(text).trimEnd().split(/\r?\n/);
  return lines.slice(-n).join("\n");
};

/** spawn 并捕获输出：非 quiet 实时转发，同时保留尾部缓冲供失败详情/断言解析 */
function spawnCapture(cmd, args, { quiet }) {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: process.env, windowsHide: true });
    let output = "";
    const cap = 256 * 1024;
    const on = (chunk) => {
      output += chunk;
      if (output.length > cap) output = output.slice(-cap);
      if (!quiet) process.stdout.write(chunk);
    };
    child.stdout.on("data", on);
    child.stderr.on("data", on);
    child.on("error", (e) => resolveP({ code: -1, output: `${output}\n${e?.message ?? e}` }));
    child.on("close", (code) => resolveP({ code: code ?? -1, output }));
  });
}

let _viteBin;
function viteBinPath() {
  if (!_viteBin) {
    const req = createRequire(join(ROOT, "package.json"));
    _viteBin = join(dirname(req.resolve("vite/package.json")), "bin", "vite.js");
  }
  return _viteBin;
}

function resolveBundle(outDir, expected) {
  if (existsSync(expected)) return expected;
  if (!existsSync(outDir)) return null;
  const js = readdirSync(outDir).filter((f) => f.endsWith(".js"));
  return js.length === 1 ? join(outDir, js[0]) : null;
}

async function runNode(suite, opts) {
  return await spawnCapture(process.execPath, [suite.file], { quiet: opts.quiet });
}

async function runSsr(suite, opts) {
  const outDir = join(ROOT, ".tmp-smoke", suite.id);
  const expected = join(outDir, basename(suite.file).replace(/\.ts$/, ".js"));
  let bundle = resolveBundle(outDir, expected);
  if (!opts.skipBuild || !bundle) {
    const b = await spawnCapture(
      process.execPath,
      [viteBinPath(), "build", "--ssr", suite.file, "--outDir", outDir, "--emptyOutDir"],
      { quiet: opts.quiet },
    );
    if (b.code !== 0) {
      return { code: b.code, output: `${b.output}\n[vite 构建失败]\n${tail(b.output)}` };
    }
    bundle = resolveBundle(outDir, expected);
    if (!bundle) return { code: -1, output: "[构建产物缺失]" };
  }
  return await spawnCapture(process.execPath, [bundle], { quiet: opts.quiet });
}

async function runSuite(suite, opts) {
  const t0 = performance.now();
  const r = suite.kind === "node" ? await runNode(suite, opts) : await runSsr(suite, opts);
  const ms = performance.now() - t0;
  const m = /结果[：:]\s*(\d+)\s*通过[，,]\s*(\d+)\s*失败/.exec(r.output);
  return {
    suite,
    ok: r.code === 0,
    code: r.code,
    passed: m ? Number(m[1]) : null,
    failed: m ? Number(m[2]) : null,
    ms,
    output: r.output,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const suites = discoverSuites();

  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.list) {
    console.log(`\nsmoke 套件（${suites.length} 个，scripts/smoke/tracker/ 下动态发现）：\n`);
    printList(suites);
    console.log(`\n运行：pnpm smoke <id>… | --all | --filter <关键词>；无参数（交互终端）弹菜单。`);
    return;
  }

  let selected;
  if (opts.ids.length || opts.filter || opts.all) {
    selected = selectSuites(suites, opts);
  } else if (process.stdin.isTTY) {
    selected = await pickInteractively(suites);
    if (!selected) {
      console.log("已取消。");
      return;
    }
  } else {
    console.log(`未指定套件。当前注册 ${suites.length} 个：\n`);
    printList(suites);
    console.log(`\n运行：pnpm smoke <id>… | --all | --filter <关键词>。`);
    return;
  }

  if (!selected.length) {
    console.log("没有匹配的套件。");
    process.exitCode = 2;
    return;
  }

  console.log(`\n▶ 运行 ${selected.length} 个套件（顺序执行）`);
  const results = [];
  for (const s of selected) {
    if (!opts.quiet) console.log(`\n${"━".repeat(60)}\n▶ ${s.id} [${s.kind}]${s.desc ? ` — ${s.desc}` : ""}`);
    const r = await runSuite(s, opts);
    results.push(r);
    if (!opts.quiet) {
      const counts = r.passed !== null ? `${r.passed} 通过 / ${r.failed} 失败` : "断言数未知";
      console.log(`${r.ok ? "✔" : "✘"} ${s.id} · ${counts} · ${(r.ms / 1000).toFixed(1)}s`);
    }
    if (!r.ok && opts.failFast) break;
  }

  const bad = results.filter((r) => !r.ok);
  const notRun = selected.length - results.length;
  const asserts = results.reduce((n, r) => n + (r.passed ?? 0), 0);
  const totalMs = results.reduce((n, r) => n + r.ms, 0);

  console.log(`\n${"━".repeat(60)}\n smoke 汇总\n${"━".repeat(60)}`);
  for (const r of results) {
    const counts = r.passed !== null ? `${r.passed} 通过${r.failed ? `，${r.failed} 失败` : ""}` : "—";
    console.log(` ${r.ok ? "✔" : "✘"} ${r.suite.id.padEnd(22)} ${r.suite.kind.padEnd(5)} ${counts} · ${(r.ms / 1000).toFixed(1)}s`);
  }
  if (opts.quiet) {
    for (const r of bad) console.log(`\n✘ ${r.suite.id} 输出尾部：\n${tail(r.output, 25)}`);
  }
  console.log(
    `\n共 ${results.length} 套件：${results.length - bad.length} 通过 / ${bad.length} 失败` +
      `${notRun ? `（未运行 ${notRun}）` : ""} · 断言合计 ${asserts} 项 · 总耗时 ${(totalMs / 1000).toFixed(1)}s`,
  );
  if (bad.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("smoke 入口异常:", e);
  process.exit(1);
});
