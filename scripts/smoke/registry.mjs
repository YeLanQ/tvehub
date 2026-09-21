// ---------------------------------------------------------------------------
// smoke 套件动态注册：运行时扫描 scripts/smoke/tracker/ 下的 smoke-*.{mjs,ts}，
// 零注册成本——新脚本丢进 tracker/ 即被统一入口发现，无需改 package.json 或任何清单。
//
// kind 由扩展名决定：
// - .mjs → node 直跑（网页运行时冒烟，import public/engine/** 产物）
// - .ts  → vite --ssr 打包后运行（编辑器侧冒烟，import src/** 源码）
// 套件描述取自脚本头部「// ---」注释块的首个内容行。
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./harness.mjs";

export const TRACKER_DIR = join(ROOT, "scripts", "smoke", "tracker");

/**
 * @typedef {Object} SmokeSuite
 * @property {string} id    套件名（文件名去掉 smoke- 前缀与扩展名）
 * @property {string} file  脚本绝对路径
 * @property {"node"|"ssr"} kind
 * @property {string} desc  头部注释首行（套件描述）
 * @property {"P0"|"P1"|"P2"} priority 回归优先级（头部「// @priority P0」标记，缺省 P1）
 */

/** @returns {SmokeSuite[]} */
export function discoverSuites() {
  const suites = [];
  for (const name of readdirSync(TRACKER_DIR).sort()) {
    const m = /^smoke-(.+)\.(mjs|ts)$/.exec(name);
    if (!m) continue;
    const file = join(TRACKER_DIR, name);
    suites.push({
      id: m[1],
      file,
      kind: m[2] === "mjs" ? "node" : "ssr",
      desc: parseDescription(file),
      priority: parsePriority(file),
    });
  }
  return suites;
}

/** 头部注释里的优先级标记（// @priority P0 / P1 / P2；缺省 P1） */
function parsePriority(file) {
  try {
    const head = readFileSync(file, "utf8").split(/\r?\n/).slice(0, 30).join("\n");
    const m = /@priority\s+(P0|P1|P2)/.exec(head);
    return m ? m[1] : "P1";
  } catch {
    return "P1";
  }
}

/** 解析脚本头部注释块，取首个内容行作为套件描述（解析不到则返回空串） */
function parseDescription(file) {
  let head;
  try {
    head = readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const lines = head.split(/\r?\n/).slice(0, 30);
  const content = (line) => line.replace(/^\/\/\s?/, "").trim();

  // 首个「// ---」分隔线之后的第一条非分隔注释行（跳过 @priority 标记行）
  const firstDivider = lines.findIndex((l) => /^\/\/\s?-+/.test(l));
  if (firstDivider >= 0) {
    for (let i = firstDivider + 1; i < lines.length; i++) {
      if (!lines[i].startsWith("//")) break; // 注释块结束
      if (/^\/\/\s?-+/.test(lines[i])) continue; // 块尾分隔线
      if (lines[i].includes("@priority")) continue; // 优先级标记不是描述
      const text = content(lines[i]);
      if (text) return text;
    }
  }
  // 兜底：首条非分隔注释行
  for (const line of lines) {
    if (/^\/\/\s?-+/.test(line)) continue;
    if (/^\/\//.test(line)) {
      const text = content(line);
      if (text) return text;
    }
  }
  return "";
}
