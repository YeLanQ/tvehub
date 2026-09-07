// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
// （serde_json::json! 构建大对象（材质参数超集）需要更高的宏递归上限）
#![recursion_limit = "512"]

mod asset_protocol;
mod build;
mod devtools;
mod internal;
mod js_minify;
mod model_bin;
mod preview;
mod project;
mod scene;
mod trash;
mod user_templates;

use project::{AssetEntry, MetaEntry, ProjectInfo};
use trash::move_to_trash;
use serde::Serialize;
use std::path::{Path, PathBuf};

use tauri::Manager;

/// 应用主菜单已移除（双窗口均不显示原生菜单栏，快捷键由前端 keydown 处理）。

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
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
    let norm = normalize_recent_path(path);
    list.retain(|p| recent_path_key(p) != recent_path_key(&norm));
    list.insert(0, norm);
    if list.len() > 20 {
        list.truncate(20);
    }
    save_recent(app, &list);
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

/// 移除最近项目（按规范化路径匹配，同一路径的多种写法一并移除）
#[tauri::command]
async fn remove_recent_project(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let key = recent_path_key(&path);
    let list: Vec<String> = load_recent(&app)
        .into_iter()
        .filter(|p| recent_path_key(p) != key)
        .collect();
    save_recent(&app, &list);
    Ok(())
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

/// 导入资产：多选文件对话框（资产面板「导入」用）
#[tauri::command]
async fn pick_import_files(title: Option<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(title.unwrap_or_else(|| "选择要导入的文件".into()))
            .pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())
}

