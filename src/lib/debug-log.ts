import { api } from "./api";

/**
 * 调试日志：同时输出到浏览器控制台与磁盘（通过 Rust append_debug_log 命令）。
 * 用于排查 WebView 内引擎/页面错误——GUI 白屏时依然可读。
 */
export function debugLog(tag: string, msg: string) {
  const line = `[${tag}] ${msg}`;
  try {
    console.log(line);
  } catch {
    /* ignore */
  }
  try {
    api.appendDebugLog(line).catch(() => {});
  } catch {
    /* ignore */
  }
}

export function debugError(tag: string, err: unknown) {
  const msg =
    err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  debugLog(tag, msg);
}