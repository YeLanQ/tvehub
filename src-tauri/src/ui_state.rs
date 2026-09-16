// ---------------------------------------------------------------------------
// UI 状态 KV 存储（后端权威，彻底替代 localStorage）：
// 停靠布局/面板折叠/过滤状态等界面持久化统一落盘到 app_config_dir/ui-state/
//（一个键一个文件，键名 %XX 转义；临时文件 + 改名原子写）。WebView2 的
// localStorage 在便携场景不可靠且跨窗口同步无保证，后端存储 + "ui-state:changed"
// 事件广播让多窗口（编辑器/脚本图）对同一份界面状态保持一致。
// 值为一 JSON 字符串，后端不解释内容；前端经 lib/ui-state.ts 读写与订阅。
// ---------------------------------------------------------------------------

use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

fn storage_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("ui-state");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 键名转文件名：[A-Za-z0-9._-] 之外的字节按 %XX 转义，避免非法字符与歧义
fn key_to_filename(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for b in key.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' | b'_' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 读取 UI 状态值（键不存在返回 None）
#[tauri::command]
pub fn ui_state_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let path = storage_dir(&app)?.join(key_to_filename(&key));
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 写入 UI 状态值（临时文件 + 改名原子写），并向全部窗口广播
/// "ui-state:changed" {key, value}——其余窗口据此刷新同一份界面状态
#[tauri::command]
pub async fn ui_state_set(
    app: AppHandle,
    key: String,
    value: String,
) -> Result<(), String> {
    let dir = storage_dir(&app)?;
    let name = key_to_filename(&key);
    let tmp = dir.join(format!(".{}.tmp", name));
    fs::write(&tmp, &value).map_err(|e| format!("写入 UI 状态失败: {e}"))?;
    fs::rename(&tmp, dir.join(name)).map_err(|e| format!("提交 UI 状态失败: {e}"))?;
    let _ = app.emit(
        "ui-state:changed",
        serde_json::json!({ "key": key, "value": value }),
    );
    Ok(())
}

/// 删除 UI 状态值
#[tauri::command]
pub fn ui_state_remove(app: AppHandle, key: String) -> Result<(), String> {
    let path = storage_dir(&app)?.join(key_to_filename(&key));
    match fs::remove_file(path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