/// 导入资产：多选文件夹对话框（资产面板「导入目录」用）
#[tauri::command]
async fn pick_import_folders(title: Option<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(title.unwrap_or_else(|| "选择要导入的文件夹".into()))
            .pick_folders()
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect::<Vec<_>>()
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

/// 写入项目内二进制文件（base64 内容；internal 复制等场景用）
#[tauri::command]
async fn write_asset_binary(root: String, rel: String, content_b64: String) -> Result<(), String> {
    let p = project::resolve_in_root(&PathBuf::from(&root), &rel)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = crate::base64_decode(&content_b64)
        .map_err(|e| format!("解码二进制失败 '{}': {}", rel, e))?;
    std::fs::write(&p, bytes).map_err(|e| format!("写入二进制失败 '{}': {}", rel, e))
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

/// 打开 WebView 开发者工具（调试构建默认可用；发行构建未启用 devtools 时提示）
#[tauri::command]
async fn open_devtools(window: tauri::WebviewWindow) -> Result<(), String> {
    // tauri 的 devtools 能力默认随 debug 构建启用（发行构建需显式开启 tauri/devtools）
    #[cfg(debug_assertions)]
    {
        window.open_devtools();
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = window;
        Err("当前为发行构建，未启用开发者工具".to_string())
    }
}

/// 开发者服务：返回应用相关目录路径（名称有序，前端展示 + openPath 打开）
#[tauri::command]
async fn dev_app_dirs(app: tauri::AppHandle) -> Result<Vec<(String, String)>, String> {
    let path = app.path();
    let dirs: [(&str, Result<std::path::PathBuf, tauri::Error>); 4] = [
        ("配置目录", path.app_config_dir()),
        ("数据目录", path.app_data_dir()),
        ("日志目录", path.app_log_dir()),
        ("程序目录", path.executable_dir()),
    ];
    Ok(dirs
        .into_iter()
        .filter_map(|(name, p)| {
            p.ok().map(|p| (name.to_string(), p.display().to_string()))
        })
        .collect())
}

// ---------------------------------------------------------------------------
// 双窗口生命周期：home（首页窗口）/ main（编辑器窗口）互相独立，
// 打开项目时由首页切换到编辑器，编辑器"关闭项目"切回首页。
// ---------------------------------------------------------------------------

/// 显示编辑器窗口（首页窗口保持打开，仅把焦点切到编辑器；
/// 打开/新建项目成功后由首页调用）
#[tauri::command]
async fn show_editor_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    Ok(())
}

/// 显示首页窗口并隐藏编辑器（编辑器"关闭项目"后调用）
#[tauri::command]
async fn show_home_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    if let Some(home) = app.get_webview_window("home") {
        let _ = home.show();
        let _ = home.set_focus();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// base64（免第三方依赖：预览二进制贴图导出 + 前端纹理读取共用）
// ---------------------------------------------------------------------------

const BASE64_TABLE: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub(crate) fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(BASE64_TABLE[(b0 >> 2) as usize] as char);
        out.push(BASE64_TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            BASE64_TABLE[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64_TABLE[(b2 & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn base64_val(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a' + 26) as u32),
        b'0'..=b'9' => Some((c - b'0' + 52) as u32),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

pub(crate) fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &c in s.as_bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' || c.is_ascii_whitespace() {
            continue;
        }
        let v = base64_val(c).ok_or_else(|| "非法 base64 字符".to_string())?;
        acc = (acc << 6) | v;
        bits += 6;
        while bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 内置资源目录（public/internal）：开发读仓库目录；生产读 build.rs 打包、
// 启动时释放到 exe 同级 public/internal。
// ---------------------------------------------------------------------------

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 内置资源根目录：开发为仓库 public/<kind>；生产为 exe 同级 public/<kind>。
fn builtin_root(kind: &str) -> PathBuf {
    if cfg!(debug_assertions) {
        return Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../public/{kind}"));
    }
    exe_dir().join("public").join(kind)
}

/// 内置资源根目录（internal）
pub(crate) fn internal_root() -> PathBuf {
    builtin_root("internal")
}

/// build.rs 生成的归档：u32 条数 + 每条 [u32 pathLen][path][u32 dataLen][data]
static INTERNAL_ARCHIVE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/internal.bin"));

fn parse_internal_archive(data: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    if data.len() < 4 {
        return Err("内置资源归档为空".into());
    }
    let count = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
    let mut pos = 4usize;
    let mut out = Vec::with_capacity(count.min(4096));
    for _ in 0..count {
        if pos + 4 > data.len() {
            return Err("内置资源归档截断(pathLen)".into());
        }
        let plen =
            u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
        pos += 4;
        if pos + plen + 4 > data.len() {
            return Err("内置资源归档截断(path)".into());
        }
        let path = String::from_utf8_lossy(&data[pos..pos + plen]).to_string();
        pos += plen;
        let dlen =
            u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
        pos += 4;
        if pos + dlen > data.len() {
            return Err("内置资源归档截断(data)".into());
        }
        out.push((path, data[pos..pos + dlen].to_vec()));
        pos += dlen;
    }
    Ok(out)
}

/// 把内嵌资源释放到 exe 同级 public/（幂等：已存在文件不覆盖，保留用户修改）
fn extract_internal_archive(exe_dir: &Path) -> Result<(), String> {
    let public = exe_dir.join("public");
    for (rel, bytes) in parse_internal_archive(INTERNAL_ARCHIVE)? {
        let dest = public.join(&rel);
        if dest.exists() {
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
        }
        std::fs::write(&dest, bytes).map_err(|e| format!("写入失败 {}: {e}", dest.display()))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 生产（release）启动时把内置资源释放到 exe 同级 public/（开发直接读仓库目录）
    if !cfg!(debug_assertions) {
        if let Err(e) = extract_internal_archive(&exe_dir()) {
            eprintln!("[internal] 内置资源释放失败: {e}");
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(preview::PreviewServerState::default())
        .manage(asset_protocol::AssetProtocolState::default())
        .manage(scene::SceneSession::default())
        .manage(devtools::DevToolsState::default())
        // 开发者服务：应用启动即开启控制服务器（默认端口 39100，被占用回退随机端口）；
        // 首页「开发者服务」页签可停用/改端口。
        .setup(|app| {
            devtools::autostart(app.handle());
            Ok(())
        })
        // asset:// 协议：模型/贴图等二进制资产由 WebView 直读 Rust（替代 base64 过 IPC）
        .register_uri_scheme_protocol("asset", |ctx, request| {
            use tauri::Manager;
            let state = ctx.app_handle().state::<asset_protocol::AssetProtocolState>();
            asset_protocol::handle_asset_protocol(&state, request)
        })
        // 双窗口均不显示原生菜单栏；编辑器快捷键由前端 keydown 统一处理
        .on_window_event(|window, event| {
            // 双窗口生命周期：
            // - 编辑器窗口关闭 = "关闭项目" → 隐藏编辑器（保留前端状态），显示首页；
            // - 首页窗口关闭 = 退出应用（一并结束隐藏中的编辑器窗口）。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    "main" => {
                        api.prevent_close();
                        let _ = window.hide();
                        if let Some(home) = window
                            .app_handle()
                            .get_webview_window("home")
                        {
                            let _ = home.show();
                            let _ = home.set_focus();
                        }
                    }
                    "home" => {
                        window.app_handle().exit(0);
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_project,
            create_project,
            list_recent_projects,
            remove_recent_project,
            rename_project,
            trash_path,
            pick_project_folder,
            pick_import_files,
            pick_import_folders,
            get_default_project_dir,
            set_default_project_dir,
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
            open_devtools,
            dev_app_dirs,
            show_editor_window,
            show_home_window,
            write_asset_binary,
            asset_protocol::set_current_project_root,
            scene::scene_open,
            scene::scene_load_doc,
            scene::scene_add_node,
            scene::scene_remove_nodes,
            scene::scene_reparent_nodes,
            scene::scene_rename,
            scene::scene_set_transform,
            scene::scene_patch_node,
            scene::scene_undo,
            scene::scene_redo,
            scene::scene_history_state,
            scene::scene_dirty,
            scene::scene_doc,
            scene::scene_save,
            scene::scene_close,
            scene::material::material_read,
            scene::material::material_write,
            scene::material::material_duplicate,
            devtools::devtools_start,
            devtools::devtools_stop,
            devtools::devtools_status,
            devtools::devtools_reply,
            devtools::devtools_push,
            preview::export_web_preview_from_scene,
            preview::start_web_preview_server,
            preview::stop_web_preview,
            build::build_export,
            user_templates::scan_user_templates,
            user_templates::read_user_template_text,
            internal::read_internal_asset,
            internal::read_internal_binary,
            internal::scan_internal_assets,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
