// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod project;
mod trash;

use project::ProjectInfo;
use trash::move_to_trash;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

use tauri::Manager;

#[derive(Serialize, Clone)]
struct RecentProject {
    path: String,
    name: String,
    scene_count: usize,
}


fn recent_file_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .map(|d| d.join("recent_projects.json"))
        .unwrap_or_else(|_| PathBuf::from("recent_projects.json"))
}

fn load_recent(app: &tauri::AppHandle) -> Vec<String> {
    let f = recent_file_path(app);
    std::fs::read_to_string(f)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_recent(app: &tauri::AppHandle, list: &[String]) {
    let f = recent_file_path(app);
    if let Some(dir) = f.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(list) {
        let _ = std::fs::write(f, json);
    }
}

fn push_recent(app: &tauri::AppHandle, path: &str) {
    let mut list = load_recent(app);
    list.retain(|p| p != path);
    list.insert(0, path.to_string());
    if list.len() > 20 {
        list.truncate(20);
    }
    save_recent(app, &list);
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// 打开项目
#[tauri::command]
async fn open_project(app: tauri::AppHandle, path: String) -> Result<ProjectInfo, String> {
    let info = project::project_info(&PathBuf::from(&path))?;
    push_recent(&app, &info.path);
    Ok(info)
}

/// 创建项目：内置模板（id = "builtin:<目录名>"）由前端从 public/templates fetch 后，
/// 以 files（相对路径 → 内容）传入，这里按 template_id 写入项目并生成 .meta。
#[tauri::command]
async fn create_project(
    app: tauri::AppHandle,
    parent: String,
    name: String,
    template_id: String,
    files: Option<std::collections::HashMap<String, String>>,
) -> Result<ProjectInfo, String> {
    if !template_id.starts_with("builtin:") {
        return Err(format!("未知模板类型: {template_id}"));
    }
    let files = files.ok_or("模板缺少文件内容")?;
    let info = project::scaffold_from_files(&PathBuf::from(&parent), &name, &files)?;
    push_recent(&app, &info.path);
    Ok(info)
}

/// 列出最近项目
#[tauri::command]
async fn list_recent_projects(app: tauri::AppHandle) -> Result<Vec<RecentProject>, String> {
    let mut out = Vec::new();
    for p in load_recent(&app) {
        if let Ok(info) = project::project_info(&PathBuf::from(&p)) {
            out.push(RecentProject {
                path: info.path,
                name: info.name,
                scene_count: info.scene_count,
            });
        }
    }
    Ok(out)
}

/// 移除最近项目
#[tauri::command]
async fn remove_recent_project(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let mut list = load_recent(&app);
    list.retain(|p| p != &path);
    save_recent(&app, &list);
    Ok(())
}

/// 读取项目主场景（assets/Main.scene）的原始 JSON 内容
#[tauri::command]
async fn read_project_scene(path: String) -> Result<String, String> {
    let scene_path = PathBuf::from(&path).join("assets").join("Main.scene");
    if !scene_path.exists() {
        return Err(format!("场景文件不存在: {}", scene_path.display()));
    }
    fs::read_to_string(&scene_path).map_err(|e| format!("读取场景失败: {}", e))
}

/// 选择项目文件夹
#[tauri::command]
async fn pick_project_folder() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择项目文件夹")
            .pick_folder()
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())
}

/// 重命名项目
#[tauri::command]
async fn rename_project(path: String, new_name: String) -> Result<ProjectInfo, String> {
    let project_path = PathBuf::from(&path);
    project::rename_project_dir(&project_path, &new_name)
}

/// 把路径移入回收站
#[tauri::command]
async fn trash_path(path: String) -> Result<(), String> {
    move_to_trash(&path)
}

/// 追加一行调试日志到应用配置目录（排查 WebView 内错误用）
#[tauri::command]
async fn append_debug_log(app: tauri::AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("debug.log");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    writeln!(f, "[{:?}] {}", now.as_secs(), line).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            open_project,
            create_project,
            list_recent_projects,
            remove_recent_project,
            rename_project,
            trash_path,
            pick_project_folder,
            read_project_scene,
            append_debug_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
