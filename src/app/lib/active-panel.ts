// active-panel —— 最近一次指针交互所在的面板上下文。
// F2 等「按上下文重命名」快捷键据此分派：资产面板内 → 重命名选中资产；
// 其余（层级/视口/检查器）→ 重命名场景选中节点。
// 纯前端瞬态状态，不入命令层/后端。

export type ActivePanel = "assets" | "scene";

let active: ActivePanel = "scene";
let installed = false;

export function getActivePanel(): ActivePanel {
  return active;
}

/** 安装一次全局指针监听：落在 .asset-manager（AssetsPanel）内记为 assets，其余归 scene */
export function installActivePanelTracker(): void {
  if (installed) return;
  installed = true;
  window.addEventListener(
    "pointerdown",
    (e) => {
      const el = e.target as HTMLElement | null;
      active = el && el.closest?.(".asset-manager") ? "assets" : "scene";
    },
    true,
  );
}
