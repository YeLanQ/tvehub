//! 局域网共享：统一配置 + 共享地址（含二维码载荷）+ 产物站点服务。
//!
//! 定位：把应用里做出来的东西（白板、构建产物、任意目录）用一条稳定的局域网址
//! 发布出去，手机/同网段机器浏览器直接打开。桌面端负责生成地址与二维码，本模块
//! 负责真正把内容服务出去。
//!
//! 子模块分工：
//! - [`config`]：全局唯一的一份共享配置（启停/端口/绑定网卡/设备名/访问口令）；
//! - [`net`]：本机局域网地址发现与排序（决定「手机该扫哪个 IP」）；
//! - [`share`]：共享清单与发布（托管站点写入 / 目录引用 / 启停 / 删除）；
//! - [`server`]：局域网上常驻的极简静态服务（路由 + 路径守卫 + 口令闸门）；
//! - [`pages`]：服务端渲染的两张页面（共享索引页、口令解锁页）。
//!
//! 两种站点根：`managed=true` 托管站点（发布时写入 `sites/<id>/`，随共享删除）、
//! `managed=false` 目录引用（直接服务外部目录，内容始终与源同步，不复制）。
//!
//! 安全边界（写清楚，避免误用）：服务走明文 HTTP，访问口令只是「防误入」的轻量
//! 闸门，不构成安全边界；服务端只读不写，只暴露被共享目录下的文件。

mod commands;
mod config;
mod net;
mod pages;
mod routes;
mod server;
mod site;
mod share;
mod theme;

// 命令按模块组织，但从模块根再导出：lib.rs 的命令注册表保持 lanshare::<命令> 的读法
pub use commands::*;
pub use config::LanShareConfig;
pub use net::LanAddress;
pub use share::LanShare;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::appdirs;

/// 默认端口：避开开发者服务（39100）与网页预览（39110）的常用区间
pub const DEFAULT_PORT: u16 = 39200;

/// 共享数据根目录（配置、清单、托管站点都在这里）
fn base_dir(app: &tauri::AppHandle) -> PathBuf {
    appdirs::config_root(app).join("lan-share")
}

/// 托管站点根目录（每条共享一个 `<id>/` 子目录）
fn sites_dir(app: &tauri::AppHandle) -> PathBuf {
    base_dir(app).join("sites")
}

/// 当前时间毫秒（列表排序与「最近访问」展示用）
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/// 一条共享的访问统计（只存内存：落盘没有价值，重启归零更符合直觉）
#[derive(Clone, Default)]
pub(super) struct AccessStat {
    pub hits: u64,
    pub last_access: u64,
    pub last_client: String,
}

