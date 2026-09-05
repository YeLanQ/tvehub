
/** 偏好设置顶部类别栏：选择类别显示对应配置 */
export const PREFS_CATS: { id: string; label: string }[] = [
  { id: "theme", label: "主题" },
  { id: "project", label: "项目" },
  { id: "about", label: "关于" },
];

/** 主题颜色定义：编辑器可自定义的颜色项（默认值数据，可持久化覆盖） */
export interface ThemeColorDef {
  label: string;
  defaultValue: string;
}

export const THEME_COLOR_DEFS: ThemeColorDef[] = [
  { label: "背景色", defaultValue: "#1a1a2e" },
  { label: "面板背景", defaultValue: "#252540" },
  { label: "强调色", defaultValue: "#4aa3ff" },
  { label: "文本色", defaultValue: "#e8e8e8" },
  { label: "边框色", defaultValue: "#3f3f3f" },
  { label: "悬停色", defaultValue: "#2d2d4a" },
];
