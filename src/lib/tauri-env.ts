/**
 * 前端运行环境判定。
 *
 * @tauri-apps/api v2 的 invoke / getCurrentWindow / event 等均依赖
 * `window.__TAURI_INTERNALS__`（无论 tauri.conf.json 是否开启 `withGlobalTauri`）。
 * 用浏览器直接打开 devUrl（`pnpm dev` 后访问 http://localhost:1420）时没有该对象，
 * 所有 Rust 侧命令与窗口 API 调用都会抛「Cannot read properties of undefined」这类
 * 晦涩 TypeError。此函数用于提前识别环境，并在界面层给出提示。
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
}