// ---------------------------------------------------------------------------
// 场景图窗口停靠系统实例（编辑器 app/docks 同构）：面板集为图窗口六面板
// （层级/检查器/变量/自定义/场景/控制台），布局经后端 UI 状态 KV 持久化（键与
// 编辑器隔离，互不串布局）；通用逻辑在 src/docks/create-docks（页签拖拽/浮动/
// 尺寸约束/持久化装载，创建即装载已保存布局）。
// 控制台与编辑器同源（ConsolePanel + logStore）：预览运行时经 postLog 转发的
// 引擎日志（装配摘要/驱动器采样/告警）实时落在这里。
// ---------------------------------------------------------------------------
import { createDockSystem } from "../docks/create-docks";

export type GraphDockPanelId = "hierarchy" | "inspector" | "assets" | "variables" | "customNodes" | "console";

export const GRAPH_ALL_PANELS: GraphDockPanelId[] = [
  "hierarchy",
  "inspector",
  "variables",
  "customNodes",
  "assets",
  "console",
];

export const GRAPH_DOCK_PANEL_LABEL: Record<GraphDockPanelId, string> = {
  hierarchy: "层级",
  inspector: "检查器",
  variables: "变量",
  customNodes: "自定义",
  // 资产面板在图窗口只呈现场景（面板名随之收敛为「场景」）
  assets: "场景",
  console: "控制台",
};

export const graphDocks = createDockSystem<GraphDockPanelId>({
  panels: GRAPH_ALL_PANELS,
  labels: GRAPH_DOCK_PANEL_LABEL,
  // v2：面板集新增「控制台」（与场景面板并排于底部停靠区）。升版使旧布局
  // （控制台曾按旧兜底落位左区）一次性重置为新默认；v1 布局不再读取。
  storageKey: "tve:graph:dock-layout:v2",
  defaults: () => ({
    zones: { left: ["hierarchy"], right: ["inspector", "variables", "customNodes"], bottom: ["console", "assets"] },
    active: { left: "hierarchy", right: "inspector", bottom: "console" },
    floating: [],
    sizes: { left: 270, right: 300, bottom: 240 },
  }),
});
