//! 开发者服务：本地控制服务器（换行分隔 JSON over TCP）+ MCP streamable-http 端点。
//!
//! 启用后监听 `127.0.0.1:{port}`，外部工具（脚本 / 集成 / 自动化）用换行分隔的 JSON
//! 与编辑器交互：
//! - 请求：`{"id":<任意值>,"method":"<字符串>","params":{...}}`
//! - 响应：`{"id":<同上>,"result":<值>,"error":<字符串|null>}`
//! - 推送（无 id）：`{"event":"<名称>","data":<值>}`
//!
//! 同一端口自动探测 HTTP 请求（POST /mcp），内联提供 MCP streamable-http 端点。
//!
//! 方法分两类：
//! - **Rust 本地**：`ping` / `editor.health`，直接在服务端应答。
//! - **前端执行**：其余方法转发为 Tauri 事件 `devtools:cmd`，由编辑器窗口的
//!   前端执行器（src/app/lib/devtools）调用 store / engine / api，再经
//!   `devtools_reply` 回填。每笔待回复命令由服务端生成唯一 `replyToken`（UUID），
//!   避免多客户端 id 冲突。

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};

/// Tauri managed：当前开发者服务运行时（同一时刻至多一个）+ 工具权限（Rust 权威存储）
pub struct DevToolsState {
    inner: Mutex<Option<Arc<DevToolsRuntime>>>,
    /// 工具 id -> 是否启用；None = 尚未从磁盘加载
    perms: Mutex<Option<HashMap<String, bool>>>,
    /// 助手等进程内调用方的待回复通道（replyToken -> 回传端）
    internal_pending: Mutex<HashMap<String, SyncSender<Result<serde_json::Value, String>>>>,
    /// 统一调用日志：助手（内部桥）/控制端（TCP+MCP）都入账，最近 50 条
    call_log: Mutex<Vec<CallLogEntry>>,
}

/// 一条工具调用记录（首页开发者服务「最近调用」展示用）
#[derive(Serialize, Clone)]
pub struct CallLogEntry {
    /// Unix 毫秒
    pub ts: u64,
    /// assistant = 助手内部桥；control = 控制端（TCP/MCP）
    pub source: &'static str,
    pub method: String,
    /// 助手路径 = 执行结果；控制端路径 = 是否获准执行（结果异步回填不在此刻）
    pub ok: bool,
    /// 助手路径的耗时毫秒；控制端路径为 0
    pub ms: u64,
    pub detail: String,
}

/// 追加一条调用日志（超 50 条淘汰最旧）
fn log_call(
    state: &DevToolsState,
    source: &'static str,
    method: &str,
    ok: bool,
    ms: u64,
    detail: &str,
) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if let Ok(mut log) = state.call_log.lock() {
        log.push(CallLogEntry {
            ts,
            source,
            method: method.to_string(),
            ok,
            ms,
            detail: detail.chars().take(160).collect(),
        });
        let len = log.len();
        if len > 50 {
            log.drain(..len - 50);
        }
    }
}

impl Default for DevToolsState {
    fn default() -> Self {
        DevToolsState {
            inner: Mutex::new(None),
            perms: Mutex::new(None),
            internal_pending: Mutex::new(HashMap::new()),
            call_log: Mutex::new(Vec::new()),
        }
    }
}

/// 工具权限项（首页「工具权限」清单 / devtools_tools 返回值）
#[derive(Serialize, Clone)]
pub struct ToolPermInfo {
    pub id: String,
    pub name: String,
    pub group: String,
    pub enabled: bool,
}

/// 启动后返回给前端/用户的信息
#[derive(Serialize, Clone)]
pub struct DevToolsInfo {
    pub port: u16,
    /// 展示用端点（tcp://…）；协议为换行分隔 JSON
    pub url: String,
    /// MCP HTTP 端点（http://127.0.0.1:<port>/mcp，同一端口）
    pub mcp_url: String,
    /// MCP stdio 桥程序路径（mcp.exe，与主程序同目录；客户端配置 command 用）
    pub stdio_command: String,
    pub token: String,
    pub protocol: String,
}

struct PendingResp {
    tx: SyncSender<String>,
    req_id: serde_json::Value,
}

pub struct DevToolsRuntime {
    port: u16,
    token: String,
    /// 所有客户端连接（用于事件广播，仅 JSON-lines 客户端）
    clients: Mutex<Vec<SyncSender<String>>>,
    /// replyToken -> (连接发送端, 原请求 id)
    pending: Mutex<HashMap<String, PendingResp>>,
    /// replyToken -> MCP HTTP 请求的回复通道（前端回填后构造成 HTTP 响应）
    http_pending: Mutex<HashMap<String, SyncSender<serde_json::Value>>>,
    /// MCP 工具名（合法名，如 editor_state）-> 真实 devtools 方法（如 editor.state）
    name_to_method: Mutex<HashMap<String, String>>,
    stop: Arc<AtomicBool>,
}

