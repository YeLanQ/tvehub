// 助手窗口入口（全局单例：Tauri 窗口 label "assistant"，无边框浮动面板）。
// 仅首页标题栏提供开关入口；面板内两栏 = 项目工作区 | 聊天/设置。
// 窗口由 Rust 创建时隐藏：首帧挂载 + 位置恢复后再 show，避免白屏闪现。
import { createApp } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import AssistantApp from "./assistant-window/AssistantApp.vue";
import "./styles/global.scss";
import { isTauri } from "./lib/tauri-env";
import { uiStateGet, uiStateSet } from "./lib/ui-state";
import { getAssistantStore } from "./assistant-window/store";
import { getConversations } from "./assistant-window/conversations";

const KEY_WINDOW = "tve:ai:window";

// 会话工作区与配置装载（非 Tauri 环境自动内存退化）
const store = getAssistantStore();
void store.load();
void getConversations().load();

createApp(AssistantApp).mount("#app");

if (isTauri()) {
  const win = getCurrentWindow();
  void (async () => {
    // 恢复上次位置（物理像素）；失败忽略用默认位置
    const saved = await uiStateGet<{ x: number; y: number }>(KEY_WINDOW);
    if (saved && typeof saved.x === "number" && typeof saved.y === "number") {
      try {
        await win.setPosition(new PhysicalPosition(saved.x, saved.y));
      } catch {
        /* ignore */
      }
    }
    // 移动后防抖保存位置
    let timer: ReturnType<typeof setTimeout> | null = null;
    await win.onMoved(({ payload }) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void uiStateSet(KEY_WINDOW, { x: payload.x, y: payload.y });
      }, 500);
    });
    await win.show();
  })();
}
