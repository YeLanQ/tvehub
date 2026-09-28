
import { LAN_THEME } from "../../generated/lan-theme";

/** 偏好设置顶部类别栏：选择类别显示对应配置 */
export const PREFS_CATS: { id: string; label: string }[] = [
  { id: "theme", label: "主题" },
  { id: "project", label: "项目" },
  { id: "about", label: "关于" },
];

/**
 * 主题颜色定义：编辑器可自定义的颜色项。
 * - cssVar 必须是 ui-kit variables.scss 已有的 :root 令牌（主题单一事实源）；
 * - 默认值取构建期生成的 lan-theme（同一份变量表的产物），不手写色值；
 * - key 用于持久化（prefs.json theme_colors）与覆盖应用。
 */
export interface ThemeColorDef {
  key: string;
  label: string;
  cssVar: string;
  defaultValue: string;
}

export const THEME_COLOR_DEFS: ThemeColorDef[] = [
  { key: "bg", label: "背景色", cssVar: "--bg", defaultValue: LAN_THEME.bg },
  { key: "bgPanel", label: "面板背景", cssVar: "--bg-panel", defaultValue: LAN_THEME.bgPanel },
  { key: "text", label: "文本色", cssVar: "--text", defaultValue: LAN_THEME.text },
  { key: "border", label: "边框色", cssVar: "--border", defaultValue: LAN_THEME.border },
  { key: "accent", label: "强调色", cssVar: "--accent", defaultValue: LAN_THEME.accent },
  { key: "bgHover", label: "悬停色", cssVar: "--bg-hover", defaultValue: LAN_THEME.bgHover },
];
