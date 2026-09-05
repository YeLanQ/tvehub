// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod internal;
mod preview;
mod project;
mod trash;

use project::{AssetEntry, MetaEntry, ProjectInfo};
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

fn app_prefs_file_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .map(|d| d.join("prefs.json"))
        .unwrap_or_else(|_| PathBuf::from("prefs.json"))
}

/// 读取应用级偏好文件（JSON 对象）；不存在/损坏返回空对象
fn load_app_prefs(app: &tauri::AppHandle) -> serde_json::Map<String, serde_json::Value> {
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
fn save_app_prefs(app: &tauri::AppHandle, prefs: &serde_json::Map<String, serde_json::Value>) {
    let f = app_prefs_file_path(app);
    if let Some(dir) = f.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(prefs) {
        let _ = std::fs::write(f, json);
    }
}

/// 读取默认项目位置（新建项目默认父目录）；未设置返回 null
#[tauri::command]
async fn get_default_project_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let prefs = load_app_prefs(&app);
    Ok(prefs
        .get("default_project_dir")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string()))
}

/// 设置默认项目位置（空值 = 清除）
#[tauri::command]
async fn set_default_project_dir(app: tauri::AppHandle, dir: String) -> Result<(), String> {
    let mut prefs = load_app_prefs(&app);
    let dir = dir.trim().to_string();
    if dir.is_empty() {
        prefs.remove("default_project_dir");
    } else {
        prefs.insert("default_project_dir".into(), dir.into());
    }
    save_app_prefs(&app, &prefs);
    Ok(())
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

// ---------------------------------------------------------------------------
// 资产浏览器命令（扫描项目 assets/src 目录，供资产面板双栏浏览与 CRUD）
// ---------------------------------------------------------------------------

/// 扫描项目目录为资产平铺表
#[tauri::command]
async fn scan_assets(root: String) -> Result<Vec<AssetEntry>, String> {
    let entries = project::scan_tree(&PathBuf::from(&root))?;
    Ok(entries
        .into_iter()
        .map(|e| AssetEntry {
            name: e.name,
            path: e.path,
            kind: e.kind,
            size: e.size,
        })
        .collect())
}

/// 扫描项目 `.meta` 为 uuid -> url 映射表
#[tauri::command]
async fn scan_asset_db(root: String) -> Result<Vec<MetaEntry>, String> {
    let entries = project::scan_meta_db(&PathBuf::from(&root))?;
    Ok(entries
        .into_iter()
        .map(|e| MetaEntry {
            uuid: e.uuid,
            url: e.url,
            size_grid: e.size_grid,
        })
        .collect())
}

/// 读取项目内文本文件
#[tauri::command]
async fn read_text(root: String, rel: String) -> Result<String, String> {
    let p = project::resolve_in_root(&PathBuf::from(&root), &rel)?;
    std::fs::read_to_string(&p).map_err(|e| format!("读取失败 '{}': {}", rel, e))
}

/// 写入项目内文本文件（自动补 .meta）
#[tauri::command]
async fn write_text(root: String, rel: String, content: String) -> Result<(), String> {
    let p = project::resolve_in_root(&PathBuf::from(&root), &rel)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, content).map_err(|e| format!("写入失败 '{}': {}", rel, e))?;
    if project::is_meta_candidate(&PathBuf::from(&root), &rel) {
        let _ = project::ensure_meta(&p);
    }
    Ok(())
}

/// 读取资产 .meta（JSON）；无则 null
#[tauri::command]
async fn read_asset_meta(root: String, rel: String) -> Result<serde_json::Value, String> {
    let asset = project::resolve_in_root(&PathBuf::from(&root), &rel)?;
    project::read_meta(&asset)
}

/// 合并写入资产 .meta（内部先确保 uuid 存在）
#[tauri::command]
async fn write_asset_meta(root: String, rel: String, meta: serde_json::Value) -> Result<(), String> {
    let asset = project::resolve_in_root(&PathBuf::from(&root), &rel)?;
    project::write_meta(&asset, &meta)
}

/// 为项目 assets 下所有资产补齐 .meta
#[tauri::command]
async fn ensure_project_meta(root: String) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    let assets = root_path.join("assets");
    if assets.is_dir() {
        let _ = project::ensure_meta_recursive(&assets);
    }
    Ok(())
}

/// 复制资产，返回新资产相对路径
#[tauri::command]
async fn copy_asset(root: String, rel: String) -> Result<String, String> {
    project::copy_asset(&PathBuf::from(&root), &rel)
}

/// 导入外部文件/目录到项目内指定目录，返回成功导入的相对路径列表
#[tauri::command]
async fn import_assets(root: String, dest_dir: String, source_paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        project::import_assets(&PathBuf::from(&root), &dest_dir, &source_paths)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 移动资产到项目内另一目录，返回新资产相对路径
#[tauri::command]
async fn move_asset(root: String, rel: String, dest_dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        project::move_asset(&PathBuf::from(&root), &rel, &dest_dir)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除资产（目录递归删除）
#[tauri::command]
async fn delete_asset(root: String, rel: String) -> Result<(), String> {
    project::delete_asset(&PathBuf::from(&root), &rel)
}

/// 重命名资产，返回新资产相对路径
#[tauri::command]
async fn rename_asset(root: String, rel: String, new_name: String) -> Result<String, String> {
    project::rename_asset(&PathBuf::from(&root), &rel, &new_name)
}

/// 新建目录，返回创建目录相对路径
#[tauri::command]
async fn create_folder(root: String, rel: String) -> Result<String, String> {
    project::create_folder(&PathBuf::from(&root), &rel)
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
        .manage(preview::PreviewServerState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            open_project,
            create_project,
            list_recent_projects,
            remove_recent_project,
            rename_project,
            trash_path,
            pick_project_folder,
            get_default_project_dir,
            set_default_project_dir,
            read_project_scene,
            scan_assets,
            scan_asset_db,
            read_text,
            write_text,
            read_asset_meta,
            write_asset_meta,
            ensure_project_meta,
            copy_asset,
            import_assets,
            move_asset,
            delete_asset,
            rename_asset,
            create_folder,
            append_debug_log,
            internal::read_internal_asset,
            preview::export_web_preview,
            preview::start_web_preview_server,
            preview::stop_web_preview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
