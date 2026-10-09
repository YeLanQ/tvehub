// 分层守卫（构建前执行：node scripts/check-layers.mjs）。
//
// 规则一（Tauri IPC）：全仓只有 src/lib/ 允许直接 import @tauri-apps/api/core。
// 组件 / store / app-lib 的 IPC 调用必须经 lib/api.ts、lib/scene-api.ts 门面。
//
// 规则二（渲染后端解耦）：three（裸 "three" / "three/webgpu" / examples /
// vendored three.*.min.js）只允许出现在 src/engine/{rhi,rpi}/backends/ 与
// 台账 scripts/layers-three-allowlist.json 中的存量文件——新增文件一律不得
// 直接依赖渲染库，请走 RHI/RPI 抽象（src/engine）。台账只减不增（重构迁移
// 完成后从台账移除）；批量迁移时用 --update-three-allowlist 重建。
//
// 规则三（engine 层方向）：src/engine 是最底层抽象——不得 import
// framework/app/runtime/UI 层，不得依赖 vue/tauri；依赖只允许向下
// （rpi → rhi；rhi 不得反向引用 rpi）。
//
// 扫描范围：src/ 全量 + runtime/bridge（web/微信渠道桥接）+
// public/web-preview（播放组合根 player.mjs）。构建链脚本（runtime/scripts）
// 与构建产物（public/engine、public/exports/wechat/runtime）不入扫描——
// 前者以 three 说明符为加工数据，后者由台账源码再生。

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
// 渠道运行时面与 src 同规则三类扫描（web/微信渠道不得越层依赖渲染库/IPC）：
// runtime/bridge（渠道桥接，随包进产物）+ public/web-preview（播放组合根）。
// runtime/scripts（构建链）不扫——改写器/打包器以 three 说明符为加工数据，
// 字符串字面量必然命中，属设计内误报；其产物由台账源码再生。
const scanRoots = [srcDir, join(root, "runtime", "bridge"), join(root, "public", "web-preview")];
const coreRef = /@tauri-apps\/api\/core/;
const allowlistPath = join(root, "scripts", "layers-three-allowlist.json");
const updateAllowlist = process.argv.includes("--update-three-allowlist");

const toPosix = (p) => p.split(sep).join("/");
const relToRoot = (file) => toPosix(file.slice(root.length + 1));

/** 解析 src 内文件的相对 import（返回仓库相对路径；裸说明符/不可解析返回 null） */
function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(cand) && statSync(cand).isFile()) return relToRoot(cand);
  }
  return null;
}

/** 该行是否引用 three（裸说明符或 vendored 构建；注释行不算） */
function threeSpecifier(line) {
  if (line.trim().startsWith("//")) return false;
  const m = line.match(/(?:from|import\()\s*["']([^"']+)["']/);
  if (!m) return false;
  const spec = m[1];
  return /^three(\/|$)/.test(spec) || /three\.(module|webgpu|core)\.min\.js$/.test(spec);
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx|js|mjs|vue)$/.test(name)) {
      yield full;
    }
  }
}

/** src/lib 下允许直接使用 core（数据层门面本身） */
function isDataLayer(rel) {
  return rel.startsWith("src/lib/") || rel === "src/lib";
}

function isRHIBackend(rel) {
  return rel.startsWith("src/engine/rhi/backends/");
}

function isRPIBackend(rel) {
  return rel.startsWith("src/engine/rpi/backends/");
}

/** 规则三：engine 层的依赖方向（rhi=0 / rpi=1；只准向下） */
function engineLayerRank(rel) {
  if (rel.startsWith("src/engine/rhi/")) return 0;
  if (rel.startsWith("src/engine/rpi/")) return 1;
  return -1;
}

function checkEngineDirection(rel, spec, fromFile) {
  const bannedBare = /^(vue|@vue|@tauri-apps|monaco-editor)(\/|$)/;
  if (bannedBare.test(spec)) return `engine 层不得依赖 UI/宿主包：${spec}`;
  const target = resolveSpecifier(fromFile, spec);
  if (!target) return null;
  if (target.startsWith("src/engine/") || target.startsWith("src/platform_abstraction/")) {
    const fromRank = engineLayerRank(rel);
    const toRank = engineLayerRank(target);
    if (fromRank === 0 && toRank === 1) return `RHI 不得反向依赖 RPI：→ ${target}`;
    return null;
  }
  return `engine 层不得依赖上层模块：→ ${target}`;
}

// ---- 扫描（先收集全部事实，再按台账裁决） ----
const tauriViolations = [];
const threeViolations = [];
const directionViolations = [];
const threeFiles = new Set();

for (const scanDir of scanRoots) {
  if (!existsSync(scanDir)) continue;
  for (const file of walk(scanDir)) {
    const rel = relToRoot(file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((ln, i) => {
      const at = `${rel}:${i + 1}`;
      if (coreRef.test(ln) && !ln.trim().startsWith("//") && !isDataLayer(rel)) {
        tauriViolations.push(`${at} 直接引用 @tauri-apps/api/core（只允许 src/lib/，改用 lib/api.ts 门面）`);
      }
      if (threeSpecifier(ln)) {
        if (!isRHIBackend(rel) && !isRPIBackend(rel)) threeViolations.push(`${at} 直接引用 three（只允许 engine/*/backends/ 与台账存量，新代码走 RHI/RPI）`);
        threeFiles.add(rel);
      }
      if (rel.startsWith("src/engine/")) {
        const specMatch = ln.match(/(?:from|import\()\s*["']([^"']+)["']/);
        if (specMatch && !ln.trim().startsWith("//")) {
          const problem = checkEngineDirection(rel, specMatch[1], file);
          if (problem) directionViolations.push(`${at} ${problem}`);
        }
      }
    });
  }
}

// ---- 台账 ----
let allowlist = new Set();
if (existsSync(allowlistPath)) {
  const { files } = JSON.parse(readFileSync(allowlistPath, "utf8"));
  allowlist = new Set(files);
}
if (updateAllowlist) {
  const files = [...threeFiles].filter((rel) => !isRHIBackend(rel) && !isRPIBackend(rel)).sort();
  writeFileSync(allowlistPath, JSON.stringify({ files }, null, 2) + "\n");
  console.log(`[check-layers] three 存量台账已重建：${files.length} 项 → scripts/layers-three-allowlist.json`);
  allowlist = new Set(files);
}
const threeOutsideLedger = threeViolations.filter((v) => !allowlist.has(v.split(":")[0]));

// ---- 裁决 ----
const violations = [...tauriViolations, ...threeOutsideLedger, ...directionViolations];
if (violations.length) {
  console.error(`[check-layers] 分层守卫失败（${violations.length} 处）：\n  ${violations.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `[check-layers] 通过（src + runtime/bridge + public/web-preview）：@tauri-apps/api/core 仅限 src/lib；three 仅限 engine/*/backends 与 ${allowlist.size} 项存量台账；engine 层无反向依赖`,
);
