// 首页窗口入口（Tauri 窗口 label "home"，url home.html）：
// 只挂载 HomeView（项目/模板/偏好设置/开发者服务），与编辑器窗口（main）
// 相互独立。打开/新建项目后由 HomeView emit 事件并请求 Rust 显示编辑器窗口。
import { createApp } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import HomeView from "./app/components/HomeView.vue";
import { isTauri } from "./lib/tauri-env";
import { debugLog, debugError } from "./lib/debug-log";
import { installGraphHandshake } from "./app/lib/graph-launch";
import "./styles/global.scss";

debugLog("boot", "home window script started");

// 尽早安装 graph:ready 握手：图窗口冷启动时会 emit("graph:ready")，
// 若监听未就绪则握手丢失，图窗口收不到项目交接。首页启动时安装可确保
// 监听在用户点击「打开脚本图」之前就已就绪（消除 listen 异步安装竞态）
if (isTauri()) installGraphHandshake();

// 捕获全局错误（与编辑器窗口一致的排查通道）
window.addEventListener("error", (e) => {
  console.error("全局错误:", e.message, "@", e.filename, e.lineno);
  debugError("page", e.error ?? e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("未处理的 Promise 拒绝:", String(e.reason));
  debugError("page", e.reason);
});

createApp(HomeView).mount("#app");

if (isTauri()) {
  // 窗口在配置中以 visible:false 创建：等首帧渲染完成后再显示，
  // 避免 WebView2 就绪前的白屏闪过。双 rAF 确保内容已提交渲染。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      getCurrentWindow()
        .show()
        .then(() => debugLog("boot", "home window shown"))
        .catch((e) => debugLog("boot", `show home window failed: ${e}`));
    });
  });
}
