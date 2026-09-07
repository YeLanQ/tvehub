// 编辑器窗口入口（Tauri 窗口 label "main"，url index.html）。
// 首页是独立窗口（label "home"，home.html）；本项目通过
// "home:project-opened" 事件交接，编辑器窗口在收到事件后才由 Rust
// 命令 show_editor_window 显示（启动时保持隐藏，避免空编辑器闪现）。
import { createApp } from "vue";
import { listen } from "@tauri-apps/api/event";
import App from "./App.vue";
import "./styles/global.scss";
import { isTauri } from "./lib/tauri-env";
import { debugLog, debugError } from "./lib/debug-log";
import { handleProjectOpenedFromHome } from "./app/stores/editor";
import { restoreDevToolsStatus } from "./app/lib/devtools";

debugLog("boot", "app script started");

// 捕获全局错误
window.addEventListener("error", (e) => {
  console.error("全局错误:", e.message, "@", e.filename, e.lineno);
  debugError("page", e.error ?? e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("未处理的 Promise 拒绝:", String(e.reason));
  debugError("page", e.reason);
});

debugLog("boot", `isTauri: ${isTauri()}`);

if (!isTauri()) {
  debugLog("boot", "not running inside Tauri; editor boots without desktop backend");
} else {
  // 首页窗口打开/新建项目 → 同步状态并装载场景（挂载未完成时由挂起机制兜底）
  void listen<{ root: string; name: string; rel: string }>(
    "home:project-opened",
    (e) => {
      void handleProjectOpenedFromHome(e.payload.root, e.payload.name, e.payload.rel);
    },
  );
  // 首页「启用服务」在首页窗口启停服务器；本窗口（main）是唯一命令执行端，
  // 收到 devtools:enabled 后（重新）确认命令监听器就绪（幂等），首页本身不挂监听器。
  void listen("devtools:enabled", () => {
    void restoreDevToolsStatus();
  });
  // 开发者服务：控制服务器若已启用（首页开启），恢复命令监听与日志推送。
  // 仅编辑器窗口安装监听器（事件广播到所有窗口，首页监听会重复执行命令）。
  void restoreDevToolsStatus();
}

createApp(App).mount("#app");
