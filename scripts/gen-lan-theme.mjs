// ---------------------------------------------------------------------------
// 局域网主题令牌生成器（单一事实来源：ui-kit 的主题变量表）。
//
// 局域网共享有两类渲染面，各自拿不到对方的环境：
// - 应用内（Vue + SCSS）：直接用主题的 CSS 变量（var(--bg-panel) 等）；
// - 对外页面（白板放映页 / 共享索引页 / 口令解锁页）：在手机浏览器里跑，拿不到
//   应用的样式表，必须把颜色内联进产物。
// 后者的值若各自硬编码，就会与主题悄悄分叉（本项目已经发生过：局域网样式自造了
// --panel-bg/--input-bg 这类不存在的变量名，于是永远走兜底色）。
//
// 于是把 variables.scss 的 :root 当唯一事实源：
// - 前端：本脚本生成 src/generated/lan-theme.ts，放映页据此拼内联样式；
// - Rust：src-tauri/build.rs 用同一份 SCSS 生成常量（见该文件），服务端页面据此拼 CSS。
// 两处都只「读」主题，不再自持一份色板。
//
// 两处调用（与其它生成器一致，保证任何入口都拿到最新值）：
// - vite.config.ts 的索引插件：dev 启动 / 构建 / 主题文件变化时重建；
// - package.json 的 build 脚本：在 vue-tsc 之前生成（干净检出时生成文件不存在）。
//
// 用法（直接执行）：node scripts/gen-lan-theme.mjs
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根（本脚本位于 <root>/scripts/） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 主题单一事实源（vite 插件据此挂文件监听） */
export const THEME_SOURCE = "src/ui-kit/styles/variables.scss";

/** 生成目标（相对项目根） */
export const LAN_THEME_PATH = "src/generated/lan-theme.ts";

/**
 * 局域网各渲染面需要的令牌及其语义名。
 * 键 = 主题里的 CSS 变量名（原样取用），值 = 生成代码里的语义字段名。
 * 只列真正用到的：多取一个就多一处可能失效的映射。
 */
const TOKENS = {
  "--bg": "bg",
  "--bg-panel": "bgPanel",
  "--bg-panel-2": "bgPanel2",
  "--bg-hover": "bgHover",
  "--bg-input": "bgInput",
  "--border": "border",
  "--text": "text",
  "--text-dim": "textDim",
  "--accent": "accent",
  "--ok": "ok",
  "--warn": "warn",
  "--err": "err",
};

/**
 * 解析 SCSS 里的 `:root { --name: value; }`。
 * 只认「变量: 值;」这种形态（本项目主题表就是这个形态），不做通用 SCSS 解析；
 * 认不出的变量直接忽略，但 TOKENS 里要求的令牌缺失会抛错——宁可构建失败，
 * 也不要生成一份缺色的页面。
 */
export function parseThemeTokens(scssText) {
  const rootBlock = scssText.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!rootBlock) throw new Error(`[lan-theme] 未在 ${THEME_SOURCE} 中找到 :root 块`);
  const tokens = {};
  for (const line of rootBlock[1].split("\n")) {
    const hit = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i);
    if (hit) tokens[hit[1]] = hit[2].trim();
  }
  const missing = Object.keys(TOKENS).filter((name) => !tokens[name]);
  if (missing.length) {
    throw new Error(
      `[lan-theme] 主题缺少局域网需要的令牌: ${missing.join(" ")}（在 ${THEME_SOURCE} 的 :root 里补上，或从 TOKENS 里去掉不再用的）`,
    );
  }
  return tokens;
}

/** 读取并解析主题（供生成器与校验脚本共用） */
export function readThemeTokens() {
  const abs = path.join(ROOT, THEME_SOURCE);
  if (!fs.existsSync(abs)) throw new Error(`[lan-theme] 主题文件不存在: ${THEME_SOURCE}`);
  return parseThemeTokens(fs.readFileSync(abs, "utf8"));
}

/** 按语义名取值：`{ bg: "#141414", bgPanel: "#1c1c1c", ... }` */
export function themeValues() {
  const tokens = readThemeTokens();
  const out = {};
  for (const [cssName, field] of Object.entries(TOKENS)) out[field] = tokens[cssName];
  return out;
}

/** 生成 TS 模块源码 */
function renderTs(values) {
  const fields = Object.entries(values)
    .map(([field, value]) => `  ${field}: ${JSON.stringify(value)},`)
    .join("\n");
  return `// 本文件由 scripts/gen-lan-theme.mjs 生成，请勿手改。
// 事实源：${THEME_SOURCE}（ui-kit 主题变量表）。改主题后重跑生成器：
//   node scripts/gen-lan-theme.mjs   （pnpm build 与 dev 启动也会自动重建）
//
// 用途：对外页面（白板放映页等）在手机浏览器里跑，拿不到应用样式表，
// 需要把主题颜色内联进产物——这里就是那批颜色的唯一出处。

/** 局域网对外页面用到的主题色（语义名与主题令牌一一对应） */
export const LAN_THEME = {
${fields}
} as const;

export type LanTheme = typeof LAN_THEME;

/**
 * 生成一组 CSS 自定义属性声明（供内联 <style> 使用）。
 * prefix 默认 \`--tv\`（放映页自己的命名空间）：页面 CSS 里写 var(--tv-accent)，
 * 值随主题走，不必在样式里散落十六进制色值。
 */
export function lanCssVars(prefix = "--tv"): string {
  const theme = LAN_THEME as Record<string, string>;
  const varOf = {
    bg: "bg",
    bgPanel: "panel",
    bgPanel2: "panel-2",
    bgHover: "hover",
    bgInput: "input",
    border: "border",
    text: "text",
    textDim: "text-dim",
    accent: "accent",
    ok: "ok",
    warn: "warn",
    err: "err",
  } as const;
  return Object.entries(varOf)
    .map(([field, suffix]) => \`  \${prefix}-\${suffix}: \${theme[field]};\`)
    .join("\\n");
}
`;
}

/** 生成（幂等：内容不变则不落盘，避免无谓的 HMR 事件） */
export function generateLanTheme() {
  const values = themeValues();
  const abs = path.join(ROOT, LAN_THEME_PATH);
  const text = renderTs(values);
  let prev = null;
  try {
    prev = fs.readFileSync(abs, "utf8");
  } catch {
    /* 首次生成 */
  }
  if (prev === text) return false;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  console.log(`[lan-theme] 已生成 ${LAN_THEME_PATH}（来源 ${THEME_SOURCE}）`);
  return true;
}

// 直接执行时生成一次
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  generateLanTheme();
}
