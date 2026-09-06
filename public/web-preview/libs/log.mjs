// 预览页日志转发与失败展示：
// - postLog：预览页 → 编辑器控制台（编辑器 WebPreviewPanel 监听 message）；
// - fail：页面错误层（#error）+ 编辑器日志 + console 三路输出。

/** 日志转发开关：发布构建（config.debug === false）时由 player 关闭 */
let forwardingEnabled = true;

/** 开/关预览页 → 编辑器控制台的日志转发 */
export function setLogForwarding(on) {
  forwardingEnabled = !!on;
}

/** 预览页 → 编辑器控制台转发（编辑器 WebPreviewPanel 监听 message） */
export function postLog(level, text) {
  if (!forwardingEnabled) return;
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
export function fail(msg) {
  const text = String(msg);
  const errorEl = document.getElementById("error");
  if (errorEl) {
    errorEl.textContent = "预览运行失败\n\n" + text;
    errorEl.classList.add("visible");
  }
  postLog("error", text);
  console.error(text);
}
