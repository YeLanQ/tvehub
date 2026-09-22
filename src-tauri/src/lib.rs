// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
// （serde_json::json! 构建大对象（材质参数超集）需要更高的宏递归上限）
#![recursion_limit = "512"]

mod appdirs;
mod ai;
mod asset_protocol;
mod brain;
mod build;
mod devtools;
mod internal;
mod js_minify;
mod lanshare;
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

use tauri::{Emitter, Manager};

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
    let _ = app.emit("projects:changed", ());
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
    // 广播给所有窗口：助手等非首页窗口创建的项目，首页面板即时刷新可见
    let _ = app.emit("projects:changed", ());
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
    let _ = app.emit("projects:changed", ());
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
    let _ = app.emit("projects:changed", ());
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

/// 追加一行调试日志到应用配置根目录（便携模式 exe 旁 data/；排查 WebView 内错误用）
#[tauri::command]
async fn append_debug_log(app: tauri::AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let dir = appdirs::config_root(&app);
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

/// 开发者服务：返回应用相关目录路径（名称有序，前端展示 + openPath 打开）。
/// 展示当前实际生效的目录：便携模式为 exe 旁 data/（配置）与 data/webview/
/// （WebView2 浏览器数据）；回退模式为系统目录（WebView 数据取
/// app_local_data_dir —— Windows 上即 WebView2 默认的 %LOCALAPPDATA%\TvE.Hub）。
#[tauri::command]
async fn dev_app_dirs(app: tauri::AppHandle) -> Result<Vec<(String, String)>, String> {
    let path = app.path();
    let webview_dir = appdirs::webview_data_dir().unwrap_or_else(|| {
        path.app_local_data_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
    });
    let dirs: [(&str, std::path::PathBuf); 3] = [
        ("程序目录", appdirs::exe_dir()),
        ("配置目录", appdirs::config_root(&app)),
        ("WebView 数据", webview_dir),
    ];
    Ok(dirs
        .into_iter()
        .map(|(name, p)| (name.to_string(), p.display().to_string()))
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
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub(crate) fn set(&self, label: String) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(label);
    }
    fn clear_if(&self, label: &str) {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
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
/// 编辑器（editor-*）与场景图（graph-*）窗口不存在时按 label 前缀动态创建
/// （多会话：每个会话独立窗口，关闭即销毁）；冷启动时窗口 listen 未就绪，
/// 事件广播会丢失，由窗口启动后主动 take_pending_project 拉取。
#[tauri::command]
async fn show_window_with_project(
    app: tauri::AppHandle,
    label: String,
    root: String,
    name: String,
    rel: Option<String>,
) -> Result<(), String> {
    open_window_with_project(&app, &label, &root, &name, rel)
}

/// 打开（或聚焦）editor-*/graph-* 窗口并交付项目——首页命令与 devtools 本地
/// 兜底（project.open 无活跃编辑器时）共用的同步核心。
pub(crate) fn open_window_with_project(
    app: &tauri::AppHandle,
    label: &str,
    root: &str,
    name: &str,
    rel: Option<String>,
) -> Result<(), String> {
    let state = app.state::<PendingProjects>();
    state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            label.to_string(),
            PendingProjectPayload { root: root.to_string(), name: name.to_string(), rel },
        );
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    if !(label.starts_with("editor-") || label.starts_with("graph-")) {
        return Ok(());
    }
    // 动态创建窗口（多会话：每个会话独立窗口 + 独立引擎实例，关闭即销毁）
    // 窗口保持隐藏，前端布防装载蒙版后主动 show()，避免空白闪现
    // 背景色取编辑器主题底色（--bg #1a1a2e）：WebView 首帧呈现前原生窗口
    // 默认白底，加载过快时 show 与揭幕贴近，白底会以"闪屏"形式露出来
    let pending = state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(label)
        .map(|p| p.name.clone())
        .unwrap_or_default();
    let (url, title, min_w, min_h) = if label.starts_with("editor-") {
        (
            tauri::WebviewUrl::App("index.html".into()),
            format!("TvE Editor – {pending}"),
            1300.0,
            860.0,
        )
    } else {
        (
            tauri::WebviewUrl::App("graph.html".into()),
            format!("TvE Graph – {pending}"),
            960.0,
            600.0,
        )
    };
    // Tauri 原生拖放拦截（缺省开启）会吞掉页面内 HTML5 drag/drop 事件——
    // 图窗口的「层级拖入画布」依赖页面内 DnD，必须禁用拦截；
    // 编辑器窗口保留：外部系统文件拖放导入走 onDragDropEvent
    // （useAssetTransfer），关掉会丢文件路径。
    let builder = tauri::WebviewWindowBuilder::new(app, label, url)
        .title(title)
        .inner_size(1300.0, 860.0)
        .min_inner_size(min_w, min_h)
        .visible(false)
        .decorations(false)
        .background_color(tauri::window::Color(26, 26, 46, 255))
        // 注意：不要再加 --force-high-performance-gpu。混合显卡机型
        // （核显驱动屏幕 + 独显渲染）下该参数强制 Chromium 在独显渲染，
        // 呈现面跨适配器交给核显合成，resize 与独显启停时会瞬间丢帧——
        // 表现为整个窗口/视口黑闪或透明。让 WebView2 自选 GPU 即可稳定。
        .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
    // 便携式 WebView 数据目录：与首页窗口同一目录（同一 WebContext，
    // 浏览器缓存/origin 存储随 exe 走）；回退模式为 None 走系统默认。
    let builder = match appdirs::webview_data_dir() {
        Some(dir) => builder.data_directory(dir),
        None => builder,
    };
    let _w = if label.starts_with("graph-") {
        builder.disable_drag_drop_handler().build()
    } else {
        builder.build()
    }
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 窗口启动时拉取待交付项目。
/// 不删除条目：窗口页面重载（HMR/Ctrl+R）后重新拉取同一项目可完整恢复会话；
/// 同 label 再次交接时覆盖，窗口销毁（Destroyed）时清理。
#[tauri::command]
async fn take_pending_project(
    webview: tauri::Webview,
    state: tauri::State<'_, PendingProjects>,
) -> Result<Option<PendingProjectPayload>, String> {
    Ok(state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&webview.label().to_string())
        .cloned())
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

// ---------------------------------------------------------------------------
// 白板：全局单例窗口（label "whiteboard"，与 home 同级的全局工具窗口，不绑定
// 项目）。文档为标准 .svg 文件，落全局白板目录（便携 release = exe 同级
// data/whiteboard/；dev / 回退 = %APPDATA%/TvE.Hub/whiteboard/）。
// 打开指定文件的双通道与项目交接一致：待打开状态（窗口冷启动拉取兜底）+
// tve:whiteboard-open 事件（窗口已就绪时直达）。
// ---------------------------------------------------------------------------

/// 白板窗口待打开文件名（首页「白板」分区点击卡片时写入；None = 仅显示/新建）
#[derive(Default)]
pub(crate) struct PendingWhiteboardFile(std::sync::Mutex<Option<String>>);

/// 白板文件目录（全局，不随项目走）
fn whiteboard_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    appdirs::config_root(app).join("whiteboard")
}

/// 文件名合法性：仅字母数字/汉字/空格/._-（拒绝路径分隔与 ..），缺 .svg 后缀补齐
fn sanitize_whiteboard_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("文件名为空".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(format!("非法文件名: {trimmed}"));
    }
    let ok = trimmed
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'));
    if !ok {
        return Err(format!("文件名含非法字符: {trimmed}"));
    }
    let lower = trimmed.to_lowercase();
    Ok(if lower.ends_with(".svg") {
        trimmed.to_string()
    } else {
        format!("{trimmed}.svg")
    })
}

/// 显示白板窗口（全局单例：不存在则创建，存在则聚焦）。name 非空时写入待打开
/// 文件（窗口冷启动时经 take_pending_whiteboard_file 拉取；热路径由前端再广播
/// tve:whiteboard-open 事件直达）。None 覆盖清空：避免陈旧文件在新窗口意外加载。
#[tauri::command]
async fn show_whiteboard_window(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingWhiteboardFile>,
    name: Option<String>,
) -> Result<(), String> {
    *pending.0.lock().unwrap_or_else(|e| e.into_inner()) = name;
    if let Some(w) = app.get_webview_window("whiteboard") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    // 窗口保持隐藏，前端首帧呈现后主动 show()，避免空白闪现（与编辑器一致）
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        "whiteboard",
        tauri::WebviewUrl::App("whiteboard.html".into()),
    )
    .title("TvE 白板")
    .inner_size(1280.0, 800.0)
    .min_inner_size(1024.0, 640.0)
    .visible(false)
    .decorations(false)
    .background_color(tauri::window::Color(20, 20, 20, 255))
    .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
    builder = match appdirs::webview_data_dir() {
        Some(dir) => builder.data_directory(dir),
        None => builder,
    };
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// 显示文档窗口（全局单例：不存在则创建，存在则聚焦）。hash 非空时写入待打开
/// hash（窗口冷启动时经 take_pending_docs_hash 拉取；热路径窗口已存在则由
/// tve:docs-open 事件直达 docs.html 前端）。None 覆盖清空：避免陈旧跳转残留。
#[tauri::command]
async fn show_docs_window(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingDocsHash>,
    hash: Option<String>,
) -> Result<(), String> {
    let hash = hash.filter(|h| !h.trim().is_empty());
    *pending.0.lock().unwrap_or_else(|e| e.into_inner()) = hash.clone();
    if let Some(w) = app.get_webview_window("docs") {
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(h) = hash {
            use tauri::Emitter;
            let _ = app.emit_to("docs", "tve:docs-open", h);
        }
        return Ok(());
    }
    // 窗口保持隐藏，前端首帧（iframe 加载完成）主动 show()，避免空白闪现（与白板一致）
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        "docs",
        tauri::WebviewUrl::App("docs.html".into()),
    )
    .title("tve 文档")
    .inner_size(1180.0, 780.0)
    .min_inner_size(860.0, 560.0)
    .visible(false)
    .decorations(false)
    .background_color(tauri::window::Color(20, 20, 20, 255))
    .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
    builder = match appdirs::webview_data_dir() {
        Some(dir) => builder.data_directory(dir),
        None => builder,
    };
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// 文档窗口待打开 hash（与白板待打开文件同款双通道的冷启动兜底）
#[derive(Default)]
pub(crate) struct PendingDocsHash(std::sync::Mutex<Option<String>>);

/// 切换助手窗口（全局单例）：不存在则创建（隐藏，前端首帧后 show 防白屏）；
/// 已存在则显示/隐藏切换。入口在首页标题栏，其他窗口不提供。
#[tauri::command]
async fn toggle_assistant_window(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("assistant") {
        if w.is_visible().map_err(|e| e.to_string())? {
            let _ = w.hide();
            return Ok(false);
        }
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(true);
    }
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        "assistant",
        tauri::WebviewUrl::App("assistant.html".into()),
    )
    .title("TvE 助手")
    .inner_size(680.0, 720.0)
    .min_inner_size(520.0, 520.0)
    .visible(false)
    .decorations(false)
    .background_color(tauri::window::Color(20, 20, 20, 255))
    .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
    if let Some(dir) = appdirs::webview_data_dir() {
        builder = builder.data_directory(dir);
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(true)
}

/// 文档窗口启动时拉取待打开 hash（取走即清空）
#[tauri::command]
async fn take_pending_docs_hash(
    state: tauri::State<'_, PendingDocsHash>,
) -> Result<Option<String>, String> {
    Ok(state.0.lock().unwrap_or_else(|e| e.into_inner()).take())
}

/// 白板窗口启动时拉取待打开文件名（取走即清空；热路径走事件，不留陈旧状态）
#[tauri::command]
async fn take_pending_whiteboard_file(
    state: tauri::State<'_, PendingWhiteboardFile>,
) -> Result<Option<String>, String> {
    Ok(state.0.lock().unwrap_or_else(|e| e.into_inner()).take())
}

/// 列出全局白板目录下的 .svg 文件名（按名称排序；目录不存在视为空）
#[tauri::command]
async fn whiteboard_list_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = whiteboard_dir(&app);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.to_lowercase().ends_with(".svg").then_some(name)
        })
        .collect();
    names.sort_by_key(|a| a.to_lowercase());
    Ok(names)
}

