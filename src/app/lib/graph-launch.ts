// Hub 侧打开脚本图窗口（label "graph"）的入口助手：
// 项目卡片右键「打开脚本图」→ 显示窗口 + 经 graph:project-open 事件移交项目。
// 窗口常驻但可能尚未就绪（冷启动中）：graph:ready 握手后用 lastRequested 补发，
// 与打开时的直接下发构成双保险，免启动时序竞态。

import { emit, listen } from "@tauri-apps/api/event";
import { api } from "../../lib/api";
import { isTauri } from "../../lib/tauri-env";

let lastRequested: { root: string; name: string } | null = null;
let handshakeInstalled = false;

/**
 * 安装 graph:ready 握手监听（幂等）。
 * 应在首页窗口启动时尽早调用，确保图窗口冷启动 emit("graph:ready") 时
 * 监听已就绪，避免双保险竞态导致项目交接丢失。
 */
export function installGraphHandshake(): void {
  if (handshakeInstalled || !isTauri()) return;
  handshakeInstalled = true;
  void listen("graph:ready", () => {
    if (lastRequested) void emit("graph:project-open", lastRequested);
  });
}

/** 打开脚本图窗口并移交项目（Hub 项目卡片右键菜单调用） */
export async function openScriptGraphWindow(root: string, name: string): Promise<void> {
  if (!isTauri()) return;
  installGraphHandshake();
  lastRequested = { root, name };
  try {
    await api.showGraphWindow();
    await emit("graph:project-open", { root, name });
  } catch (e) {
    console.error("打开脚本图窗口失败:", e);
  }
}
