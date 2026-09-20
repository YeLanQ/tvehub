//! 局域网共享的统一配置：全局唯一一份，所有共享产物共用。
//! 落盘在 `<config_root>/lan-share/config.json`（Rust 权威，前端只读改）。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::DEFAULT_PORT;

/// 统一配置
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LanShareConfig {
    /// 服务开关（关闭即停服；配置保留）
    pub enabled: bool,
    /// 监听端口；被占用时回退系统分配并在状态下发 notice
    pub port: u16,
    /// 绑定网卡：空 = 绑定全部网卡（0.0.0.0）；填具体 IPv4 则只在该网卡监听
    pub host: String,
    /// 展示用设备名（手机打开索引页时的标题）
    pub device_name: String,
    /// 应用启动时自动开服
    pub auto_start: bool,
    /// 访问口令：非空时所有页面需要 `?k=<口令>` 或已校验 cookie
    pub access_code: String,
    /// 站点页是否显示「下载源文件」入口
    pub allow_download: bool,
}

impl Default for LanShareConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            host: String::new(),
            device_name: default_device_name(),
            auto_start: false,
            access_code: String::new(),
            allow_download: true,
        }
    }
}

/// 配置补丁：只改传入字段（前端表单不必回传整份配置，避免并发编辑互相覆盖）
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanShareConfigPatch {
    pub enabled: Option<bool>,
    pub port: Option<u16>,
    pub host: Option<String>,
    pub device_name: Option<String>,
    pub auto_start: Option<bool>,
    pub access_code: Option<String>,
    pub allow_download: Option<bool>,
}

impl LanShareConfig {
    /// 应用补丁（含字段级校验：非法值直接忽略，不让坏配置写进磁盘）
    pub(super) fn apply(&mut self, patch: LanShareConfigPatch) {
        if let Some(v) = patch.enabled {
            self.enabled = v;
        }
        if let Some(v) = patch.port {
            // 0 = 交给系统分配（排查端口冲突用）；其余限制在非特权端口区间
            self.port = if v == 0 { 0 } else { v.clamp(1024, 65535) };
        }
        if let Some(v) = patch.host {
            let trimmed = v.trim().to_string();
            if trimmed.is_empty() || trimmed.parse::<std::net::Ipv4Addr>().is_ok() {
                self.host = trimmed;
            }
        }
        if let Some(v) = patch.device_name {
            let trimmed = v.trim().to_string();
            if !trimmed.is_empty() {
                self.device_name = trimmed.chars().take(48).collect();
            }
        }
        if let Some(v) = patch.auto_start {
            self.auto_start = v;
        }
        if let Some(v) = patch.access_code {
            self.access_code = v.trim().chars().take(64).collect();
        }
        if let Some(v) = patch.allow_download {
            self.allow_download = v;
        }
    }
}

/// 默认设备名：主机名取不到就退成固定名
fn default_device_name() -> String {
    hostname().unwrap_or_else(|| "TvE".to_string())
}

fn hostname() -> Option<String> {
    let key = if cfg!(windows) { "COMPUTERNAME" } else { "HOSTNAME" };
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn config_path(app: &tauri::AppHandle) -> PathBuf {
    super::base_dir(app).join("config.json")
}

/// 读配置：文件缺失或损坏都退回默认值（不让坏文件卡住功能）
pub(super) fn load(app: &tauri::AppHandle) -> LanShareConfig {
    fs::read_to_string(config_path(app))
        .ok()
        .and_then(|text| serde_json::from_str::<LanShareConfig>(&text).ok())
        .unwrap_or_default()
}

pub(super) fn save(app: &tauri::AppHandle, config: &LanShareConfig) -> Result<(), String> {
    let path = config_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建局域网共享目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("写入局域网共享配置失败: {e}"))
}
