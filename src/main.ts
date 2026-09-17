// 编辑器窗口入口（Tauri 动态窗口 label "editor-*"，url index.html）。
// 多会话架构：每次从首页打开项目创建独立编辑器窗口，窗口关闭 = 销毁引擎释放资源。
// 首页是独立窗口（label "home"，home.html）；项目经统一窗口交接交付。
import { createApp } from "vue";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App.vue";
import "./styles/global.scss";
import "./app/commands"; // 注册命令层（编辑器窗口命令入口）
import { isTauri } from "./lib/tauri-env";
import { debugLog, debugError } from "./lib/debug-log";
import { handleProjectOpenedFromHome, disposeEditor } from "./app/services/editorService";
import { installFsWatch } from "./app/services/fs-watch";
import { restoreDevToolsStatus } from "./app/lib/devtools";
import { api } from "./lib/api";
import { getBootLoadingStore } from "./app/stores/boot-loading";
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
  const myLabel = getCurrentWindow().label;
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
      if (e.payload.label !== myLabel || !e.payload.rel) return;
      void handleProjectOpenedFromHome(e.payload.root, e.payload.name, e.payload.rel);
    },
  );
  // 文件监听：外部改动工程脚本/资产后失效编辑器缓存并刷新
  installFsWatch();
  // 开发者服务：控制服务器若已启用（首页开启），恢复命令监听与日志推送。
  void listen("devtools:enabled", () => {
    void restoreDevToolsStatus();
  });
  void restoreDevToolsStatus();
  // 窗口关闭（X 按钮 / 系统关闭）：直接销毁引擎释放资源（多会话架构：关闭 = 销毁）。
  // Rust 侧不 prevent_close，窗口走默认销毁，前端 onBeforeUnmount 也会触发 disposeEditor。
  void getCurrentWindow().onCloseRequested(() => {
    getBootLoadingStore().standby();
    disposeEditor();
  });
}

createApp(App).mount("#app");
