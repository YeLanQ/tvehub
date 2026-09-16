// ---------------------------------------------------------------------------
// UI 状态 KV 存取门面（后端权威持久化，彻底替代 localStorage）：
// 停靠布局/面板折叠/过滤状态等界面状态统一经 ui_state_get/set 读写——
// 后端落盘到 app_config_dir/ui-state/（每键一文件，原子写），并在写入时向
// 全部窗口广播 "ui-state:changed" {key, value}，多窗口据此保持同一份界面状态。
// 值统一 JSON 序列化存储，本模块对外返回解析后的对象。
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./tauri-env";

/** 读取 UI 状态（键不存在/后端不可用返回 null） */
export async function uiStateGet<T>(key: string): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    const raw = await invoke<string | null>("ui_state_get", { key });
    return raw == null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

/** 写入 UI 状态（value 任意可 JSON 序列化对象）；写入后广播变更事件 */
export async function uiStateSet(key: string, value: unknown): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("ui_state_set", {
      key,
      value: JSON.stringify(value ?? null),
    });
  } catch {
    /* 存储不可用（隐私模式等）：仅本次会话有效 */
  }
}

/** 删除 UI 状态键 */
export async function uiStateRemove(key: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("ui_state_remove", { key });
  } catch {
    /* ignore */
  }
}

/** 订阅某键的跨窗口变更（含本窗口写入的回执，消费方按值幂等应用即可）。
 *  返回取消函数。 */
export async function onUiStateChange<T>(
  key: string,
  fn: (value: T) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<{ key: string; value: unknown }>("ui-state:changed", (e) => {
    if (e.payload.key === key) fn(e.payload.value as T);
  });
}
