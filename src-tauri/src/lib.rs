// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
// （serde_json::json! 构建大对象（材质参数超集）需要更高的宏递归上限）
#![recursion_limit = "512"]

mod asset_protocol;
mod build;
mod devtools;
mod internal;
mod js_minify;
mod model_bin;
pub mod preview;
mod project;
mod repos;
mod scene;
pub mod ui_state;
mod store;
mod task;
mod trash;
mod user_templates;
mod watcher;

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

/// 读取默认项目位置（新建项目默认父目录）；未设置返回 null
#[tauri::command]
async fn get_default_project_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let prefs = store::load_app_prefs(&app);
    Ok(prefs
        .get("default_project_dir")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string()))
}

/// 设置默认项目位置（空值 = 清除）
#[tauri::command]
async fn set_default_project_dir(app: tauri::AppHandle, dir: String) -> Result<(), String> {
    let mut prefs = store::load_app_prefs(&app);
    let dir = dir.trim().to_string();
    if dir.is_empty() {
        prefs.remove("default_project_dir");
    } else {
        prefs.insert("default_project_dir".into(), dir.into());
    }
    store::save_app_prefs(&app, &prefs);
    Ok(())
}

/// 打开项目
#[tauri::command]
async fn open_project(app: tauri::AppHandle, path: String) -> Result<ProjectInfo, String> {
    let info = project::project_info(&PathBuf::from(&path))?;
    store::push_recent(&app, &info.path);
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
    store::push_recent(&app, &info.path);
    Ok(info)
}

/// 列出最近项目
#[tauri::command]
async fn list_recent_projects(app: tauri::AppHandle) -> Result<Vec<RecentProject>, String> {
    let paths = store::list_recent_paths(&app);
    // 每个项目要递归走一遍 assets/ 树统计 .scene 数量 —— 项目数可达 20 且大
    // 项目/网络盘下单次走树就不小，串行会明显拖慢首页首屏。各项目统计彼此
    // 独立，用作用域线程并行（同步 fs 跑在工作线程，不占 tokio/主线程）。
    use rayon::prelude::*;
    let results: Vec<RecentProject> = paths
        .par_iter()
        .filter_map(|p| {
            project::project_info(&PathBuf::from(p)).ok().map(|info| RecentProject {
                path: info.path,
                name: info.name,
                scene_count: info.scene_count,
            })
        })
        .collect();
    Ok(results)
}