impl DevToolsRuntime {
    fn info(&self) -> DevToolsInfo {
        DevToolsInfo {
            port: self.port,
            url: format!("tcp://127.0.0.1:{}", self.port),
            mcp_url: format!("http://127.0.0.1:{}/mcp", self.port),
            stdio_command: mcp_stdio_command(),
            token: self.token.clone(),
            protocol: "tcp-jsonlines + mcp-http".to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// 工具权限：Rust 权威存储（配置根目录/devtools_perms.json；便携模式 exe 旁 data/）。
// 首页/编辑器窗口经 devtools_tools / devtools_set_tool 读写，Rust 直答与前端执行
// 都按同一份权限门控（前端另有 localStorage 镜像，仅用于 UI 即时性）。
// ---------------------------------------------------------------------------

/// 工具目录（id, 显示名, 分组）；与前端 devtools/state.ts DEFAULT_TOOLS 保持同构。
const TOOL_CATALOG: &[(&str, &str, &str)] = &[
    ("editor", "编辑器状态", "编辑器"),
    ("projectQuery", "查询项目", "编辑器"),
    ("projectOpen", "打开/关闭项目", "编辑器"),
    ("projectCreate", "新建项目", "编辑器"),
    ("scene", "场景", "场景"),
    ("node", "节点选中", "节点"),
    ("nodeAdd", "添加节点", "节点"),
    ("nodeDelete", "删除节点", "节点"),
    ("nodeSet", "节点设置", "节点"),
    ("state", "状态快照", "状态"),
    ("previewOpen", "打开预览", "预览"),
    ("previewClose", "关闭预览", "预览"),
    ("previewStart", "启动预览", "预览"),
    ("previewStop", "停止预览", "预览"),
    ("screenScreenshot", "截图", "屏幕快照"),
    ("assetList", "资源列表", "资源"),
    ("assetRead", "读取资源内容", "资源"),
    ("assetWrite", "写入资源内容", "资源"),
    ("assetCreate", "新建资源", "资源"),
    ("assetSelect", "选中资源", "资源"),
    ("assetDelete", "删除资源", "资源"),
    ("assetRename", "重命名资源", "资源"),
];

/// method -> 工具 id（未列出的方法如 ping / health / mcp.listTools 不受权限控制）
const METHOD_TO_TOOL: &[(&str, &str)] = &[
    ("editor.state", "editor"),
    ("project.list", "projectQuery"),
    ("project.open", "projectOpen"),
    ("project.close", "projectOpen"),
    ("project.create", "projectCreate"),
    ("scene.list", "scene"),
    ("scene.open", "scene"),
    ("scene.save", "scene"),
    ("scene.tree", "scene"),
    ("node.select", "node"),
    ("node.add", "nodeAdd"),
    ("node.remove", "nodeDelete"),
    ("node.rename", "nodeSet"),
    ("node.set", "nodeSet"),
    ("preview.start", "previewStart"),
    ("preview.stop", "previewStop"),
    ("preview.open", "previewOpen"),
    ("preview.close", "previewClose"),
    ("preview.screenshot", "screenScreenshot"),
    ("state.snapshot", "state"),
    ("state.restore", "state"),
    ("asset.list", "assetList"),
    ("asset.read", "assetRead"),
    ("asset.write", "assetWrite"),
    ("asset.create", "assetCreate"),
    ("asset.select", "assetSelect"),
    ("asset.delete", "assetDelete"),
    ("asset.rename", "assetRename"),
];

fn tool_name(id: &str) -> Option<String> {
    TOOL_CATALOG
        .iter()
        .find(|(tid, _, _)| *tid == id)
        .map(|(_, name, _)| name.to_string())
}

fn perms_file_path(app: &AppHandle) -> std::path::PathBuf {
    crate::appdirs::config_root(app).join("devtools_perms.json")
}

/// 当前工具启用状态（默认全部启用；磁盘存档覆盖之）。缓存进 DevToolsState，首次读取时加载。
fn ensure_perms_loaded(app: &AppHandle) -> HashMap<String, bool> {
    let state = app.state::<DevToolsState>();
    let mut guard = state.perms.lock().unwrap();
    if guard.is_none() {
        let mut map = HashMap::new();
        if let Ok(text) = std::fs::read_to_string(perms_file_path(app)) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(obj) = v.as_object() {
                    for (k, val) in obj {
                        if let Some(b) = val.as_bool() {
                            map.insert(k.clone(), b);
                        }
                    }
                }
            }
        }
        *guard = Some(map);
    }
    guard.clone().unwrap_or_default()
}

fn save_perms(app: &AppHandle, map: &HashMap<String, bool>) {
    let path = perms_file_path(app);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(&map) {
        let _ = std::fs::write(path, json);
    }
}

/// method 是否被工具权限允许（Rust 直答与转发统一门控）；未登记的方法放行
fn require_tool(app: &AppHandle, method: &str) -> Result<(), String> {
    let tool = METHOD_TO_TOOL
        .iter()
        .find(|(m, _)| *m == method)
        .map(|(_, t)| *t);
    let Some(tool) = tool else { return Ok(()) };
    let map = ensure_perms_loaded(app);
    let enabled = map.get(tool).copied().unwrap_or(true);
    if enabled {
        Ok(())
    } else {
        let name = tool_name(tool).unwrap_or_else(|| tool.to_string());
        Err(format!("工具「{name}」未启用（可在首页 开发者服务 中开启）"))
    }
}

fn current_tools(app: &AppHandle) -> Vec<ToolPermInfo> {
    let map = ensure_perms_loaded(app);
    TOOL_CATALOG
        .iter()
        .map(|(id, name, group)| ToolPermInfo {
            id: (*id).to_string(),
            name: (*name).to_string(),
            group: (*group).to_string(),
            enabled: map.get(*id).copied().unwrap_or(true),
        })
        .collect()
}

/// 查询工具权限清单（前端首页同步用）
#[tauri::command]
pub async fn devtools_tools(app: AppHandle) -> Result<Vec<ToolPermInfo>, String> {
    Ok(current_tools(&app))
}

/// 设置某工具是否启用并持久化到 Rust（返回最新清单）
#[tauri::command]
pub async fn devtools_set_tool(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<Vec<ToolPermInfo>, String> {
    if tool_name(&id).is_none() {
        return Err(format!("未知工具 id: {id}"));
    }
    {
        let state = app.state::<DevToolsState>();
        let mut guard = state.perms.lock().unwrap();
        let mut map = guard.take().unwrap_or_default();
        map.insert(id.clone(), enabled);
        save_perms(&app, &map);
        *guard = Some(map);
    }
    Ok(current_tools(&app))
}

// ---------------------------------------------------------------------------
// devtools:cmd 监听器就绪登记：编辑器窗口前端装好命令监听后上报自己的 label。
// 冷启动竞态——窗口刚创建时 emit_to 会在 JS 就绪前丢失（命令石沉大海，调用方
// 空 60s 超时），故 project.open 的本地兜底开新窗口后会先等就绪回执再放行。
// ---------------------------------------------------------------------------

static LISTENER_READY: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn listener_ready_set() -> &'static Mutex<HashSet<String>> {
    LISTENER_READY.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 前端回执：本窗口的 devtools:cmd 监听器已安装（编辑器窗口启动时调用）
#[tauri::command]
pub async fn devtools_listener_ready(label: String) -> Result<(), String> {
    if let Ok(mut set) = listener_ready_set().lock() {
        set.insert(label);
    }
    Ok(())
}

/// 窗口销毁时清除就绪登记（多会话 label 不复用，仅防集合无界增长）
pub(crate) fn forget_listener_ready(label: &str) {
    if let Ok(mut set) = listener_ready_set().lock() {
        set.remove(label);
    }
}

// ---------------------------------------------------------------------------
// Rust 本地执行器：纯后端方法（查询/会话落盘）不经前端直接应答；其余仍转发前端。
// ---------------------------------------------------------------------------

/// 多会话：获取当前活跃编辑器窗口 label（devtools/MCP 命令路由目标）。
/// 无活跃编辑器时回退 None，调用方各自处理（报错或跳过）。
fn active_editor_label(app: &AppHandle) -> Option<String> {
    app.state::<crate::ActiveEditorWindow>().get()
}

/// 会话当前打开的项目根（未打开项目返回 None；供 scene.list / asset.list 扫描用）。
/// devtools/MCP 驱动活跃编辑器窗口的当前场景（多会话：最近聚焦的 editor-* 窗口）。
async fn scene_root_of(app: &AppHandle) -> Option<String> {
    let label = active_editor_label(app)?;
    let state = app.state::<crate::scene::SceneSession>();
    let hub = state.hub().ok()?;
    crate::scene::scene_root_path_for(&hub, &label).ok().flatten()
}

fn project_recent_list(app: &AppHandle) -> Result<serde_json::Value, String> {
    let mut recent = Vec::new();
    for p in crate::store::list_recent_paths(app) {
        if let Ok(info) = crate::project::project_info(&std::path::PathBuf::from(&p)) {
            recent.push(serde_json::json!({
                "path": info.path,
                "name": info.name,
                "sceneCount": info.scene_count,
            }));
        }
    }
    Ok(serde_json::json!({ "recent": recent }))
}

/// project.open 本地兜底：没有活跃编辑器窗口时，新开一个编辑器窗口交付项目
/// （等同首页「打开项目」），不再报「没有活跃的编辑器窗口」。有活跃编辑器时
/// 返回 None——照旧转发该窗口切换工作区，行为不变。
fn project_open_local(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Option<Result<serde_json::Value, String>> {
    if active_editor_label(app).is_some() {
        return None;
    }
    let path = params
        .get("path")
        .and_then(|p| p.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let Some(path) = path else {
        return Some(Err("缺少 path 参数（项目绝对路径）".to_string()));
    };
    let info = match crate::project::project_info(&std::path::PathBuf::from(path)) {
        Ok(i) => i,
        Err(e) => return Some(Err(format!("打开项目失败: {e}"))),
    };
    // 与首页 open_project 同语义：登记最近 + 广播变更（首页面板即时刷新）
    crate::store::push_recent(app, &info.path);
    let _ = app.emit("projects:changed", ());
    let label = format!(
        "editor-devtools-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    // 交付必须带 rel：编辑器窗口交接通道只认非空场景路径（main.ts 的
    // takePendingProject 对 rel=null 不启动装载，窗口会永远停在布防蒙版 0%）
    let rel = params
        .get("rel")
        .and_then(|p| p.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| resolve_boot_scene(&info.path));
    if let Err(e) =
        crate::open_window_with_project(app, &label, &info.path, &info.name, Some(rel))
    {
        return Some(Err(format!("打开编辑器窗口失败: {e}")));
    }
    // 新窗口即路由目标：聚焦事件到来之前先标记活跃，后续 node.* 立即可路由
    app.state::<crate::ActiveEditorWindow>().set(label.clone());
    // 等命令监听器就绪再放行：避免后续转发在 JS 就绪前 emit 丢失（60s 假等）
    wait_listener_ready(&label, 15);
    Some(Ok(serde_json::json!({
        "ok": true,
        "path": info.path,
        "name": info.name,
        "window": label,
        "note": "已在新编辑器窗口打开项目（等同首页打开项目），可继续 node.* / scene.* 操作",
    })))
}

/// 轮询等待窗口的 devtools:cmd 监听器就绪（秒级上限；超时放行——由转发层
/// 60s 应答超时兜底，不在此报错）。仅 spawn_blocking / TCP 线程调用，可阻塞。
fn wait_listener_ready(label: &str, max_secs: u64) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(max_secs);
    while std::time::Instant::now() < deadline {
        let ready = listener_ready_set()
            .lock()
            .map(|set| set.contains(label))
            .unwrap_or(false);
        if ready {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// 解析项目启动场景（镜像前端 project.ts resolveProjectBoot 的候选顺序）：
/// 1) project.config.json 的 mainScene（合法且文件存在）；2) assets/Main.scene；
/// 3) 资产扫描到的第一个 .scene（排序取首）；全无时仍回默认路径（与首页
/// 打开项目同口径：首次保存时创建项目的第一个场景）。
fn resolve_boot_scene(root: &str) -> String {
    const DEFAULT: &str = "assets/Main.scene";
    let base = std::path::Path::new(root);
    let cfg_main = std::fs::read_to_string(base.join("project.config.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| {
            v.get("mainScene")
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
        })
        .filter(|rel| {
            !rel.starts_with("internal/") && rel != "src" && !rel.starts_with("src/")
        });
    for candidate in cfg_main.into_iter().chain([DEFAULT.to_string()]) {
        if base.join(&candidate).is_file() {
            return candidate;
        }
    }
    if let Ok(entries) = crate::project::scan_tree(base) {
        let mut scenes: Vec<String> = entries
            .into_iter()
            .filter(|a| a.kind == "scene" && !a.path.ends_with('/'))
            .map(|a| a.path)
            .collect();
        scenes.sort();
        if let Some(first) = scenes.into_iter().next() {
            return first;
        }
    }
    DEFAULT.to_string()
}

#[cfg(test)]
mod boot_scene_tests {
    use super::resolve_boot_scene;

    fn write(path: &std::path::Path, rel: &str, content: &str) {
        let p = path.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    #[test]
    fn prefers_config_main_scene_then_default_then_scan() {
        let dir = std::env::temp_dir().join(format!("tve-boot-scene-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = dir.join("p1");
        std::fs::create_dir_all(&root).unwrap();
        // 空项目：回默认路径（与首页打开项目同口径）
        assert_eq!(resolve_boot_scene(root.to_str().unwrap()), "assets/Main.scene");
        // 扫描兜底：无配置时取排序第一个 .scene
        write(&root, "assets/Zeta.scene", "{}");
        write(&root, "assets/Alpha.scene", "{}");
        assert_eq!(
            resolve_boot_scene(root.to_str().unwrap()),
            "assets/Alpha.scene"
        );
        // config mainScene 优先，且指向不存在的文件时继续向后回退
        write(&root, "project.config.json", r#"{"mainScene":"assets/Zeta.scene"}"#);
        assert_eq!(
            resolve_boot_scene(root.to_str().unwrap()),
            "assets/Zeta.scene"
        );
        write(&root, "project.config.json", r#"{"mainScene":"assets/Gone.scene"}"#);
        assert_eq!(
            resolve_boot_scene(root.to_str().unwrap()),
            "assets/Alpha.scene"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

fn scene_list_of(root: &str) -> Result<serde_json::Value, String> {
    let entries = crate::project::scan_tree(&std::path::PathBuf::from(root))?;
    let scenes: Vec<serde_json::Value> = entries
        .into_iter()
        .filter(|a| a.kind == "scene" && !a.path.ends_with('/'))
        .map(|a| serde_json::json!({ "name": a.name, "path": a.path }))
        .collect();
    Ok(serde_json::json!(scenes))
}

fn asset_list_of(root: &str) -> Result<serde_json::Value, String> {
    let entries = crate::project::scan_tree(&std::path::PathBuf::from(root))?;
    let list: Vec<serde_json::Value> = entries
        .into_iter()
        .map(|a| {
            serde_json::json!({
                "name": a.name,
                "path": a.path,
                "kind": a.kind,
                "size": a.size,
            })
        })
        .collect();
    Ok(serde_json::json!(list))
}

/// 尝试在 Rust 本地执行；返回 Ok(None) = 该方法需要前端，应照常转发。
fn try_local(
    app: &AppHandle,
    method: &str,
    params: &serde_json::Value,
) -> Option<Result<serde_json::Value, String>> {
    Some(match method {
        "project.list" => project_recent_list(app),
        // project.create 本地直答：模板从 exe 旁（生产）/仓库（开发）public/templates
        // 读取后脚手架——助手工具经大脑决策中心派发后执行权收归后端，不再走前端流程
        "project.create" => crate::project::create_local(app, params),
        // project.open 本地兜底：无活跃编辑器时直接新开编辑器窗口交付项目
        // （等同首页「打开项目」）；有活跃编辑器 → None 走转发切换工作区
        "project.open" => match project_open_local(app, params) {
            Some(res) => res,
            None => return None,
        },
        // 助手工作区语义：root 参数显式指定项目目录（不依赖编辑器会话）；
        // 缺省回退活跃编辑器会话的项目根（外部控制端兼容）。
        "scene.list" => match workspace_root(app, params) {
            Some(root) => scene_list_of(&root),
            None => Err("没有工作区项目（可在助手左栏添加），也未打开编辑器".to_string()),
        },
        "asset.list" => match workspace_root(app, params) {
            Some(root) => asset_list_of(&root),
            None => Err("没有工作区项目（可在助手左栏添加），也未打开编辑器".to_string()),
        },
        "asset.read" => {
            let Some(root) = workspace_root(app, params) else {
                return Some(Err("没有工作区项目（可在助手左栏添加），也未打开编辑器".to_string()));
            };
            let Some(path) = params.get("path").and_then(|p| p.as_str()) else {
                return Some(Err("缺少 path 参数".to_string()));
            };
            asset_read_of(&root, path)
        }
        "asset.write" => {
            let Some(root) = workspace_root(app, params) else {
                return Some(Err("没有工作区项目（可在助手左栏添加），也未打开编辑器".to_string()));
            };
            let Some(path) = params.get("path").and_then(|p| p.as_str()) else {
                return Some(Err("缺少 path 参数".to_string()));
            };
            let Some(content) = params.get("content").and_then(|c| c.as_str()) else {
                return Some(Err("缺少 content 参数".to_string()));
            };
            asset_write_of(&root, path, content)
        }
        "scene.tree" | "state.snapshot" => scene_doc_blocking(app),
        "scene.save" => scene_save_blocking(app).map(|_| serde_json::json!({ "ok": true })),
        // 文件内模块索引（brain.fileidx）：大文本文件 @ 引用走"索引+按需检索"，
        // 不整包进 LLM 上下文；file.search 索引失效自动重建
        "file.index" | "file.search" => {
            let Some(root) = workspace_root(app, params) else {
                return Some(Err("没有工作区项目（可在助手左栏添加），也未打开编辑器".to_string()));
            };
            let Some(path) = params.get("path").and_then(|p| p.as_str()) else {
                return Some(Err("缺少 path 参数".to_string()));
            };
            let brain = app.state::<crate::brain::Brain>();
            if method == "file.index" {
                brain.fileidx_index(&root, path).map(|b| serde_json::to_value(b).expect("brief 可序列化"))
            } else {
                let query = params.get("query").and_then(|q| q.as_str()).unwrap_or("");
                if query.trim().is_empty() {
                    return Some(Err("缺少 query 参数".to_string()));
                }
                let top_k = params.get("topK").and_then(|k| k.as_u64()).unwrap_or(0) as usize;
                brain
                    .fileidx_search(&root, path, query, top_k)
                    .map(|hits| serde_json::to_value(hits).expect("hits 可序列化"))
            }
        }
        _ => return None,
    })
}

/// 方法的工作区项目根：优先 params.root（助手显式指定），回退活跃编辑器会话。
fn workspace_root(app: &AppHandle, params: &serde_json::Value) -> Option<String> {
    if let Some(r) = params.get("root").and_then(|r| r.as_str()) {
        let r = r.trim();
        if !r.is_empty() {
            return Some(r.to_string());
        }
    }
    scene_root_blocking(app)
}

/// 读取项目内文本资产（助手"@插入文件"用）：拒路径穿越与二进制，超长截断。
fn asset_read_of(root: &str, path: &str) -> Result<serde_json::Value, String> {
    let abs = workspace_path_of(root, path)?;
    let meta = std::fs::metadata(&abs).map_err(|_| "文件不存在".to_string())?;
    if !meta.is_file() {
        return Err("不是文件（目录请用 asset.list 浏览）".to_string());
    }
    if meta.len() > 512 * 1024 {
        return Err("文件超过 512KB，不适合直接插入".to_string());
    }
    let bytes = std::fs::read(&abs).map_err(|e| format!("读取失败: {e}"))?;
    let content = String::from_utf8(bytes).map_err(|_| "二进制文件不支持插入".to_string())?;
    let truncated = content.len() > 64 * 1024;
    let mut shown: String = content.chars().take(16 * 1024).collect();
    if truncated {
        shown.push_str("\n…（内容过长，已截断）");
    }
    Ok(serde_json::json!({ "path": path, "content": shown, "truncated": truncated }))
}

/// 写入项目内文本资产（助手工作区编辑用）：自动建父目录，超限拒绝。
fn asset_write_of(root: &str, path: &str, content: &str) -> Result<serde_json::Value, String> {
    if content.len() > 512 * 1024 {
        return Err("内容超过 512KB，请拆分后写入".to_string());
    }
    let abs = workspace_path_of(root, path)?;
    if let Some(dir) = abs.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    std::fs::write(&abs, content).map_err(|e| format!("写入失败: {e}"))?;
    Ok(serde_json::json!({ "path": path, "bytes": content.len(), "ok": true }))
}

/// 工作区相对路径安全化：拒空/穿越/反斜杠，返回 root 下的绝对路径
/// （pub(crate)：brain.fileidx 索引/检索复用同一套路径安全规则）
pub(crate) fn workspace_path_of(root: &str, path: &str) -> Result<std::path::PathBuf, String> {
    let path = path.trim().trim_start_matches('/');
    if path.is_empty() || path.contains("..") || path.contains('\\') {
        return Err("非法的资产路径".to_string());
    }
    Ok(std::path::Path::new(root).join(path))
}

fn scene_root_blocking(app: &AppHandle) -> Option<String> {
    tauri::async_runtime::block_on(scene_root_of(app))
}

fn scene_doc_blocking(app: &AppHandle) -> Result<serde_json::Value, String> {
    let label = active_editor_label(app).ok_or("没有活跃的编辑器窗口")?;
    let state = app.state::<crate::scene::SceneSession>();
    let mut hub = state.hub()?;
    crate::scene::scene_doc_for(&mut hub, &label)
}

fn scene_save_blocking(app: &AppHandle) -> Result<(), String> {
    let label = active_editor_label(app).ok_or("没有活跃的编辑器窗口")?;
    let state = app.state::<crate::scene::SceneSession>();
    let mut hub = state.hub()?;
    crate::scene::scene_save_for(&mut hub, &label)
}

/// MCP stdio 桥程序路径：与主程序同目录的 mcp.exe（不存在时回退为裸文件名，供用户自行修正）。
fn mcp_stdio_command() -> String {
    const NAME: &str = if cfg!(windows) { "mcp.exe" } else { "mcp" };
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(NAME)))
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| NAME.to_string())
}

fn send_reply(
    tx: &SyncSender<String>,
    id: serde_json::Value,
    result: serde_json::Value,
    error: Option<String>,
) {
    let resp = serde_json::json!({ "id": id, "result": result, "error": error });
    if let Ok(s) = serde_json::to_string(&resp) {
        let _ = tx.send(s);
    }
}

/// 处理一条客户端命令：Rust 本地方法直接应答；其余转发编辑器窗口前端执行器。
fn dispatch_command(line: &str, rt: &DevToolsRuntime, app: &AppHandle, tx: &SyncSender<String>) {
    let msg: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };
    let id = msg.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let method = msg
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    let params = msg.get("params").cloned().unwrap_or(serde_json::Value::Null);

    match method.as_str() {
        "ping" => {
            send_reply(tx, id, serde_json::json!("pong"), None);
            return;
        }
        "editor.health" => {
            send_reply(
                tx,
                id,
                serde_json::json!({
                    "ok": true,
                    "port": rt.port,
                    "protocol": "tcp-jsonlines",
                }),
                None,
            );
            return;
        }
        _ => {}
    }

    // 权限门控（Rust 权威存储）→ Rust 本地执行（纯后端方法）→ 其余转发前端执行器。
    if let Err(msg) = require_tool(app, &method) {
        if let Some(s) = app.try_state::<DevToolsState>() {
            log_call(&s, "control", &method, false, 0, &msg);
        }
        send_reply(tx, id, serde_json::Value::Null, Some(msg));
        return;
    }
    if let Some(s) = app.try_state::<DevToolsState>() {
        log_call(&s, "control", &method, true, 0, "已受理（本地直答或转发编辑器）");
    }
    if let Some(res) = try_local(app, &method, &params) {
        match res {
            Ok(v) => send_reply(tx, id, v, None),
            Err(e) => send_reply(tx, id, serde_json::Value::Null, Some(e)),
        }
        return;
    }

    // 前端执行：登记待回复渠道，再发事件给活跃编辑器窗口的前端执行器。
    // 多会话：只有活跃编辑器窗口（最近聚焦的 editor-*）安装了监听器并持有引擎/场景状态。
    let active_label = match active_editor_label(app) {
        Some(l) => l,
        None => {
            send_reply(tx, id, serde_json::Value::Null, Some("没有活跃的编辑器窗口".to_string()));
            return;
        }
    };
    let token = uuid::Uuid::new_v4().to_string();
    rt.pending.lock().unwrap().insert(
        token.clone(),
        PendingResp {
            tx: tx.clone(),
            req_id: id.clone(),
        },
    );
    let payload =
        serde_json::json!({ "id": id, "method": method, "params": params, "replyToken": token });
    let _ = app.emit_to(active_label, "devtools:cmd", payload);
}

fn writer_loop(mut stream: TcpStream, rx: Receiver<String>, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::SeqCst) {
        match rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(msg) => {
                if stream.write_all(msg.as_bytes()).is_err() {
                    break;
                }
                if stream.write_all(b"\n").is_err() {
                    break;
                }
                let _ = stream.flush();
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => break,
        }
    }
}

fn reader_loop(
    reader: &mut BufReader<TcpStream>,
    rt: &DevToolsRuntime,
    app: &AppHandle,
    tx: &SyncSender<String>,
) {
    loop {
        if rt.stop.load(Ordering::SeqCst) {
            break;
        }
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break, // 客户端断开
            Ok(_) => {
                let s = line.trim();
                if !s.is_empty() {
                    dispatch_command(s, rt, app, tx);
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(_) => break,
        }
    }
}

fn spawn_client(stream: TcpStream, rt: Arc<DevToolsRuntime>, app: AppHandle) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(200)));
    let write_half = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut reader = BufReader::new(stream);
    // 探测协议：读第一行；以 HTTP 方法开头（POST / GET / PUT / DELETE）则按 HTTP（MCP）处理，
    // 否则按 JSON-lines 处理。一条连接只会是其中一种。
    let mut first = String::new();
    let is_http = match reader.read_line(&mut first) {
        Ok(_) => {
            let t = first.trim();
            t.starts_with("POST ")
                || t.starts_with("GET ")
                || t.starts_with("PUT ")
                || t.starts_with("DELETE ")
        }
        Err(_) => false,
    };

    if is_http {
        let rt_r = rt.clone();
        let app_r = app.clone();
        std::thread::spawn(move || {
            let _ = handle_http_conn(&mut reader, write_half, &rt_r, &app_r, first);
        });
        return;
    }

    // JSON-lines 客户端：注册广播目标（不参与 HTTP MCP）
    let (tx, rx) = sync_channel::<String>(256);
    rt.clients.lock().unwrap().push(tx.clone());
    let stop = rt.stop.clone();
    std::thread::spawn(move || writer_loop(write_half, rx, stop));
    let rt_r = rt.clone();
    let app_r = app.clone();
    std::thread::spawn(move || {
        let s = first.trim();
        if !s.is_empty() {
            dispatch_command(s, &rt_r, &app_r, &tx);
        }
        reader_loop(&mut reader, &rt_r, &app_r, &tx);
    });
}

fn accept_loop(listener: TcpListener, rt: Arc<DevToolsRuntime>, app: AppHandle) {
    let _ = listener.set_nonblocking(true);
    while !rt.stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _peer)) => spawn_client(stream, rt.clone(), app.clone()),
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => break,
        }
    }
}

/// 处理一条 MCP HTTP 连接：读取 POST /mcp 请求，构造 HTTP 响应写回。
fn handle_http_conn(
    reader: &mut BufReader<TcpStream>,
    mut write_half: TcpStream,
    rt: &DevToolsRuntime,
    app: &AppHandle,
    _request_line: String,
) {
    // 读请求头直到空行，统计 Content-Length
    let mut content_len = 0usize;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => return,
            Ok(_) => {
                let l = line.trim_end();
                if l.is_empty() {
                    break;
                }
                let lower = l.to_ascii_lowercase();
                if let Some(v) = lower.strip_prefix("content-length:") {
                    content_len = v.trim().parse().unwrap_or(0);
                }
            }
            Err(_) => return,
        }
    }
    // 读 body（JSON-RPC）
    let mut body = vec![0u8; content_len];
    let mut read = 0usize;
    while read < content_len {
        match reader.read(&mut body[read..]) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(_) => break,
        }
    }
    let body = String::from_utf8_lossy(&body).to_string();
    let resp = mcp_http_response(body.trim(), rt, app);
    let _ = write_half.write_all(&resp);
    let _ = write_half.flush();
}

/// 构造 MCP HTTP 响应（PUT/POST /mcp）。通知（无 id）返回空 body。
fn mcp_http_response(body: &str, rt: &DevToolsRuntime, app: &AppHandle) -> Vec<u8> {
    let msg: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => {
            let js = serde_json::json!({
                "jsonrpc": "2.0", "id": serde_json::Value::Null,
                "error": { "code": -32700, "message": "Parse error" }
            });
            return http_json(&js);
        }
    };
    // 通知（无 id）：不返回 JSON-RPC 响应
    if msg.get("id").is_none() {
        return "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .to_string()
            .into_bytes();
    }
    let resp = resolve_mcp(msg, rt, app);
    http_json(&resp)
}

