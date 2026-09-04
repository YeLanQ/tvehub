import { createApp } from "vue";
import App from "./App.vue";
import "./styles/global.scss";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "./lib/tauri-env";
import { debugLog, debugError } from "./lib/debug-log";

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
  // 非 Tauri 环境：直接渲染
  debugLog("boot", "not running inside Tauri; showing desktop-only notice");
  createApp(App).mount("#app");
} else {
  createApp(App).mount("#app");

  // 窗口在配置中以 visible:false 创建：等首帧渲染完成后再显示，
  // 避免 WebView2 就绪前的白屏闪过。双 rAF 确保内容已提交渲染；Rust 侧兜底强制显示。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      getCurrentWindow()
        .show()
        .then(() => debugLog("boot", "window shown"))
        .catch((e) => debugLog("boot", `show window failed: ${e}`));
    });
  });
}