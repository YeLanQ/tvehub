//! 统一任务调度框架：长任务（导出/导入/烘焙等）的注册、进度报告、取消与多项目隔离。
//!
//! 设计：
//! - `TaskManager`（Tauri managed state）持有所有活跃任务的取消标志与状态；
//! - 长任务启动时 `register` 获得 `TaskHandle`（含 cancel token + 进度报告器）；
//! - 任务执行中定期检查 `handle.is_cancelled()`，通过 `handle.report_progress` 广播进度；
//! - 完成时 `deregister` 移除；超时由调用方在 spawn 时设定；
//! - 多项目隔离：每个任务关联 `root`（项目根），`cancel_by_root` 可批量取消某项目全部任务。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use tauri::{Emitter, Runtime};
use uuid::Uuid;

pub type TaskId = String;

/// 任务优先级（数值越大越优先；当前仅用于 UI 展示排序，调度均为 FIFO）
// Low/High 暂无生产注册方传入（当前仅 build_export 传 Normal），作为跨端 API
// 预留：前端 TaskPriority 同为 low/normal/high 三档（src/lib/api.ts），测试覆盖全部档位
#[allow(dead_code)]
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    Low,
    Normal,
    High,
}

impl Default for Priority {
    fn default() -> Self {
        Self::Normal
    }
}

/// 任务状态快照（事件广播 + 前端查询用）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatus {
    pub id: TaskId,
    /// 任务类型标识（"export" / "import" / "bake" / …），前端按类型渲染图标/文案
    pub kind: String,
    /// 关联项目根（None = 全局任务，不与特定项目绑定）
    pub root: Option<String>,
    pub priority: Priority,
    /// 进度 0.0 – 1.0（-1 = 不确定进度）
    pub progress: f64,
    /// 人类可读进度描述
    pub message: String,
    pub running: bool,
    pub cancelled: bool,
}

/// 取消标志（Arc 可跨线程 clone 共享）
#[derive(Clone)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

struct TaskEntry {
    status: TaskStatus,
    cancel: CancelToken,
    #[allow(dead_code)]
    started: Instant,
}

/// 任务管理器（Tauri managed state）
#[derive(Default)]
pub struct TaskManager {
    inner: Mutex<HashMap<TaskId, TaskEntry>>,
}

/// 任务句柄：注册后返回，供任务执行体检查取消与报告进度。
/// 泛型 R 支持不同 runtime（生产 Wry + 测试 MockRuntime）。
pub struct TaskHandle<R: Runtime> {
    pub id: TaskId,
    pub cancel: CancelToken,
    app: tauri::AppHandle<R>,
}

impl<R: Runtime> TaskHandle<R> {
    /// 是否已被取消
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// 广播进度更新事件（progress: 0.0–1.0，-1 = 不确定）
    pub fn report_progress(&self, progress: f64, message: &str) {
        let _ = self.app.emit(
            "task:progress",
            TaskProgressEvent {
                id: self.id.clone(),
                progress,
                message: message.to_string(),
            },
        );
    }

    /// 广播任务完成事件
    pub fn report_completed(&self, success: bool, message: &str) {
        let _ = self.app.emit(
            "task:completed",
            TaskCompletedEvent {
                id: self.id.clone(),
                success,
                message: message.to_string(),
            },
        );
    }
}

/// 进度事件（task:progress）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgressEvent {
    pub id: TaskId,
    pub progress: f64,
    pub message: String,
}

/// 完成事件（task:completed）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCompletedEvent {
    pub id: TaskId,
    pub success: bool,
    pub message: String,
}