/// 正在运行的服务句柄
pub(super) struct RunningServer {
    /// 实际绑定地址（端口可能与配置不同：被占用时回退系统分配）
    pub bound: std::net::SocketAddr,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl RunningServer {
    pub(super) fn new(
        bound: std::net::SocketAddr,
        shutdown: Arc<std::sync::atomic::AtomicBool>,
        handle: std::thread::JoinHandle<()>,
    ) -> Self {
        Self {
            bound,
            shutdown,
            handle: Some(handle),
        }
    }

    /// 停止服务并回收线程（置信号 + join；accept 循环最慢 20ms 内退出）
    pub(super) fn stop(&mut self) {
        self.shutdown
            .store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// 配置/清单/统计都用 `Arc<Mutex<_>>` 持有：服务线程读的是同一份数据，
/// 改这些内容对后续请求立即生效（改端口/绑定地址则要重启监听，见命令层）。
pub(super) struct LanShareInner {
    /// 是否已从磁盘载入
    loaded: bool,
    pub config: Arc<Mutex<LanShareConfig>>,
    pub shares: Arc<Mutex<Vec<LanShare>>>,
    pub stats: Arc<Mutex<HashMap<String, AccessStat>>>,
    pub server: Option<RunningServer>,
    /// 需要让用户看到的信息（端口被占用回退等）
    pub notice: Option<String>,
}

impl Default for LanShareInner {
    fn default() -> Self {
        Self {
            loaded: false,
            config: Arc::new(Mutex::new(LanShareConfig::default())),
            shares: Arc::new(Mutex::new(Vec::new())),
            stats: Arc::new(Mutex::new(HashMap::new())),
            server: None,
            notice: None,
        }
    }
}

#[derive(Default)]
pub struct LanShareState {
    inner: Mutex<LanShareInner>,
}

impl LanShareState {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, LanShareInner>, String> {
        self.inner
            .lock()
            .map_err(|_| "局域网共享状态锁失效".to_string())
    }
}

/// 对外状态快照（前端据此渲染地址、二维码与共享列表）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanShareStatus {
    pub config: LanShareConfig,
    pub running: bool,
    pub port: u16,
    pub bound: String,
    pub notice: Option<String>,
    /// 每个候选地址一条可直接拼链接的 base URL
    pub urls: Vec<LanShareUrl>,
    pub shares: Vec<LanShare>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanShareUrl {
    pub ip: String,
    pub primary: bool,
    pub private: bool,
    pub url: String,
}

/// 组装状态快照。`addresses` 由调用方在锁外探测后传入（探测要起进程，不宜持锁做）。
fn status(inner: &LanShareInner, addresses: &[LanAddress]) -> LanShareStatus {
    let config = inner.config.lock().map(|c| c.clone()).unwrap_or_default();
    let mut shares = inner.shares.lock().map(|s| s.clone()).unwrap_or_default();
    if let Ok(stats) = inner.stats.lock() {
        for share in shares.iter_mut() {
            if let Some(stat) = stats.get(&share.id) {
                share.hits = stat.hits;
                share.last_access = stat.last_access;
                share.last_client = stat.last_client.clone();
            }
        }
    }

    let running = inner.server.is_some();
    let port = inner
        .server
        .as_ref()
        .map(|s| s.bound.port())
        .unwrap_or(config.port);
    let bound = inner
        .server
        .as_ref()
        .map(|s| s.bound.to_string())
        .unwrap_or_default();

    // 绑定了具体网卡就只给那一个地址；否则列出全部候选（前端取首选编二维码）
    let mut urls: Vec<LanShareUrl> = Vec::new();
    if let Ok(fixed) = config.host.parse::<std::net::Ipv4Addr>() {
        urls.push(LanShareUrl {
            ip: fixed.to_string(),
            primary: true,
            private: net::is_private_v4(fixed),
            url: format!("http://{fixed}:{port}/"),
        });
    } else {
        for addr in addresses {
            urls.push(LanShareUrl {
                primary: addr.primary,
                private: addr.private,
                url: format!("http://{}:{port}/", addr.ip),
                ip: addr.ip.clone(),
            });
        }
    }
    // 一个网卡地址都探测不到时给回环兜底（本机自测用，手机扫不到）
    if urls.is_empty() {
        urls.push(LanShareUrl {
            ip: "127.0.0.1".into(),
            primary: true,
            private: false,
            url: format!("http://127.0.0.1:{port}/"),
        });
    }

    LanShareStatus {
        config,
        running,
        port,
        bound,
        notice: inner.notice.clone(),
        urls,
        shares,
    }
}

// ---------------------------------------------------------------------------
// 内部动作
// ---------------------------------------------------------------------------

/// 惰性载入配置与清单（首次访问时读盘一次）
fn ensure_loaded(app: &tauri::AppHandle, state: &LanShareState) -> Result<(), String> {
    let mut inner = state.lock()?;
    if inner.loaded {
        return Ok(());
    }
    let config = config::load(app);
    let shares = share::load(app);
    *inner.config.lock().map_err(|_| "配置锁失效".to_string())? = config;
    *inner.shares.lock().map_err(|_| "清单锁失效".to_string())? = shares;
    inner.loaded = true;
    Ok(())
}

/// 停服并清掉提示（幂等）
fn stop_running(inner: &mut LanShareInner) {
    if let Some(mut server) = inner.server.take() {
        server.stop();
    }
    inner.notice = None;
}

/// 确保服务在运行：发布类命令共用这一步——用户点「共享」的意图就是要能访问到，
/// 顺带把 enabled 落盘，下次启动可自动续上。
fn ensure_running(app: &tauri::AppHandle, inner: &mut LanShareInner) -> Result<(), String> {
    if inner.server.is_some() {
        return Ok(());
    }
    let config = inner
        .config
        .lock()
        .map_err(|_| "配置锁失效".to_string())?
        .clone();
    // 先起服务再落 enabled：起不来就保持原状，状态如实显示「未开启」，
    // 不留下「配置说开着、实际没在听」的假象
    let (server, notice) = server::start(inner, config)?;
    inner.server = Some(server);
    inner.notice = notice;
    let mut guard = inner.config.lock().map_err(|_| "配置锁失效".to_string())?;
    if !guard.enabled {
        guard.enabled = true;
        config::save(app, &guard)?;
    }
    Ok(())
}

/// 应用启动时的自动开服（`setup` 里调用；放后台线程，探测网卡会起进程，
/// 不阻塞启动；失败只记日志）
pub fn autostart(app: &tauri::AppHandle) {
    use tauri::Manager;
    let handle = app.clone();
    std::thread::spawn(move || {
        let state = handle.state::<LanShareState>();
        if let Err(e) = ensure_loaded(&handle, &state) {
            eprintln!("[lanshare] 载入共享配置失败: {e}");
            return;
        }
        let (auto, enabled) = match state.lock() {
            Ok(inner) => match inner.config.lock() {
                Ok(c) => (c.auto_start, c.enabled),
                Err(_) => return,
            },
            Err(_) => return,
        };
        if !auto || !enabled {
            return;
        }
        let addresses = net::addresses_info();
        let result = state.lock().and_then(|mut inner| {
            ensure_running(&handle, &mut inner)?;
            Ok(status(&inner, &addresses))
        });
        match result {
            Ok(s) => println!("[lanshare] 已自动开启局域网共享: {}", s.bound),
            Err(e) => eprintln!("[lanshare] 自动开启失败: {e}"),
        }
    });
}