/// 读取全局白板文件内容
#[tauri::command]
async fn whiteboard_read(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let safe = sanitize_whiteboard_name(&name)?;
    let path = whiteboard_dir(&app).join(&safe);
    std::fs::read_to_string(&path).map_err(|e| format!("读取白板 {safe} 失败: {e}"))
}

/// 写入全局白板文件（自动建目录）
#[tauri::command]
async fn whiteboard_write(
    app: tauri::AppHandle,
    name: String,
    content: String,
) -> Result<(), String> {
    let safe = sanitize_whiteboard_name(&name)?;
    let dir = whiteboard_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(&safe), content)
        .map_err(|e| format!("写入白板 {safe} 失败: {e}"))
}

/// 删除全局白板文件
#[tauri::command]
async fn whiteboard_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let safe = sanitize_whiteboard_name(&name)?;
    let path = whiteboard_dir(&app).join(&safe);
    std::fs::remove_file(&path).map_err(|e| format!("删除白板 {safe} 失败: {e}"))
}

/// 窗口关闭行为（声明式生命周期配置）
enum CloseAction {
    /// 退出应用
    Exit,
}

/// 窗口生命周期配置表：新增可重开窗口只需在此加一行，不再改 on_window_event match。
/// 动态编辑器/图窗口（label "editor-*" / "graph-*"）不在表中 → 走默认销毁
/// （关闭即释放 Webview + 引擎资源，多会话：每次打开创建新窗口）。
/// 白板窗口（label "whiteboard"）同样默认销毁：全局单例，关闭后再次打开重建。
const WINDOW_LIFECYCLE: &[(&str, CloseAction)] = &[("home", CloseAction::Exit)];

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

