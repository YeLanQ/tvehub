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
}

createApp(App).mount("#app");
