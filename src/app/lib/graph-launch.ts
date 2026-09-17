// Hub 侧打开场景图窗口（label "graph"）的入口助手：
// 项目卡片右键「打开场景图」→ 统一窗口交接（写入待交付状态 + 显示窗口 + 广播事件）。
// 冷启动时窗口 listen 未就绪由 takePendingProject 拉取兜底，无需 graph:ready 握手。

import { handoffToWindow } from "./window-handoff";

/** 打开场景图窗口并移交项目（Hub 项目卡片右键菜单调用） */
export async function openScriptGraphWindow(root: string, name: string): Promise<void> {
  try {
    await handoffToWindow("graph", root, name);
  } catch (e) {
    console.error("打开场景图窗口失败:", e);
  }
}
