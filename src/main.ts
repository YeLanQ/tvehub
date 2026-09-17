// 编辑器窗口入口（Tauri 窗口 label "main"，url index.html）。
// 首页是独立窗口（label "home"，home.html）；本项目通过统一窗口交接
// （window-handoff）交付项目：后端待交付状态 + window:project-open 事件双渠道。
import { createApp } from "vue";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App.vue";
import "./styles/global.scss";
import "./app/commands"; // 注册命令层（编辑器窗口命令入口）
import { isTauri } from "./lib/tauri-env";
import { debugLog, debugError } from "./lib/debug-log";
import { handleProjectOpenedFromHome } from "./app/services/editorService";
import { installFsWatch } from "./app/services/fs-watch";
import { restoreDevToolsStatus } from "./app/lib/devtools";
import { api } from "./lib/api";
import { getBootLoadingStore } from "./app/stores/boot-loading";
import { getEditorStore } from "./app/stores/editor";
import type { WindowProjectPayload } from "./app/lib/window-handoff";

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
  // 冷启动补偿：统一交接写入后端待交付状态，随后的 window:project-open 事件
  // 广播可能在下面 listen 安装前发出而丢失。这里主动拉取（取走后清空），
  // 保证首次打开也拿到真实项目而非兜底场景。
  void api
    .takePendingProject()
    .then((pending) => {
      if (pending && pending.rel) {
        void handleProjectOpenedFromHome(pending.root, pending.name, pending.rel);
      }
    })
    .catch((e) => debugLog("boot", `takePendingProject failed: ${e}`));
  // 统一窗口交接事件（热启动时窗口已就绪，事件直接到达）。只处理本窗口。
  // 与上面拉取的竞态由 handleProjectOpenedFromHome 短窗去重兜底。
  void listen<WindowProjectPayload & { label: string }>(
    "window:project-open",
    (e) => {
      if (e.payload.label !== "main" || !e.payload.rel) return;
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
  // 窗口关闭请求（X 按钮 / 系统关闭）：Rust 侧 prevent_close + hide，前端收到
  // 事件后立即布防蒙版 + 停止音频（窗口仅隐藏不销毁，音频不会自动停）。
  void getCurrentWindow().onCloseRequested(() => {
    getBootLoadingStore().standby();
    try {
      const store = getEditorStore();
      if (store.state.mounted) store.engine.audio.unbindAll();
    } catch { /* 引擎未挂载时无需处理 */ }
  });
}

createApp(App).mount("#app");