fn http_json(value: &serde_json::Value) -> Vec<u8> {
    let js = serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string());
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        js.len(),
        js
    )
    .into_bytes()
}

/// 解析 MCP JSON-RPC 消息并返回响应。
fn resolve_mcp(msg: serde_json::Value, rt: &DevToolsRuntime, app: &AppHandle) -> serde_json::Value {
    let id = msg.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let method = msg
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    let params = msg
        .get("params")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    match method.as_str() {
        "initialize" => serde_json::json!({
            "jsonrpc": "2.0", "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "tve-devtools", "version": "0.1.0" },
            }
        }),
        "ping" => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "tools/list" => {
            let list = mcp_frontend_call(rt, app, "mcp.listTools", serde_json::json!({}));
            let tools = list
                .get("result")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([]));
            // 缓存 name -> method，供 tools/call 反查；同时把 method 字段从返回的工具里去掉
            let mut name_map = rt.name_to_method.lock().unwrap();
            let mut out = Vec::new();
            if let Some(arr) = tools.as_array() {
                for t in arr {
                    let name = t.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                    let method = t
                        .get("method")
                        .and_then(|m| m.as_str())
                        .unwrap_or("")
                        .to_string();
                    if !name.is_empty() && !method.is_empty() {
                        name_map.insert(name.clone(), method.clone());
                    }
                    let mut clean = t.clone();
                    if let Some(obj) = clean.as_object_mut() {
                        obj.remove("method");
                    }
                    out.push(clean);
                }
            }
            drop(name_map);
            serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": out } })
        }
        "tools/call" => {
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            if name.is_empty() {
                return serde_json::json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": { "content": [{ "type": "text", "text": "缺少工具名 name" }], "isError": true }
                });
            }
            let method = rt.name_to_method.lock().unwrap().get(&name).cloned();
            let method = match method {
                Some(m) => m,
                None => {
                    return serde_json::json!({
                        "jsonrpc": "2.0", "id": id,
                        "result": { "content": [{ "type": "text", "text": format!("未知工具: {}", name) }], "isError": true }
                    });
                }
            };
            // 权限门控 → Rust 本地直答（纯后端方法）→ 其余经前端执行器
            if let Err(msg) = require_tool(app, &method) {
                return serde_json::json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": { "content": [{ "type": "text", "text": msg }], "isError": true }
                });
            }
            let result = match try_local(app, &method, &args) {
                Some(Ok(v)) => serde_json::json!({ "result": v }),
                Some(Err(e)) => serde_json::json!({ "error": e }),
                None => mcp_frontend_call(rt, app, &method, args),
            };
            if let Some(err) = result.get("error").and_then(|e| e.as_str()) {
                serde_json::json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": { "content": [{ "type": "text", "text": err.to_string() }], "isError": true }
                })
            } else {
                let r = result.get("result").cloned().unwrap_or_else(|| serde_json::json!(null));
                let text = serde_json::to_string_pretty(&r).unwrap_or_else(|_| String::new());
                serde_json::json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": { "content": [{ "type": "text", "text": text }], "isError": false }
                })
            }
        }
        _ => serde_json::json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": -32601, "message": format!("未知方法: {}", method) }
        }),
    }
}