/// 内置资源根目录：开发为仓库 public/<kind>；生产为 exe 同级 public/<kind>。
fn builtin_root(kind: &str) -> PathBuf {
    if cfg!(debug_assertions) {
        return Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../public/{kind}"));
    }
    appdirs::exe_dir().join("public").join(kind)
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
        if let Err(e) = extract_builtin_archive(&appdirs::exe_dir()) {
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
        .manage(PendingWhiteboardFile::default())
        .manage(PendingDocsHash::default())
        .manage(ActiveEditorWindow::default())
        .manage(task::TaskManager::default())
        .manage(ai::AiState::default())
        .manage(devtools::DevToolsState::default())
        .manage(lanshare::LanShareState::default())
        // 开发者服务：应用启动即开启控制服务器（默认端口 39100，被占用回退随机端口）；
        // 首页「开发者服务」页签可停用/改端口。
        .setup(|app| {
            // 先一次性迁移旧系统目录数据（若有），再迁移旧键名，最后启动依赖配置根的服务
            appdirs::migrate_legacy_config(app.handle());
            ui_state::migrate_key(
                app.handle(),
                "three-visual-editor:dock-layout:v3",
                "tve:editor:dock-layout:v3",
            );
            // 助手大脑：配置根下 brain/ 持久化（快照+冷层归档），启动即恢复并摄取内嵌技能
            let brain_dir = appdirs::config_root(app.handle()).join("brain");
            app.manage(brain::Brain::new(Some(brain_dir.join("snapshot.json.gz"))));
            devtools::autostart(app.handle());
            // 局域网共享按配置自动开服（后台线程：探测网卡会起进程，不阻塞首页）
            lanshare::autostart(app.handle());
            // 首页窗口改为代码创建（tauri.conf.json 不再声明窗口）：便携式需要
            // 在创建时指定 WebView 数据目录，而 config 的 data_directory 相对路径
            // 会被 Tauri 解析到 %LOCALAPPDATA%\<label>，无法表达 exe 同级目录。
            let mut home = tauri::WebviewWindowBuilder::new(
                app,
                "home",
                tauri::WebviewUrl::App("home.html".into()),
            )
            .title("TvE Hub")
            .inner_size(1300.0, 860.0)
            .min_inner_size(1300.0, 860.0)
            .visible(false)
            .decorations(false)
            .background_color(tauri::window::Color(0, 0, 0, 255))
            .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
            if let Some(dir) = appdirs::webview_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                home = home.data_directory(dir);
            }
            home.build().map_err(|e| e.to_string())?;
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
            // 不再改本闭包。home 关闭 = 退出应用。
            // 动态编辑器/图窗口（editor-* / graph-*）不在表中 → 走默认销毁
            // （关闭即释放 Webview + 引擎 + GPU + Worker）。
            if let tauri::WindowEvent::CloseRequested { api: _, .. } = event {
                let action = WINDOW_LIFECYCLE
                    .iter()
                    .find(|(l, _)| *l == label)
                    .map(|(_, a)| a);
                match action {
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
                if label.starts_with("editor-") || label.starts_with("graph-") {
                    if let Some(state) = window.app_handle().try_state::<ActiveEditorWindow>() {
                        state.clear_if(&label);
                    }
                    // 清理该窗口的待交付项目与网页预览服务器子进程
                    if let Some(state) = window.app_handle().try_state::<PendingProjects>() {
                        state.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&label);
                    }
                    // 清理 devtools 命令监听器就绪登记（多会话：label 不复用，防残留）
                    devtools::forget_listener_ready(&label);
                    if let Some(state) = window.app_handle().try_state::<preview::PreviewServerState>() {
                        preview::stop_server_for_label(&state, &label);
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
            show_whiteboard_window,
            take_pending_whiteboard_file,
            show_docs_window,
            take_pending_docs_hash,
            whiteboard_list_files,
            whiteboard_read,
            whiteboard_write,
            whiteboard_delete,
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
            devtools::devtools_recent_calls,
            devtools::devtools_tools,
            devtools::devtools_set_tool,
            devtools::devtools_reply,
            devtools::devtools_push,
            devtools::devtools_listener_ready,
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
            lanshare::lan_share_status,
            lanshare::lan_share_net_info,
            lanshare::lan_share_set_config,
            lanshare::lan_share_start,
            lanshare::lan_share_stop,
            lanshare::lan_share_publish_site,
            lanshare::lan_share_add_dir,
            lanshare::lan_share_set_enabled,
            lanshare::lan_share_remove,
            task::cancel_task,
            task::cancel_tasks_by_root,
            task::list_tasks,
            ai::ai_chat_stream,
            ai::ai_cancel,
            ai::ai_list_models,
            brain::commands::brain_query,
            brain::commands::brain_plan,
            brain::commands::brain_decompose,
            brain::commands::brain_observe,
            brain::commands::brain_stats,
            brain::commands::brain_tick,
            brain::commands::brain_execute,
            brain::commands::brain_approve,
            devtools::devtools_internal_call,
            toggle_assistant_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 退出保存：观测未满自动 tick 间隔的低频积累也在退出时落盘
            //（一轮维护：因果修剪 → 向量合并 → 冷却下沉 → 快照+冷层 flush）
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                app.state::<brain::Brain>().tick();
            }
        });
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
