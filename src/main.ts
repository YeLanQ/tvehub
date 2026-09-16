// 编辑器窗口入口（Tauri 窗口 label "main"，url index.html）。
// 首页是独立窗口（label "home"，home.html）；本项目通过
// "home:project-opened" 事件交接，编辑器窗口在收到事件后才由 Rust
// 命令 show_editor_window 显示（启动时保持隐藏，避免空编辑器闪现）。
import { createApp } from "vue";
import { listen } from "@tauri-apps/api/event";
import App from "./App.vue";
import "./styles/global.scss";
import "./app/commands"; // 注册命令层（编辑器窗口命令入口）
import { isTauri } from "./lib/tauri-env";
import { debugLog, debugError } from "./lib/debug-log";
import { handleProjectOpenedFromHome } from "./app/services/editorService";
import { installFsWatch } from "./app/services/fs-watch";
import { restoreDevToolsStatus } from "./app/lib/devtools";
import { api } from "./lib/api";

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
  // 冷启动补偿：首页 show_editor_window 写入待交付项目并 show 窗口，随后的
  // home:project-opened 事件广播可能在下面 listen 安装前发出而丢失。这里主动
  // 拉取后端待交付项目（取走后清空），保证首次打开也拿到真实项目而非兜底场景。
  void api
    .takePendingProject()
    .then((pending) => {
      if (pending) {
        void handleProjectOpenedFromHome(pending.root, pending.name, pending.rel);
      }
    })
    .catch((e) => debugLog("boot", `takePendingProject failed: ${e}`));
  // 首页窗口打开/新建项目 → 同步状态并装载场景（挂载未完成时由挂起机制兜底）。
  // 热启动（窗口已就绪）时事件正常到达，作为直接渠道；与上面拉取的竞态由
  // handleProjectOpenedFromHome 短窗口去重兜底。
  void listen<{ root: string; name: string; rel: string }>(
    "home:project-opened",
    (e) => {
      void handleProjectOpenedFromHome(e.payload.root, e.payload.name, e.payload.rel);
    },
  );
  // 文件监听：外部改动工程脚本/资产后失效编辑器缓存并刷新（后端在打开项目时
  // 才开始监听目标目录，这里先装好事件接收端）
  installFsWatch();
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
