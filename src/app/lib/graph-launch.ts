// Hub 侧打开场景图窗口（多会话：label "graph-N" 动态创建）的入口助手：
// 项目卡片右键「打开场景图」→ 统一窗口交接（写入待交付状态 + 动态创建窗口 +
// 广播事件）。冷启动时窗口 listen 未就绪由 takePendingProject 拉取兜底。
// 窗口关闭即销毁（Webview + 图引擎整体释放），每次打开分配新 label。

import { handoffToWindow } from "./window-handoff";

/** 图窗口 label 递增计数器（多会话：每次打开分配新窗口） */
let graphWindowCounter = 0;

/** 打开场景图窗口并移交项目（Hub 项目卡片右键菜单调用） */
export async function openScriptGraphWindow(root: string, name: string): Promise<void> {
  try {
    await handoffToWindow(`graph-${++graphWindowCounter}`, root, name);
  } catch (e) {
    console.error("打开场景图窗口失败:", e);
  }
}
