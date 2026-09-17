// 场景图窗口入口（Tauri 窗口 label "graph"，url graph.html）：
// 与编辑器窗口（main）同级、常驻隐藏的统一节点图编辑器。窗口内继承层级/资产/
// 预览（层级经共享场景会话读取，预览导出与编辑器同一链路）。打开体验与编辑器
// 一致：窗口由 Hub「打开场景图」经统一窗口交接（window-handoff）交付项目。
// 双渠道：后端待交付状态（冷启动拉取兜底）+ window:project-open 事件（热启动直达）。
import { createApp } from "vue";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import GraphApp from "./graph-window/GraphApp.vue";
import { getGraphWindowStore } from "./graph-window/graphStore";
import { getGraphBootStore } from "./graph-window/boot-loading";
import { isTauri } from "./lib/tauri-env";
import { debugLog, debugError } from "./lib/debug-log";
import { api } from "./lib/api";
import type { WindowProjectPayload } from "./app/lib/window-handoff";
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
  // 冷启动补偿：统一交接写入后端待交付状态，事件广播可能在 listen 安装前丢失。
  // 这里主动拉取（取走后清空），保证首次打开也拿到项目。
  void api
    .takePendingProject()
    .then((pending) => {
      if (pending) {
        debugLog("boot", `graph window got pending project: ${pending.name}`);
        void store.applyProject(pending.root, pending.name);
      }
    })
    .catch((e) => debugLog("boot", `takePendingProject failed: ${e}`));
  // 统一窗口交接事件（热启动时窗口已就绪，事件直接到达）。只处理本窗口。
  // applyProject 幂等（换项目时 store 内部整体切换），与上面拉取竞态无副作用。
  void listen<WindowProjectPayload & { label: string }>(
    "window:project-open",
    (e) => {
      if (e.payload.label !== "graph") return;
      debugLog("boot", `graph window got project: ${e.payload.name}`);
      void store.applyProject(e.payload.root, e.payload.name);
    },
  );
  // 文件监听：外部改动资产 → 刷新资产面板（图会话侧车由本窗口独占写）
  void listen<{ root: string; paths: string[] }>("fs-changed", (e) => {
    if (!store.root || e.payload.root !== store.root) return;
    void store.handleFsChanged(e.payload.paths);
  });
  // 蒙版布防：窗口保持隐藏，统一交接显示时蒙版已在（与编辑器窗口的 BootMask
  // 布防一致，杜绝旧内容闪现）
  getGraphBootStore().standby();
  // 窗口关闭请求（X 按钮 / 系统关闭）：Rust 侧 prevent_close + hide，前端收到
  // 事件后立即布防蒙版，下次 show 窗口时蒙版已就位，杜绝旧场景闪现。
  void getCurrentWindow().onCloseRequested(() => {
    getGraphBootStore().standby();
  });
}

createApp(GraphApp).mount("#app");