/// 移除最近项目（按规范化路径匹配，同一路径的多种写法一并移除）
#[tauri::command]
async fn remove_recent_project(app: tauri::AppHandle, path: String) -> Result<(), String> {
    store::remove_recent_path(&app, &path);
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
async fn rename_project(
    app: tauri::AppHandle,
    path: String,
    new_name: String,
) -> Result<ProjectInfo, String> {
    let project_path = PathBuf::from(&path);
    let info = project::rename_project_dir(&project_path, &new_name)?;
    // 最近项目记录跟随新目录名：旧路径已失效，若不更新下次列表会漏掉改名后的项目
    store::remove_recent_path(&app, &path);
    store::push_recent(&app, &info.path);
    Ok(info)
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
    store::read_text(&PathBuf::from(&root), &rel)
}

/// 写入项目内文本文件（自动补 .meta）
#[tauri::command]
async fn write_text(root: String, rel: String, content: String) -> Result<(), String> {
    store::write_text(&PathBuf::from(&root), &rel, &content)
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

/// 复制资产后把 .shader 的 Shader 指令跟随新路径（失败静默，不影响主操作）
fn follow_shader_directive(root: &str, rel: &str) {
    let _ = scene::shader::rewrite_shader_directive(std::path::Path::new(root), rel);
}

/// 复制资产，返回新资产相对路径
#[tauri::command]
async fn copy_asset(root: String, rel: String) -> Result<String, String> {
    let new_rel = project::copy_asset(&PathBuf::from(&root), &rel)?;
    follow_shader_directive(&root, &new_rel);
    Ok(new_rel)
}

/// 导入外部文件/目录到项目内指定目录，返回成功导入的相对路径列表
#[tauri::command]
async fn import_assets(root: String, dest_dir: String, source_paths: Vec<String>) -> Result<Vec<String>, String> {
    let root_for_follow = root.clone();
    let imported = tauri::async_runtime::spawn_blocking(move || {
        project::import_assets(&PathBuf::from(&root), &dest_dir, &source_paths)
    })
    .await
    .map_err(|e| e.to_string())??;
    for rel in &imported {
        follow_shader_directive(&root_for_follow, rel);
    }
    Ok(imported)
}

/// 移动资产到项目内另一目录，返回新资产相对路径
#[tauri::command]
async fn move_asset(root: String, rel: String, dest_dir: String) -> Result<String, String> {
    let root_for_follow = root.clone();
    let new_rel = tauri::async_runtime::spawn_blocking(move || {
        project::move_asset(&PathBuf::from(&root), &rel, &dest_dir)
    })
    .await
    .map_err(|e| e.to_string())??;
    follow_shader_directive(&root_for_follow, &new_rel);
    Ok(new_rel)
}

/// 删除资产（目录递归删除）
#[tauri::command]
async fn delete_asset(root: String, rel: String) -> Result<(), String> {
    project::delete_asset(&PathBuf::from(&root), &rel)
}

/// 重命名资产，返回新资产相对路径
#[tauri::command]
async fn rename_asset(root: String, rel: String, new_name: String) -> Result<String, String> {
    let new_rel = project::rename_asset(&PathBuf::from(&root), &rel, &new_name)?;
    follow_shader_directive(&root, &new_rel);
    Ok(new_rel)
}

/// 新建目录，返回创建目录相对路径
#[tauri::command]
async fn create_folder(root: String, rel: String) -> Result<String, String> {
    project::create_folder(&PathBuf::from(&root), &rel)
}

/// 写入项目内二进制文件（base64 内容；internal 复制等场景用）
#[tauri::command]
async fn write_asset_binary(root: String, rel: String, content_b64: String) -> Result<(), String> {
    let bytes = crate::base64_decode(&content_b64)
        .map_err(|e| format!("解码二进制失败 '{}': {}", rel, e))?;
    store::write_binary(&PathBuf::from(&root), &rel, &bytes)
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

/// 待交付给编辑器窗口的项目（首页打开/新建项目后写入，编辑器窗口冷启动时拉取）。
/// 各窗口待交付项目（按 webview label 分键）。冷启动时事件广播可能在 listen 安装前
/// 丢失，经此状态中转可保证首次打开也拿到项目。统一服务编辑器/图窗口，杜绝兜底场景抢占。
#[derive(Default)]
struct PendingProjects(std::sync::Mutex<std::collections::HashMap<String, PendingProjectPayload>>);

/// 当前活跃编辑器窗口 label（多会话：devtools/MCP 命令路由到最近聚焦的编辑器窗口）。
/// 窗口聚焦时更新；窗口关闭时若为当前活跃则清空（由剩余编辑器窗口竞争或下次聚焦恢复）。
#[derive(Default)]
pub(crate) struct ActiveEditorWindow(std::sync::Mutex<Option<String>>);

impl ActiveEditorWindow {
    pub(crate) fn get(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }
    fn set(&self, label: String) {
        *self.0.lock().unwrap() = Some(label);
    }
    fn clear_if(&self, label: &str) {
        let mut guard = self.0.lock().unwrap();
        if guard.as_deref() == Some(label) {
            *guard = None;
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingProjectPayload {
    root: String,
    name: String,
    /// 场景?rel（编辑器窗口需要；图窗口 None = 自己解析主场景）
    rel: Option<String>,
}

/// 显示目标窗口并写入待交付项目（统一入口：首页打开编辑器/图窗口均经此）。
/// 编辑器窗口（label 以 "editor-" 前缀）不存在时动态创建；冷启动时窗口 listen 未就绪，
/// 事件广播会丢失，由窗口启动后主动 take_pending_project 拉取。
#[tauri::command]
async fn show_window_with_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, PendingProjects>,
    label: String,
    root: String,
    name: String,
    rel: Option<String>,
) -> Result<(), String> {
    state
        .0
        .lock()
        .unwrap()
        .insert(label.clone(), PendingProjectPayload { root, name, rel });
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.set_focus();
    } else if label.starts_with("editor-") {
        // 动态创建编辑器窗口（多会话：每个项目独立窗口 + 独立引擎实例）
        // 窗口保持隐藏，前端 App.vue standby() 布防蒙版后主动 show()，避免空白闪现
        let title = format!("TvE Editor – {}", state.0.lock().unwrap().get(&label).map(|p| p.name.as_str()).unwrap_or(""));
        let _w = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
            .title(title)
            .inner_size(1300.0, 860.0)
            .min_inner_size(1300.0, 860.0)
            .visible(false)
            .decorations(false)
            .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --force-high-performance-gpu")
            .build()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 窗口启动时拉取待交付项目（取走后清空，保证只交付一次）
#[tauri::command]
async fn take_pending_project(
    webview: tauri::Webview,
    state: tauri::State<'_, PendingProjects>,
) -> Result<Option<PendingProjectPayload>, String> {
    Ok(state.0.lock().unwrap().remove(&webview.label().to_string()))
}

/// 显示首页窗口（编辑器"关闭项目"后调用；编辑器窗口自行关闭销毁，无需 hide）
#[tauri::command]
async fn show_home_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(home) = app.get_webview_window("home") {
        let _ = home.show();
        let _ = home.set_focus();
    }
    Ok(())
}

/// 窗口关闭行为（声明式生命周期配置）
enum CloseAction {
    /// 隐藏窗口（常驻，保留前端状态），可选显示另一窗口
    Hide { show: Option<&'static str> },
    /// 退出应用
    Exit,
}

/// 窗口生命周期配置表：新增可重开窗口只需在此加一行，不再改 on_window_event match。
/// 动态编辑器窗口（label "editor-*"）不在表中 → 走默认销毁（关闭即释放资源）。
const WINDOW_LIFECYCLE: &[(&str, CloseAction)] = &[
    ("graph", CloseAction::Hide { show: None }),
    ("home", CloseAction::Exit),
];

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
// 内置资源目录（public/internal / repos / templates / exports）：开发读仓库目录；
// 生产读 build.rs 打包、启动时释放到 exe 同级 public/<kind>（见 build.rs 的 kind 列表）。
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
/// 创意工坊资源仓库根目录（public/repos；与内置资源同源：开发=仓库 public，
/// 生产=exe 旁 public）。分类 = 子目录（code/effect/…），见 repos.rs。
pub(crate) fn repos_root() -> PathBuf {
    builtin_root("repos")
}

/// build.rs 生成的归档：u32 条数 + 每条 [u32 pathLen][path][u32 dataLen][data]
static BUILTIN_ARCHIVE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/builtin.bin"));

fn parse_builtin_archive(data: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
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
fn extract_builtin_archive(exe_dir: &Path) -> Result<(), String> {
    let public = exe_dir.join("public");
    for (rel, bytes) in parse_builtin_archive(BUILTIN_ARCHIVE)? {
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
        if let Err(e) = extract_builtin_archive(&exe_dir()) {
            eprintln!("[internal] 内置资源释放失败: {e}");
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(preview::PreviewServerState::default())
        .manage(asset_protocol::AssetProtocolState::default())
        .manage(watcher::WatcherState::default())
        .manage(scene::SceneSession::default())
        .manage(PendingProjects::default())
        .manage(ActiveEditorWindow::default())
        .manage(task::TaskManager::default())
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
            let label = window.label().to_string();
            // 窗口关闭行为查 WINDOW_LIFECYCLE 表：新增可重开窗口只需在表里加一行，
            // 不再改本闭包。home 关闭 = 退出应用；graph 关闭 = 隐藏保留前端状态。
            // 动态编辑器窗口（editor-*）不在表中 → 走默认销毁（关闭即释放引擎+GPU+Worker）。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let action = WINDOW_LIFECYCLE
                    .iter()
                    .find(|(l, _)| *l == label)
                    .map(|(_, a)| a);
                match action {
                    Some(CloseAction::Hide { show }) => {
                        api.prevent_close();
                        let _ = window.hide();
                        if let Some(target) = show {
                            if let Some(w) = window.app_handle().get_webview_window(target) {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                    Some(CloseAction::Exit) => {
                        window.app_handle().exit(0);
                    }
                    None => {}
                }
            }
            // 多会话：追踪活跃编辑器窗口（devtools/MCP 命令路由目标）
            if let tauri::WindowEvent::Focused(focused) = event {
                if *focused && label.starts_with("editor-") {
                    if let Some(state) = window.app_handle().try_state::<ActiveEditorWindow>() {
                        state.set(label.clone());
                    }
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                if label.starts_with("editor-") {
                    if let Some(state) = window.app_handle().try_state::<ActiveEditorWindow>() {
                        state.clear_if(&label);
                    }
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
            repos::list_repo_categories,
            repos::read_repo_file,
            repos::write_repo_file,
            repos::delete_repo_file,
            repos::list_code_protos,
            repos::read_code_proto,
            repos::write_code_proto,
            repos::delete_code_proto,
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
            show_window_with_project,
            take_pending_project,
            show_home_window,
            write_asset_binary,
            asset_protocol::set_current_project_root,
            scene::scene_open,
            scene::scene_load_doc,
            scene::scene_add_node,
            scene::scene_add_tree,
            scene::scene_remove_nodes,
            scene::scene_reparent_nodes,
            scene::scene_rename,
            scene::scene_set_transform,
            scene::scene_patch_node,
            scene::scene_patch_nodes,
            scene::scene_undo,
            scene::scene_redo,
            scene::scene_history_state,
            scene::scene_hierarchy_rows,
            scene::scene_dirty,
            scene::scene_doc,
            scene::scene_save,
            scene::scene_close,
            scene::material::material_read,
            scene::material::material_write,
            scene::material::material_duplicate,
            scene::material::skymat_write,
            scene::material::shader_read,
            scene::material::shader_write,
            scene::material::shader_write_source,
            scene::texcube::texcube_write,
            scene::terrain::terrain_write,
            scene::terrain_material::terrainmat_write,
            scene::logic_assets::fsm_write,
            scene::logic_assets::behaviortree_write,
            devtools::devtools_start,
            devtools::devtools_stop,
            devtools::devtools_status,
            devtools::devtools_tools,
            devtools::devtools_set_tool,
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
            ui_state::ui_state_get,
            ui_state::ui_state_set,
            ui_state::ui_state_remove,
            task::cancel_task,
            task::cancel_tasks_by_root,
            task::list_tasks,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod builtin_archive_tests {
    use super::{parse_builtin_archive, BUILTIN_ARCHIVE};

    /// 归档必须包含全部四类内置资源（internal/repos/templates/exports）：
    /// 这四类由 Rust 命令从 exe 旁磁盘读取，build.rs 的 kind 列表漏配会导致
    /// release 版 exe 旁缺对应目录（如工坊/模板/导出模板为空）。
    #[test]
    fn archive_contains_all_builtin_kinds() {
        let entries = parse_builtin_archive(BUILTIN_ARCHIVE).expect("解析内置资源归档");
        assert!(!entries.is_empty(), "归档不应为空");
        for kind in ["internal/", "repos/", "templates/", "exports/"] {
            assert!(
                entries.iter().any(|(p, _)| p.starts_with(kind)),
                "归档缺少 {kind} 条目"
            );
        }
    }
}