/// 经前端执行器执行一个 devtools 方法（MCP tools/list / tools/call 用），等待前端回填。
fn mcp_frontend_call(
    rt: &DevToolsRuntime,
    app: &AppHandle,
    method: &str,
    params: serde_json::Value,
) -> serde_json::Value {
    let token = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = sync_channel::<serde_json::Value>(1);
    rt.http_pending.lock().unwrap().insert(token.clone(), tx);
    let payload = serde_json::json!({ "id": 1, "method": method, "params": params, "replyToken": token });
    let _ = app.emit("devtools:cmd", payload);
    let resp = rx
        .recv_timeout(std::time::Duration::from_secs(12))
        .unwrap_or_else(|_| serde_json::json!({ "error": "前端未响应（超时）" }));
    rt.http_pending.lock().unwrap().remove(&token);
    resp
}

/// 控制服务器默认端口（应用启动时自动绑定；被占用时回退随机端口）
pub const DEFAULT_PORT: u16 = 39100;

/// 启动控制服务器核心（幂等：已在运行则直接返回现有信息）。
/// `devtools_start` 命令与 lib.rs 的 setup 自动启动共用此入口。
pub fn start_runtime(app: &AppHandle, port: Option<u16>) -> Result<DevToolsInfo, String> {
    let state = app.state::<DevToolsState>();
    {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        if let Some(rt) = guard.as_ref() {
            return Ok(rt.info());
        }
    }
    // 固定端口：指定的正整数绑定到 127.0.0.1:port（端口被占用则报错）；否则随机端口。
    let addr = match port {
        Some(p) if p > 0 => format!("127.0.0.1:{}", p),
        _ => "127.0.0.1:0".to_string(),
    };
    let listener = TcpListener::bind(&addr).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = uuid::Uuid::new_v4().to_string();
    let stop = Arc::new(AtomicBool::new(false));
    let rt = Arc::new(DevToolsRuntime {
        port,
        token: token.clone(),
        clients: Mutex::new(Vec::new()),
        pending: Mutex::new(HashMap::new()),
        http_pending: Mutex::new(HashMap::new()),
        name_to_method: Mutex::new(HashMap::new()),
        stop: stop.clone(),
    });
    let rt_bg = rt.clone();
    let app_bg = app.clone();
    std::thread::spawn(move || accept_loop(listener, rt_bg, app_bg));
    *state.inner.lock().map_err(|e| e.to_string())? = Some(rt.clone());
    Ok(rt.info())
}

