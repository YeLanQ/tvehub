// ---------------------------------------------------------------------------
// 项目目录文件监听（外部改动感知）：
// notify 递归监听当前项目根，事件去抖（静默 500ms）后以 `fs-changed` 事件推送
// 变更相对路径列表给前端；前端据此失效材质/贴图/模型/音频等内存缓存并重扫资产
// 面板——外部工具（VSCode/PS 等）改完文件，编辑器无需重启即用新内容。
// 编辑器自身的写盘（场景保存/资产导入等）同样会产生事件，但前端按内容重读均
// 幂等，无副作用；`.tmp`（预览导出）/`build`（构建产物）与点目录（.git 等）
// 直接过滤，避免导出/构建过程触发无意义刷新。
// ---------------------------------------------------------------------------

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify::{EventKind, RecursiveMode, RecommendedWatcher, Watcher};
use tauri::{AppHandle, Emitter};

/// 监听状态：当前工程的监听句柄（None = 未监听/项目已关闭）
#[derive(Default)]
pub struct WatcherState {
    handle: std::sync::Mutex<Option<ProjectWatcher>>,
}

/// 持有 watcher 即持有监听生命周期：drop 时 notify 停止投递，事件通道随之
/// 断开（去抖线程收到 Disconnected 退出）。
struct ProjectWatcher {
    _watcher: RecommendedWatcher,
}

/// 静默窗口：最后一次事件后等待该时长无新事件才推送（编辑器与外部工具常连写
/// 多个文件，合并为一次刷新）
const DEBOUNCE_QUIET: Duration = Duration::from_millis(500);
/// 去抖轮询间隔
const DEBOUNCE_TICK: Duration = Duration::from_millis(200);
/// 单次推送的最大路径数（超出截断；资产面板重扫本就是全量，失效缓存取前缀即可）
const MAX_PATHS_PER_FLUSH: usize = 256;

/// 更新监听目标（root = None 停止）。失败仅记录日志，不影响打开项目主流程。
pub fn watch_project_root(state: &WatcherState, app: &AppHandle, root: Option<PathBuf>) {
    let mut slot = state.handle.lock().unwrap();
    // 先停旧监听（drop 旧句柄；换项目/关项目都必须先断开旧目录）
    *slot = None;
    let Some(root) = root else {
        return;
    };
    let (tx, rx) = channel::<notify::Result<notify::Event>>();
    let mut watcher = match notify::recommended_watcher(move |res| {
        // 接收端已退出时投递失败，忽略即可
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[watcher] 创建文件监听失败: {e}");
            return;
        }
    };
    if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
        eprintln!("[watcher] 监听目录失败 {}: {e}", root.display());
        return;
    }
    let root_for_thread = root.clone();
    // AppHandle 需 clone 出所有权才能移入 'static 去抖线程（借用逃逸报 E0521）
    let app_for_thread = app.clone();
    if let Err(e) = std::thread::Builder::new()
        .name("fs-watch-debounce".into())
        .spawn(move || debounce_loop(rx, root_for_thread, app_for_thread))
    {
        eprintln!("[watcher] 去抖线程启动失败: {e}");
        return;
    }
    *slot = Some(ProjectWatcher { _watcher: watcher });
}

/// 去抖主循环：累积变更相对路径，静默 DEBOUNCE_QUIET 后一次性推送
fn debounce_loop(rx: Receiver<notify::Result<notify::Event>>, root: PathBuf, app: AppHandle) {
    let mut pending: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut last_change = Instant::now();
    loop {
        match rx.recv_timeout(DEBOUNCE_TICK) {
            Ok(Ok(event)) => {
                // 只关心内容/增删变化；Access（读取）等事件不触发刷新
                if matches!(
                    event.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                ) {
                    for path in event.paths {
                        if let Some(rel) = rel_path(&root, &path) {
                            if seen.insert(rel.clone()) {
                                pending.push(rel);
                            }
                        }
                    }
                    last_change = Instant::now();
                }
            }
            Ok(Err(e)) => eprintln!("[watcher] 文件事件错误: {e}"),
            Err(RecvTimeoutError::Timeout) => {
                if pending.is_empty() || last_change.elapsed() < DEBOUNCE_QUIET {
                    continue;
                }
                pending.truncate(MAX_PATHS_PER_FLUSH);
                let payload = serde_json::json!({
                    "root": root.to_string_lossy(),
                    "paths": pending,
                });
                let _ = app.emit("fs-changed", payload);
                pending = Vec::new();
                seen.clear();
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// 绝对路径 → 项目相对路径（正斜杠；越出项目根或命中过滤目录返回 None）。
/// 过滤：点目录/点文件（.git/.tmp/.vscode…）与构建/依赖目录——预览导出与构建
/// 产物由编辑器自己写入，回环刷新没有意义。
fn rel_path(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let rel = rel.to_string_lossy().replace('\\', "/");
    if rel.is_empty() {
        return None;
    }
    for seg in rel.split('/') {
        if seg.starts_with('.') || seg == "build" || seg == "node_modules" {
            return None;
        }
    }
    Some(rel)
}