impl TaskManager {
    /// 注册新任务，返回句柄（含 cancel token + 进度报告器）
    pub fn register<R: Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        kind: &str,
        root: Option<&str>,
        priority: Priority,
    ) -> TaskHandle<R> {
        let (id, cancel) = self.register_entry(kind, root, priority);
        TaskHandle {
            id,
            cancel,
            app: app.clone(),
        }
    }

    /// 注册任务条目到内部表（不创建 TaskHandle，无需 AppHandle；测试 + 内部用）
    fn register_entry(
        &self,
        kind: &str,
        root: Option<&str>,
        priority: Priority,
    ) -> (TaskId, CancelToken) {
        let id = Uuid::new_v4().to_string();
        let cancel = CancelToken::new();
        let status = TaskStatus {
            id: id.clone(),
            kind: kind.to_string(),
            root: root.map(|s| s.to_string()),
            priority,
            progress: 0.0,
            message: String::new(),
            running: true,
            cancelled: false,
        };
        self.inner.lock().unwrap().insert(
            id.clone(),
            TaskEntry {
                status,
                cancel: cancel.clone(),
                started: Instant::now(),
            },
        );
        (id, cancel)
    }

    /// 注销任务（完成或失败后调用）
    pub fn deregister(&self, id: &str) {
        self.inner.lock().unwrap().remove(id);
    }

    /// 取消指定任务
    pub fn cancel(&self, id: &str) -> bool {
        let map = self.inner.lock().unwrap();
        if let Some(entry) = map.get(id) {
            entry.cancel.cancel();
            true
        } else {
            false
        }
    }

    /// 批量取消某项目的全部活跃任务
    pub fn cancel_by_root(&self, root: &str) -> usize {
        let map = self.inner.lock().unwrap();
        let mut count = 0;
        for entry in map.values() {
            if entry.status.root.as_deref() == Some(root) {
                entry.cancel.cancel();
                count += 1;
            }
        }
        count
    }

    /// 列出活跃任务状态（可选按项目过滤）
    pub fn list(&self, root: Option<&str>) -> Vec<TaskStatus> {
        let map = self.inner.lock().unwrap();
        map.values()
            .filter(|e| root.map_or(true, |r| e.status.root.as_deref() == Some(r)))
            .map(|e| e.status.clone())
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 取消指定任务
#[tauri::command]
pub async fn cancel_task(
    state: tauri::State<'_, TaskManager>,
    id: String,
) -> Result<bool, String> {
    Ok(state.cancel(&id))
}

/// 批量取消某项目的全部任务
#[tauri::command]
pub async fn cancel_tasks_by_root(
    state: tauri::State<'_, TaskManager>,
    root: String,
) -> Result<usize, String> {
    Ok(state.cancel_by_root(&root))
}

/// 列出活跃任务（可选按项目根过滤）
#[tauri::command]
pub async fn list_tasks(
    state: tauri::State<'_, TaskManager>,
    root: Option<String>,
) -> Result<Vec<TaskStatus>, String> {
    Ok(state.list(root.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_token_works() {
        let token = CancelToken::new();
        assert!(!token.is_cancelled());
        token.cancel();
        assert!(token.is_cancelled());
    }

    #[test]
    fn task_manager_register_cancel_deregister() {
        let mgr = TaskManager::default();
        let (id, cancel) = mgr.register_entry("test", Some("/proj"), Priority::Normal);
        assert!(!cancel.is_cancelled());
        assert!(mgr.cancel(&id));
        assert!(cancel.is_cancelled());
        assert_eq!(mgr.list(None).len(), 1);
        mgr.deregister(&id);
        assert_eq!(mgr.list(None).len(), 0);
    }

    #[test]
    fn cancel_by_root_cancels_matching_tasks() {
        let mgr = TaskManager::default();
        let (id1, h1) = mgr.register_entry("export", Some("/proj-a"), Priority::High);
        let (_id2, h2) = mgr.register_entry("import", Some("/proj-a"), Priority::Normal);
        let (_id3, h3) = mgr.register_entry("export", Some("/proj-b"), Priority::Normal);
        let _ = id1;
        let count = mgr.cancel_by_root("/proj-a");
        assert_eq!(count, 2);
        assert!(h1.is_cancelled());
        assert!(h2.is_cancelled());
        assert!(!h3.is_cancelled());
    }

    #[test]
    fn list_filters_by_root() {
        let mgr = TaskManager::default();
        mgr.register_entry("export", Some("/a"), Priority::Normal);
        mgr.register_entry("import", Some("/b"), Priority::Normal);
        mgr.register_entry("bake", None, Priority::Low);
        assert_eq!(mgr.list(None).len(), 3);
        assert_eq!(mgr.list(Some("/a")).len(), 1);
        assert_eq!(mgr.list(Some("/b")).len(), 1);
    }
}
