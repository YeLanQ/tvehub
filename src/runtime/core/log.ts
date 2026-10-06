// 预览页日志转发与失败展示：
// - postLog：预览页 → 编辑器控制台（编辑器 WebPreviewPanel 监听 message）；
// - fail：页面错误层（#error）+ 编辑器日志 + console 三路输出。

/** 日志转发开关：发布构建（config.debug === false）时由 player 关闭 */
let forwardingEnabled = true;

/** 开/关预览页 → 编辑器控制台的日志转发 */
export function setLogForwarding(on: unknown): void {
  forwardingEnabled = !!on;
}

/** 预览页 → 编辑器控制台转发（编辑器 WebPreviewPanel 监听 message）。
 *  worker 线程（微信物理 Worker）经 __tveWorkerLog 钩子优先转发（桥接层
 *  worker-relay 安装 → bridge 保留信道 → 主线程 console；钩子登记见
 *  runtime/bridge/protocol.ts TVE_WORKER_LOG_HOOK，引擎源保持字面量） */
export function postLog(level: string, text: unknown): void {
  if (!forwardingEnabled) return;
  try {
    const hook = (globalThis as { __tveWorkerLog?: (lv: string, tx: string) => void }).__tveWorkerLog;
    if (typeof hook === "function") {
      hook(level, String(text));
      return;
    }
  } catch {
    /* ignore */
  }
  try {
    window.parent?.postMessage(
      { __editorPreviewLog: true, level, text: String(text), time: new Date().toLocaleTimeString() },
      "*",
    );
  } catch {
    /* ignore */
  }
}

/** 启动/运行失败：错误层展示并转发编辑器 */
export function fail(msg: unknown): void {
  const text = String(msg);
  const errorEl = document.getElementById("error");
  if (errorEl) {
    errorEl.textContent = "预览运行失败\n\n" + text;
    errorEl.classList.add("visible");
  }
  postLog("error", text);
  console.error(text);
}
