// store —— 应用级持久化助手（分层：命令函数只做薄壳，磁盘读写/文件格式集中于此）。
// 现状：最近项目 recent_projects.json + 应用偏好 prefs.json 的读写与路径规范化。
// 后续：资产/场景的 fs 直写也可逐步收口到此（scene_save / read_text / write_text …）。

use serde_json::Map;
use std::path::PathBuf;

use tauri::AppHandle;
use tauri::Manager;

fn recent_file_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .map(|d| d.join("recent_projects.json"))
        .unwrap_or_else(|_| PathBuf::from("recent_projects.json"))
}

fn app_prefs_file_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .map(|d| d.join("prefs.json"))
        .unwrap_or_else(|_| PathBuf::from("prefs.json"))
}

/// 规范化最近项目路径的写法：分隔符统一为反斜杠、去掉结尾分隔符
/// （界面文件夹选择器给反斜杠，远程 devtools/手输可能给正斜杠，否则同一项目存两条）
fn normalize_recent_path(path: &str) -> String {
    let p = path.replace('/', "\\");
    p.trim_end_matches('\\').to_string()
}

/// 最近项目路径的去重比较键（分隔符与大小写不敏感；Windows 路径不区分大小写）
fn recent_path_key(path: &str) -> String {
    normalize_recent_path(path).to_ascii_lowercase()
}

/// 读取应用级偏好文件（JSON 对象）；不存在/损坏返回空对象
pub fn load_app_prefs(app: &AppHandle) -> Map<String, serde_json::Value> {
    let f = app_prefs_file_path(app);
    std::fs::read_to_string(&f)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .and_then(|v| match v {
            serde_json::Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}

/// 写回应用级偏好文件
pub fn save_app_prefs(app: &AppHandle, prefs: &Map<String, serde_json::Value>) {
    let f = app_prefs_file_path(app);
    if let Some(dir) = f.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(prefs) {
        let _ = std::fs::write(f, json);
    }
}

fn load_recent(app: &AppHandle) -> Vec<String> {
    let f = recent_file_path(app);
    std::fs::read_to_string(f)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
        // 展示/比较前规范化：统一分隔符并按规范化形式去重（同一路径多种写法只保留首条）
        .into_iter()
        .map(|p| normalize_recent_path(&p))
        .fold(Vec::new(), |mut acc, p| {
            if !acc.iter().any(|x| recent_path_key(x) == recent_path_key(&p)) {
                acc.push(p);
            }
            acc
        })
}

fn save_recent(app: &AppHandle, list: &[String]) {
    let f = recent_file_path(app);
    if let Some(dir) = f.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(list) {
        let _ = std::fs::write(f, json);
    }
}

/// 按规范化路径从最近列表移除（同一路径的多种写法一并移除）
pub fn remove_recent_path(app: &AppHandle, path: &str) {
    let key = recent_path_key(path);
    let list: Vec<String> = load_recent(app)
        .into_iter()
        .filter(|p| recent_path_key(p) != key)
        .collect();
    save_recent(app, &list);
}

/// 把项目路径置顶登记为最近项目（去重 + 上限 20）
pub fn push_recent(app: &AppHandle, path: &str) {
    let mut list = load_recent(app);
    let norm = normalize_recent_path(path);
    list.retain(|p| recent_path_key(p) != recent_path_key(&norm));
    list.insert(0, norm);
    if list.len() > 20 {
        list.truncate(20);
    }
    save_recent(app, &list);
}

/// 列出最近项目路径（已去重、按最近优先）
pub fn list_recent_paths(app: &AppHandle) -> Vec<String> {
    load_recent(app)
}
