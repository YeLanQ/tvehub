// ---------------------------------------------------------------------------
// 编辑器窗口停靠系统实例：面板集为编辑器五面板（层级/属性/控制台/资产/动画），
// 布局经后端 UI 状态 KV 持久化（键与图窗口隔离，互不串布局）；
// 通用逻辑在 src/docks/create-docks（页签拖拽/浮动/尺寸约束/持久化装载）。
// ---------------------------------------------------------------------------
import { createDockSystem } from "../../docks/create-docks";
import type { DockZoneId } from "../../docks/types";
import { animEditMode } from "../lib/anim-edit-mode";

export type DockPanelId = "hierarchy" | "inspector" | "console" | "assets" | "animation";
export type { DockZoneId };

export const ALL_PANELS: DockPanelId[] = ["hierarchy", "inspector", "console", "assets", "animation"];

export const DOCK_PANEL_LABEL: Record<DockPanelId, string> = {
  hierarchy: "层级",
  inspector: "属性",
  console: "控制台",
  assets: "资产",
  animation: "动画",
};

/** 动画聚焦编辑中：禁止切走底部动画面板（其它面板激活/移动/关闭动画面板都忽略） */
function switchGuard(panel: DockPanelId): boolean {
  return animEditMode.active && panel !== "animation";
}

export const docks = createDockSystem<DockPanelId>({
  panels: ALL_PANELS,
  labels: DOCK_PANEL_LABEL,
  storageKey: "tve:editor:dock-layout:v3",
  defaults: () => ({
    zones: { left: ["hierarchy"], right: ["inspector"], bottom: ["console", "animation", "assets"] },
    active: { left: "hierarchy", right: "inspector", bottom: "console" },
    floating: [],
    sizes: { left: 270, right: 300, bottom: 240 },
  }),
  switchGuard,
});
