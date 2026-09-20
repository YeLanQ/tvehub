//! 局域网共享的 Tauri 命令层：前端唯一的入口。
//!
//! 这一层只做「取参 → 协调状态 → 返回状态快照」，不写业务判断——共享的增删改查在
//! `share`，站点文件在 `site`，配置在 `config`，地址发现在 `net`。所有写操作都
//! 返回完整的 `LanShareStatus`，前端整份覆盖本地状态，避免前后端两份状态各自演化。
//!
//! 地址探测（要起进程读网卡）一律在持锁之前做，不在临界区里做慢操作。
use super::config::LanShareConfigPatch;
use super::net::{self, LanNetInfo};
use super::share::{self, AddDirRequest, PublishSiteRequest};
use super::{
    config, ensure_loaded, ensure_running, status, stop_running, LanShareState, LanShareStatus,
};

// 命令
// ---------------------------------------------------------------------------

/// 当前状态（配置 + 地址候选 + 共享列表）：前端进入局域网分区时先拉这个
#[tauri::command]
pub async fn lan_share_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, LanShareState>,
) -> Result<LanShareStatus, String> {
    ensure_loaded(&app, &state)?;
    let addresses = net::addresses_info();
    let inner = state.lock()?;
    Ok(status(&inner, &addresses))
}

/// 本机地址清单（配置页的地址下拉与排查用）
#[tauri::command]
pub async fn lan_share_net_info(
    app: tauri::AppHandle,
    state: tauri::State<'_, LanShareState>,
) -> Result<LanNetInfo, String> {
    ensure_loaded(&app, &state)?;
    let inner = state.lock()?;
    let device_name = inner
        .config
        .lock()
        .map(|c| c.device_name.clone())
        .unwrap_or_default();
    drop(inner);
    Ok(net::net_info(&device_name))
}

/// 改配置（补丁式，只改传入字段）。端口 / 绑定网卡 / 访问口令变化时重启监听。
#[tauri::command]
pub async fn lan_share_set_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, LanShareState>,
    patch: LanShareConfigPatch,
) -> Result<LanShareStatus, String> {
    ensure_loaded(&app, &state)?;
    let addresses = net::addresses_info();
    let mut inner = state.lock()?;

    // 先在副本上应用补丁：落盘成功才写回内存，写失败则整体不生效，
    // 不会出现「内存已改、磁盘还是旧值」的分裂状态
    let (before, next) = {
        let guard = inner.config.lock().map_err(|_| "配置锁失效".to_string())?;
        let before = guard.clone();
        let mut next = before.clone();
        next.apply(patch);
        (before, next)
    };
    let listener_changed = next.port != before.port
        || next.host != before.host
        || next.access_code != before.access_code;
    config::save(&app, &next)?;
    *inner.config.lock().map_err(|_| "配置锁失效".to_string())? = next.clone();

    if listener_changed {
        stop_running(&mut inner);
    }
    if next.enabled {
        ensure_running(&app, &mut inner)?;
    } else {
        stop_running(&mut inner);
    }
    Ok(status(&inner, &addresses))
}

/// 开服
#[tauri::command]
pub async fn lan_share_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, LanShareState>,
) -> Result<LanShareStatus, String> {
    ensure_loaded(&app, &state)?;
    let addresses = net::addresses_info();
    let mut inner = state.lock()?;
    ensure_running(&app, &mut inner)?;
    Ok(status(&inner, &addresses))
}

/// 停服（配置保留，enabled 置否）
#[tauri::command]
pub async fn lan_share_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, LanShareState>,
) -> Result<LanShareStatus, String> {
    ensure_loaded(&app, &state)?;
    let addresses = net::addresses_info();
    let mut inner = state.lock()?;
    {
        let mut guard = inner.config.lock().map_err(|_| "配置锁失效".to_string())?;
        if guard.enabled {
            guard.enabled = false;
            config::save(&app, &guard)?;
        }
    }
    stop_running(&mut inner);
    Ok(status(&inner, &addresses))
}

/// 发布托管站点（整站覆盖写）：白板放映页、自建网页产物等文本产物走这条。
/// 传 `shareId` 则原地更新，省略则按 `source` 复用或新建。
#[tauri::command]
pub async fn lan_share_publish_site(
    app: tauri::AppHandle,
    state: tauri::State<'_, LanShareState>,
    req: PublishSiteRequest,
) -> Result<LanShareStatus, String> {
    ensure_loaded(&app, &state)?;
    let addresses = net::addresses_info();
    let mut inner = state.lock()?;
    {
        let mut shares = inner.shares.lock().map_err(|_| "清单锁失效".to_string())?;
        share::publish_site(&app, &mut shares, req)?;
        share::save(&app, &shares)?;
    }
    ensure_running(&app, &mut inner)?;
    Ok(status(&inner, &addresses))
}

/// 按引用共享一个外部目录（构建产物 / 网页预览产物 / 任意文件夹）：
/// 不复制文件，源目录一变访问者立即可见。
#[tauri::command]
pub async fn lan_share_add_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, LanShareState>,
    req: AddDirRequest,
) -> Result<LanShareStatus, String> {
    ensure_loaded(&app, &state)?;
    let addresses = net::addresses_info();
    let mut inner = state.lock()?;
    {
        let mut shares = inner.shares.lock().map_err(|_| "清单锁失效".to_string())?;
        share::add_dir(&mut shares, req)?;
        share::save(&app, &shares)?;
    }
    ensure_running(&app, &mut inner)?;
    Ok(status(&inner, &addresses))
}

/// 启停单条共享（停用后直链 404，但文件与记录都保留）
#[tauri::command]
pub async fn lan_share_set_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, LanShareState>,
    id: String,
    enabled: bool,
) -> Result<LanShareStatus, String> {
    ensure_loaded(&app, &state)?;
    let addresses = net::addresses_info();
    let inner = state.lock()?;
    {
        let mut shares = inner.shares.lock().map_err(|_| "清单锁失效".to_string())?;
        share::set_enabled(&mut shares, &id, enabled)?;
        share::save(&app, &shares)?;
    }
    Ok(status(&inner, &addresses))
}

/// 删除共享（托管站点连同站点目录一并删除；目录引用只删记录）
#[tauri::command]
pub async fn lan_share_remove(
    app: tauri::AppHandle,
    state: tauri::State<'_, LanShareState>,
    id: String,
) -> Result<LanShareStatus, String> {
    ensure_loaded(&app, &state)?;
    let addresses = net::addresses_info();
    let inner = state.lock()?;
    {
        let mut shares = inner.shares.lock().map_err(|_| "清单锁失效".to_string())?;
        share::remove(&app, &mut shares, &id)?;
        share::save(&app, &shares)?;
    }
    if let Ok(mut stats) = inner.stats.lock() {
        stats.remove(&id);
    }
    Ok(status(&inner, &addresses))
}
