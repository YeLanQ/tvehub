// 白板窗口入口（全局单例：Tauri 窗口 label "whiteboard"，url whiteboard.html）：
// 与首页同级的全局工具窗口，不绑定项目；由首页「白板」分区打开（关闭后可重建）。
// 打开指定文件走双通道：take_pending_whiteboard_file 冷启动拉取兜底 +
// tve:whiteboard-open 事件热直达（窗口已就绪时由首页广播）。
import { createApp } from "vue";
import { listen } from "@tauri-apps/api/event";
import WhiteboardApp from "./whiteboard-window/WhiteboardApp.vue";
import { getWhiteboardStore } from "./whiteboard-window/whiteboardStore";
import { isTauri } from "./lib/tauri-env";
import { api } from "./lib/api";
import "./styles/global.scss";
import "./styles/components/toolbar.scss";
import "./styles/whiteboard.scss";

const store = getWhiteboardStore();

if (!isTauri()) {
  // 浏览器直开 whiteboard.html：没有窗口系统与后端，降级提示（可编辑，存取不可用）
  store.markDegraded();
} else {
  // 冷启动补偿：首页写入的待打开文件，事件广播可能在 listen 安装前丢失，这里拉取
  void api
    .takePendingWhiteboardFile()
    .then((name) => {
      store.markReady();
      if (name) void store.loadFile(name);
    })
    .catch(() => store.markReady());
  // 统一热路径：窗口已就绪时首页经此事件直达打开指定文件
  void listen<{ name: string }>("tve:whiteboard-open", (e) => {
    if (e.payload?.name) void store.loadFile(e.payload.name);
  });
}

createApp(WhiteboardApp).mount("#app");
