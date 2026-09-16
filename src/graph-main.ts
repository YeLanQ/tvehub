// 脚本图窗口入口（Tauri 窗口 label "graph"，url graph.html）：
// 与编辑器窗口（main）同级、常驻隐藏的统一节点图编辑器。窗口内继承层级/资产/
// 预览（层级经共享场景会话读取，预览导出与编辑器同一链路）。打开体验与编辑器
// 一致：窗口由 Hub「打开脚本图」经 Rust 显示，装载蒙版按阶段汇报进度后揭幕。
// 项目交接：graph:project-open 事件移交项目根；本窗口启动即监听并广播
// graph:ready，发送方就绪后补发（双保险免时序竞态）。
import { createApp } from "vue";
import { emit, listen } from "@tauri-apps/api/event";
import GraphApp from "./graph-window/GraphApp.vue";
import { getGraphWindowStore } from "./graph-window/graphStore";
import { getGraphBootStore } from "./graph-window/boot-loading";
import { isTauri } from "./lib/tauri-env";
import { debugLog, debugError } from "./lib/debug-log";
import "./styles/global.scss";

debugLog("boot", "graph window script started");

// 捕获全局错误（与编辑器/首页窗口一致的排查通道）
window.addEventListener("error", (e) => {
  console.error("全局错误:", e.message, "@", e.filename, e.lineno);
  debugError("page", e.error ?? e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("未处理的 Promise 拒绝:", String(e.reason));
  debugError("page", e.reason);
});

const store = getGraphWindowStore();

if (!isTauri()) {
  // 浏览器直开 graph.html：没有窗口系统与后端，降级提示（功能在桌面端可用）
  store.markDegraded();
} else {
  // 项目交接：Hub → graph（重复接收幂等；换项目时 store 内部整体切换）
  void listen<{ root: string; name: string }>("graph:project-open", (e) => {
    debugLog("boot", `graph window got project: ${e.payload.name}`);
    void store.applyProject(e.payload.root, e.payload.name);
  });
  // 文件监听：外部改动资产 → 刷新资产面板（图会话侧车由本窗口独占写）
  void listen<{ root: string; paths: string[] }>("fs-changed", (e) => {
    if (!store.root || e.payload.root !== store.root) return;
    void store.handleFsChanged(e.payload.paths);
  });
  // 蒙版布防：窗口保持隐藏，Hub「打开脚本图」经 Rust show_graph_window 显示，
  // 显示时蒙版已在（与编辑器窗口的 BootMask 布防一致，杜绝旧内容闪现）
  getGraphBootStore().standby();
  // 通知发送方本窗口已就绪（Hub 收到后（重新）下发项目信息）
  void emit("graph:ready").catch((e) => debugLog("boot", `emit graph:ready failed: ${e}`));
}

createApp(GraphApp).mount("#app");
