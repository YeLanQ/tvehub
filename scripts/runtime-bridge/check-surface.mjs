// 漂移守卫：扫描统一运行时源码（src/runtime/** + public/web-preview/player.mjs）
// 对浏览器全局的消费面，对照桥接层覆盖清单 + surface-baseline.json 台账。
// 引擎新增未覆盖的全局用法 → 本检查失败，构建链阻断——把「设备上发现漂移」
// 变成「构建时发现漂移」。
//
// 用法：node scripts/runtime-bridge/check-surface.mjs [--update-baseline]
//   --update-baseline  把当前未覆盖集写入台账（首次收录/有意接受时使用，需带理由复核）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GLOBAL_SURFACE } from "./contract.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASELINE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "surface-baseline.json");

/** 扫描目标：统一运行时的全部源码（渠道无关；构建产物由它生成） */
function listSources() {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(child);
    }
  };
  walk("src/runtime");
  const player = "public/web-preview/player.mjs";
  if (fs.existsSync(path.join(ROOT, player))) out.push(player);
  return out.sort();
}

/** 剥注释（行注释 + 块注释），降低误报 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** document./window. 成员覆盖清单（桥接核心安装的形态，见 dom.js/env.js） */
const DOCUMENT_COVERED = new Set([
  "getElementById", "createElement", "createElementNS", "createTextNode", "createDocumentFragment",
  "querySelector", "querySelectorAll", "addEventListener", "removeEventListener", "dispatchEvent",
  "documentElement", "body", "head", "hidden", "visibilityState", "baseURI", "documentURI",
]);
const WINDOW_COVERED = new Set([
  "innerWidth", "innerHeight", "devicePixelRatio",
  "addEventListener", "removeEventListener", "dispatchEvent", "postMessage",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame",
  "focus", "open", "getComputedStyle", "matchMedia", "location",
  "AudioContext", "webkitAudioContext", "fetch", "localStorage",
  "parent", "self", "top", "__TVE_BUILD_DATA",
]);
/** 自由标识符覆盖清单 = GLOBAL_SURFACE（桥接核心安装的全局名） */
const FREE_COVERED = new Set(GLOBAL_SURFACE);
/** 额外监视的自由全局（不在 GLOBAL_SURFACE——未安装，出现即需台账/决策） */
const FREE_WATCHLIST = [
  ...GLOBAL_SURFACE,
  "Worker", "SharedWorker", "XMLHttpRequest", "WebSocket",
  "IntersectionObserver", "ResizeObserver", "MutationObserver",
  "getComputedStyle", "matchMedia", "WebAssembly", "webkitAudioContext",
  "OffscreenCanvas", "CustomEvent", "Event", "DOMParser", "FormData",
  "HTMLElement", "HTMLCanvasElement", "CSS", "crypto", "history",
];

function scan() {
  const findings = new Map(); // key → { file, line }
  const record = (key, file, idx) => {
    if (findings.has(key)) return;
    const line = idx >= 0 ? file.text.slice(0, idx).split("\n").length : 0;
    findings.set(key, { file: file.rel, line });
  };
  for (const rel of listSources()) {
    const abs = path.join(ROOT, rel);
    const text = stripComments(fs.readFileSync(abs, "utf8"));
    const file = { rel, text };
    for (const m of text.matchAll(/(?<![\w$.])document\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
      if (!DOCUMENT_COVERED.has(m[1])) record(`document.${m[1]}`, file, m.index);
    }
    for (const m of text.matchAll(/(?<![\w$.])window\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
      // window.__tve* = 引擎自写标记（pak 安装垫片等），非浏览器 API 消费面
      if (!WINDOW_COVERED.has(m[1]) && !m[1].startsWith("__tve")) record(`window.${m[1]}`, file, m.index);
    }
    for (const name of FREE_WATCHLIST) {
      if (FREE_COVERED.has(name)) continue;
      const re = new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, "g");
      for (const m of text.matchAll(re)) record(`global:${name}`, file, m.index);
    }
  }
  return findings;
}

function main() {
  const updateBaseline = process.argv.includes("--update-baseline");
  const findings = scan();
  const baseline = fs.existsSync(BASELINE_PATH)
    ? JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"))
    : {};

  const uncovered = [...findings.keys()].filter((k) => !(k in baseline));
  if (updateBaseline) {
    const next = { ...baseline };
    for (const k of uncovered.sort()) next[k] = "（待补充理由）";
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`[surface-check] 台账已更新：${uncovered.length} 项新收录（请逐项补理由后提交）`);
    return;
  }

  console.log(`[surface-check] 扫描统一运行时源码：发现全局用法 ${findings.size} 类，台账接受 ${Object.keys(baseline).length} 项`);
  const stale = Object.keys(baseline).filter((k) => !findings.has(k));
  for (const k of stale) console.log(`  （台账项已无对应用法，可清理）: ${k}`);

  if (uncovered.length) {
    console.error(`[surface-check] 发现 ${uncovered.length} 类未覆盖的全局用法（桥接层未垫/未入台账）：`);
    for (const k of uncovered.sort()) {
      const at = findings.get(k);
      console.error(`  ✗ ${k}  首现于 ${at.file}:${at.line}`);
    }
    console.error(`  处置：在 scripts/runtime-bridge/ 核心扩展覆盖（未来所有平台继承），`);
    console.error(`  或确认无需覆盖后加入 surface-baseline.json（--update-baseline 后补理由）。`);
    process.exit(1);
  }
  console.log("[surface-check] 通过：运行时全局消费面全部被桥接层覆盖或已入台账");
}

main();
