// ---------------------------------------------------------------------------
// 脚本图窗口停靠系统实例（编辑器 app/docks 同构）：面板集为图窗口五面板
// （层级/检查器/变量/自定义/资产），布局经后端 UI 状态 KV 持久化（键与编辑器
// 隔离，互不串布局）；通用逻辑在 src/docks/create-docks（页签拖拽/浮动/
// 尺寸约束/持久化装载，创建即装载已保存布局）。
// ---------------------------------------------------------------------------
import { createDockSystem } from "../docks/create-docks";

export type GraphDockPanelId = "hierarchy" | "inspector" | "assets" | "variables" | "customNodes";

export const GRAPH_ALL_PANELS: GraphDockPanelId[] = [
  "hierarchy",
  "inspector",
  "variables",
  "customNodes",
  "assets",
];

export const GRAPH_DOCK_PANEL_LABEL: Record<GraphDockPanelId, string> = {
  hierarchy: "层级",
  inspector: "检查器",
  variables: "变量",
  customNodes: "自定义",
  assets: "资产",
};

export const graphDocks = createDockSystem<GraphDockPanelId>({
  panels: GRAPH_ALL_PANELS,
  labels: GRAPH_DOCK_PANEL_LABEL,
  storageKey: "tve:graph:dock-layout:v1",
  defaults: () => ({
    zones: { left: ["hierarchy"], right: ["inspector", "variables", "customNodes"], bottom: ["assets"] },
    active: { left: "hierarchy", right: "inspector", bottom: "assets" },
    floating: [],
    sizes: { left: 270, right: 300, bottom: 240 },
  }),
});
