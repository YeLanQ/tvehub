// ---------------------------------------------------------------------------
// 质量规则 · 重复代码：规范化（去空白/去注释）后按 8 行滑动窗哈希，同窗在
// ≥2 处出现（跨文件或同文件远距离）合并为重复块；块 ≥16 行才报（major），
// 8~15 行报 minor。只扫实现代码（ts/vue script/rs），spec/generated 不进面。
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { makeFinding } from "../lib/finding.mjs";
import { vueScriptOf } from "../lib/collect.mjs";

const WIN = 8;

function normalize(lines) {
  return lines
    .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "").trim())
    .filter((l) => l.length > 0 && l !== "{" && l !== "}" && l !== ");" && !/^[)};,.]+$/.test(l));
}

export function scanDuplication(files) {
  const targets = files
    .filter((f) => ["ts", "rs"].includes(f.kind) || (f.kind === "vue" && vueScriptOf(f).trim()))
    .map((f) => ({
      rel: f.rel,
      norm: normalize(f.kind === "vue" ? vueScriptOf(f).split(/\r?\n/) : f.lines),
    }));

  // 窗哈希 → 出现位置列表
  const windows = new Map();
  for (const t of targets) {
    for (let i = 0; i + WIN <= t.norm.length; i++) {
      const h = createHash("sha1").update(t.norm.slice(i, i + WIN).join("\n")).digest("hex").slice(0, 12);
      const list = windows.get(h) ?? [];
      if (list.length < 4) list.push({ rel: t.rel, idx: i });
      windows.set(h, list);
    }
  }

  // 只保留出现 ≥2 次的窗，按 (fileA,fileB) 对聚合连续 idx → 块
  const dupWindows = [...windows.entries()].filter(([, l]) => l.length >= 2);
  const blocks = []; // { a, b, aIdx, bIdx, len }
  for (const [, locs] of dupWindows) {
    for (let x = 0; x < locs.length; x++) {
      for (let y = x + 1; y < locs.length; y++) {
        const A = locs[x];
        const B = locs[y];
        if (A.rel === B.rel && Math.abs(A.idx - B.idx) < WIN * 2) continue; // 同文件近邻不算
        blocks.push({ a: A.rel, b: B.rel, aIdx: A.idx, bIdx: B.idx, len: WIN });
      }
    }
  }
  blocks.sort((p, q) => p.aIdx - q.aIdx || p.bIdx - q.bIdx);

  // 合并可延伸的块（两窗位置同时 +1 即延伸）
  const merged = [];
  for (const blk of blocks) {
    const prev = merged[merged.length - 1];
    if (prev && prev.a === blk.a && prev.b === blk.b && prev.aIdx + 1 === blk.aIdx && prev.bIdx + 1 === blk.bIdx) {
      prev.len += 1;
    } else {
      merged.push({ ...blk });
    }
  }

  const out = [];
  const seen = new Set();
  for (const blk of merged) {
    if (blk.len < WIN + 4) continue; // <12 行不报
    const key = [blk.a, blk.b, Math.floor(blk.aIdx / 40), Math.floor(blk.bIdx / 40)].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const relA = targets.find((t) => t.rel === blk.a);
    const snippet = relA ? relA.norm.slice(blk.aIdx, blk.aIdx + 3).join("\n") : "";
    const severity = blk.len >= 24 ? "major" : "minor";
    out.push(makeFinding({
      rule: "quality.duplication", dimension: "quality", category: "重复代码", severity,
      file: blk.a, line: 1, snippet,
      message: `重复块 ~${blk.len} 行：与 ${blk.b} 的规范序列高度重复（滑动窗启发式，行号为规范化后序号，请按片段内容定位）`,
      fix: "抽公共函数/常量模块；跨文件重复优先下沉到 lib",
    }));
  }
  return out;
}