/// 应用启动时自动开启控制服务器（后台线程；默认端口被占用则回退随机端口）。
/// 失败仅打日志，不阻断应用启动。
pub fn autostart(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Err(bind_err) = start_runtime(&handle, Some(DEFAULT_PORT)) {
            match start_runtime(&handle, None) {
                Ok(info) => eprintln!(
                    "[devtools] 默认端口 {} 被占用（{}），已改用随机端口 {}",
                    DEFAULT_PORT, bind_err, info.port
                ),
                Err(e) => eprintln!("[devtools] 控制服务器自动启动失败: {e}"),
            }
        }
    });
}

/// 启动开发者服务控制服务器（幂等：已在运行则直接返回现有信息）
#[tauri::command]
pub async fn devtools_start(app: AppHandle, port: Option<u16>) -> Result<DevToolsInfo, String> {
    start_runtime(&app, port)
}

/// 停止开发者服务控制服务器
#[tauri::command]
pub async fn devtools_stop(state: State<'_, DevToolsState>) -> Result<(), String> {
    if let Some(rt) = state.inner.lock().map_err(|e| e.to_string())?.take() {
        rt.stop.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// 是否已启用（以及连接信息）
#[tauri::command]
pub async fn devtools_status(
    state: State<'_, DevToolsState>,
) -> Result<Option<DevToolsInfo>, String> {
    Ok(state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|rt| rt.info()))
}

/// 最近的工具调用记录（助手 + 控制端统一入账，最新在后）
#[tauri::command]
pub async fn devtools_recent_calls(
    state: State<'_, DevToolsState>,
) -> Result<Vec<CallLogEntry>, String> {
    Ok(state.call_log.lock().map_err(|e| e.to_string())?.clone())
}

/// 助手等进程内调用方执行一条 devtools 方法（统一走内部 devtools 通道）：
/// 权限门控 → Rust 本地直答 → 转发活跃编辑器前端执行器并等待回填（60s 超时）。
/// 与控制服务器启停无关（不走 TCP runtime，internal_pending 直达 devtools_reply）。
/// 本地直答会 block_on 异步锁，因此整段放进阻塞线程池执行——
/// 异步命令线程属于 tokio 运行时，在其中 block_on 会 panic。
/// pub(crate)：大脑决策中心（brain::execute）按命令模式派发时复用同一通道。
#[tauri::command]
pub async fn devtools_internal_call(
    app: AppHandle,
    method: String,
    params: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let params = params.unwrap_or(serde_json::Value::Null);
    tauri::async_runtime::spawn_blocking(move || internal_call_blocking(&app, method, params))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn internal_call_blocking(
    app: &AppHandle,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let state = app.state::<DevToolsState>();
    // 助手调用与控制端同源：开发者服务未运行则拒绝（首页可开启）
    let service_on = state.inner.lock().map_err(|e| e.to_string())?.is_some();
    if !service_on {
        log_call(&state, "assistant", &method, false, 0, "开发者服务未运行，拒绝执行");
        return Err("开发者服务未运行：请在首页「开发者服务」中开启后再让助手执行工具".to_string());
    }
    let started = std::time::Instant::now();
    if let Err(e) = require_tool(app, &method) {
        log_call(&state, "assistant", &method, false, 0, &e);
        return Err(e);
    }
    let result = internal_dispatch(app, &method, params);
    let ms = started.elapsed().as_millis() as u64;
    match &result {
        Ok(v) => log_call(&state, "assistant", &method, true, ms, &value_digest(v)),
        Err(e) => log_call(&state, "assistant", &method, false, ms, e),
    }
    result
}

/// 结果值摘要（日志展示用：标量直接取，容器取序列化前 160 字符，由 log_call 截断）
fn value_digest(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// 权限门控之后的实际执行段（本地直答 → 转发活跃编辑器执行器并等待回填）
fn internal_dispatch(
    app: &AppHandle,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if let Some(res) = try_local(app, method, &params) {
        return res;
    }
    let active_label =
        active_editor_label(app).ok_or("没有活跃的编辑器窗口（请先打开项目进入编辑器）")?;
    let state = app.state::<DevToolsState>();
    let token = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = sync_channel::<Result<serde_json::Value, String>>(1);
    state
        .internal_pending
        .lock()
        .map_err(|e| e.to_string())?
        .insert(token.clone(), tx);
    let payload = serde_json::json!({
        "id": 1,
        "method": method,
        "params": params,
        "replyToken": token,
    });
    let _ = app.emit_to(active_label, "devtools:cmd", payload);
    match rx.recv_timeout(std::time::Duration::from_secs(60)) {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("编辑器执行超时（60s）".to_string()),
    }
}

/// 前端执行器回填命令结果（按 replyToken 路由回对应客户端）
#[tauri::command]
pub async fn devtools_reply(
    state: State<'_, DevToolsState>,
    token: String,
    result: Option<serde_json::Value>,
    error: Option<String>,
) -> Result<(), String> {
    // 进程内调用方（助手桥）优先：不依赖控制服务器运行态，服务器停开都可达
    if let Some(h) = state
        .internal_pending
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&token)
    {
        let _ = h.send(match error {
            Some(e) => Err(e),
            None => Ok(result.unwrap_or(serde_json::Value::Null)),
        });
        return Ok(());
    }
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    let Some(rt) = guard.as_ref() else {
        return Ok(());
    };
    if let Some(p) = rt.pending.lock().unwrap().remove(&token) {
        let resp = serde_json::json!({
            "id": p.req_id,
            "result": result.unwrap_or(serde_json::Value::Null),
            "error": error,
        });
        if let Ok(s) = serde_json::to_string(&resp) {
            let _ = p.tx.send(s);
        }
    } else if let Some(h) = rt.http_pending.lock().unwrap().remove(&token) {
        // MCP HTTP 请求：把 {result, error} 送回 HTTP 处理器构造成 JSON-RPC 响应
        let resp = serde_json::json!({
            "result": result.unwrap_or(serde_json::Value::Null),
            "error": error,
        });
        let _ = h.send(resp);
    }
    Ok(())
}

/// 前端推送事件（console / 日志 / 状态变化）广播给所有客户端
#[tauri::command]
pub async fn devtools_push(
    state: State<'_, DevToolsState>,
    event: String,
    data: serde_json::Value,
) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    let Some(rt) = guard.as_ref() else {
        return Ok(());
    };
    let msg = serde_json::json!({ "event": event, "data": data });
    let Ok(s) = serde_json::to_string(&msg) else {
        return Ok(());
    };
    let clients = rt.clients.lock().unwrap();
    for tx in clients.iter() {
        let _ = tx.send(s.clone());
    }
    Ok(())
}
