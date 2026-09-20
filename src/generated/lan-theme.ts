// 本文件由 scripts/gen-lan-theme.mjs 生成，请勿手改。
// 事实源：src/ui-kit/styles/variables.scss（ui-kit 主题变量表）。改主题后重跑生成器：
//   node scripts/gen-lan-theme.mjs   （pnpm build 与 dev 启动也会自动重建）
//
// 用途：对外页面（白板放映页等）在手机浏览器里跑，拿不到应用样式表，
// 需要把主题颜色内联进产物——这里就是那批颜色的唯一出处。

/** 局域网对外页面用到的主题色（语义名与主题令牌一一对应） */
export const LAN_THEME = {
  bg: "#141414",
  bgPanel: "#1c1c1c",
  bgPanel2: "#212121",
  bgHover: "#292929",
  bgInput: "#1a1a1a",
  border: "#3f3f3f",
  text: "#d2d2d2",
  textDim: "#949494",
  accent: "#757575",
  ok: "#5fb05f",
  warn: "#d9a13b",
  err: "#dc6b6b",
} as const;

export type LanTheme = typeof LAN_THEME;

/**
 * 生成一组 CSS 自定义属性声明（供内联 <style> 使用）。
 * prefix 默认 `--tv`（放映页自己的命名空间）：页面 CSS 里写 var(--tv-accent)，
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
    .map(([field, suffix]) => `  ${prefix}-${suffix}: ${theme[field]};`)
    .join("\n");
}
