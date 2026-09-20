//! 共享清单与发布。
//!
//! 两种站点根：
//! - **托管站点**（`managed=true`）：发布时把文本产物整站写入 `sites/<id>/`，
//!   随共享记录删除；白板放映页、自建网页产物走这条。
//! - **目录引用**（`managed=false`）：直接服务一个外部目录，不复制文件，
//!   源目录一变访问者立即可见；构建产物、网页预览产物、任意文件夹走这条。
//!
//! 清单落盘在 `<config_root>/lan-share/index.json`。

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub(super) use super::site::safe_rel;
use super::site::{dir_stats, guess_entry, write_site_files};
use super::{base_dir, now_ms, sites_dir};

/// 一条共享
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanShare {
    pub id: String,
    /// 产物类型：whiteboard（白板放映页）/ site（网页产物）/ folder（目录共享）
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub note: String,
    /// 来源标识（白板文件名 / 绝对目录）：同一来源再次发布时原地更新，不产生重复条目
    #[serde(default)]
    pub source: String,
    /// 入口文件（相对站点根）
    pub entry: String,
    /// 站点根目录绝对路径
    pub root: String,
    /// true = 托管站点（文件在 sites/<id>/ 下）；false = 目录引用
    pub managed: bool,
    /// 是否对外可用（停用后直链 404，但记录与文件都保留）
    pub enabled: bool,
    pub created_at: u64,
    pub updated_at: u64,
    pub file_count: usize,
    pub size: u64,
    /// 运行期访问统计（只存内存，状态组装时合并进来）
    #[serde(skip)]
    pub hits: u64,
    #[serde(skip)]
    pub last_access: u64,
    #[serde(skip)]
    pub last_client: String,
}

/// 发布托管站点
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishSiteRequest {
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub entry: Option<String>,
    /// 相对路径 → 文本内容（HTML/SVG/CSS/JS/JSON 等）；发布即整站覆盖
    #[serde(default)]
    pub files: HashMap<String, String>,
    /// 已存在的托管共享 id：传入则原地更新；省略则按 source 复用或新建
    #[serde(default)]
    pub share_id: Option<String>,
}

/// 按引用共享外部目录
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddDirRequest {
    pub title: String,
    #[serde(default)]
    pub note: String,
    /// 要共享的目录（绝对路径）
    pub dir: String,
    #[serde(default)]
    pub entry: Option<String>,
    /// 已存在的共享 id：传入则原地更新；省略则按 source（目录路径）复用或新建
    #[serde(default)]
    pub share_id: Option<String>,
}

fn index_path(app: &tauri::AppHandle) -> PathBuf {
    base_dir(app).join("index.json")
}

/// 读清单：文件缺失或损坏都退回空表
pub(super) fn load(app: &tauri::AppHandle) -> Vec<LanShare> {
    fs::read_to_string(index_path(app))
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<LanShare>>(&text).ok())
        .unwrap_or_default()
}

pub(super) fn save(app: &tauri::AppHandle, shares: &[LanShare]) -> Result<(), String> {
    let path = index_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建局域网共享目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(shares).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("写入共享清单失败: {e}"))
}

/// 8 位短 id（base36）：短到二维码里少几个模块，又足够避免碰撞
fn new_share_id(existing: &[LanShare]) -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let seed = uuid::Uuid::new_v4();
    for attempt in 0..64u8 {
        let bytes = seed.as_bytes();
        let id: String = (0..8)
            .map(|i| {
                let b = bytes[i % 16] as usize + i * 7 + attempt as usize;
                ALPHABET[b % ALPHABET.len()] as char
            })
            .collect();
        if !existing.iter().any(|s| s.id == id) {
            return id;
        }
    }
    uuid::Uuid::new_v4().to_string()[..8].to_string()
}

/// 按 id 或 source 定位已有条目（用于「原地更新」）
fn find_target<'a>(
    shares: &'a [LanShare],
    share_id: Option<&str>,
    source: &str,
) -> Result<Option<usize>, String> {
    if let Some(id) = share_id.filter(|s| !s.is_empty()) {
        // 显式指定了 id 却找不到：调用方状态已过期（共享被别处删了），
        // 直接报错比默默新建一条更安全——否则用户以为在更新，实际多了个新链接
        return shares
            .iter()
            .position(|s| s.id == id)
            .map(Some)
            .ok_or_else(|| format!("共享不存在或已被删除: {id}"));
    }
    if source.is_empty() {
        return Ok(None);
    }
    Ok(shares
        .iter()
        .position(|s| s.source == source && s.managed))
}

/// 发布（或原地更新）托管站点
pub(super) fn publish_site(
    app: &tauri::AppHandle,
    shares: &mut Vec<LanShare>,
    req: PublishSiteRequest,
) -> Result<LanShare, String> {
    if req.files.is_empty() {
        return Err("没有可发布的站点文件".into());
    }
    let entry = match req.entry.as_deref() {
        Some(e) => safe_rel(e)?,
        None => "index.html".to_string(),
    };
    if !req.files.keys().any(|k| safe_rel(k).map(|s| s == entry).unwrap_or(false)) {
        return Err(format!("站点缺少入口文件 {entry}"));
    }
    let title = if req.title.trim().is_empty() {
        "未命名共享".to_string()
    } else {
        req.title.trim().chars().take(80).collect()
    };

    let existing = find_target(shares, req.share_id.as_deref(), &req.source)?;
    if let Some(i) = existing {
        if !shares[i].managed {
            return Err("该共享是目录引用，不能写入托管站点文件".into());
        }
    }
    let id = match existing {
        Some(i) => shares[i].id.clone(),
        None => new_share_id(shares),
    };
    let site_dir = sites_dir(app).join(&id);
    if let Some(parent) = site_dir.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建共享站点目录失败: {e}"))?;
    }
    let (file_count, size) = write_site_files(&site_dir, &req.files)?;

    let now = now_ms();
    let share = match existing {
        Some(i) => {
            let share = &mut shares[i];
            share.kind = req.kind.clone();
            share.title = title;
            share.note = req.note.clone();
            share.source = req.source.clone();
            share.entry = entry;
            share.root = site_dir.display().to_string();
            share.managed = true;
            share.enabled = true;
            share.updated_at = now;
            share.file_count = file_count;
            share.size = size;
            share.clone()
        }
        None => {
            let share = LanShare {
                id: id.clone(),
                kind: req.kind.clone(),
                title,
                note: req.note.clone(),
                source: req.source.clone(),
                entry,
                root: site_dir.display().to_string(),
                managed: true,
                enabled: true,
                created_at: now,
                updated_at: now,
                file_count,
                size,
                hits: 0,
                last_access: 0,
                last_client: String::new(),
            };
            shares.push(share.clone());
            share
        }
    };
    Ok(share)
}

/// 顶层目录里挑一个入口文件（没给 entry 又不存在 index.html 时的兜底）
/// 按引用共享（或原地更新）一个外部目录
pub(super) fn add_dir(shares: &mut Vec<LanShare>, req: AddDirRequest) -> Result<LanShare, String> {
    let raw = req.dir.trim();
    if raw.is_empty() {
        return Err("请选择要共享的目录".into());
    }
    let path = PathBuf::from(raw);
    let canonical = fs::canonicalize(&path).map_err(|e| format!("目录不存在或不可读: {e}"))?;
    if !canonical.is_dir() {
        return Err("所选路径不是目录".into());
    }
    let source = canonical.display().to_string();
    let entry = match req.entry.as_deref() {
        Some(e) if !e.trim().is_empty() => safe_rel(e)?,
        _ => guess_entry(&canonical),
    };
    let title = if req.title.trim().is_empty() {
        canonical
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "目录共享".to_string())
    } else {
        req.title.trim().chars().take(80).collect()
    };

    let (file_count, size) = dir_stats(&canonical);
    let now = now_ms();
    let existing = find_target(shares, req.share_id.as_deref(), &source)?;
    if let Some(i) = existing {
        if shares[i].managed {
            return Err("该共享是托管站点，不能改成目录引用".into());
        }
    }
    Ok(match existing {
        Some(i) => {
            let share = &mut shares[i];
            share.title = title;
            share.note = req.note.clone();
            share.source = source.clone();
            share.entry = entry;
            share.root = source;
            share.enabled = true;
            share.updated_at = now;
            share.file_count = file_count;
            share.size = size;
            share.clone()
        }
        None => {
            let share = LanShare {
                id: new_share_id(shares),
                kind: "folder".into(),
                title,
                note: req.note.clone(),
                source,
                entry,
                root: canonical.display().to_string(),
                managed: false,
                enabled: true,
                created_at: now,
                updated_at: now,
                file_count,
                size,
                hits: 0,
                last_access: 0,
                last_client: String::new(),
            };
            shares.push(share.clone());
            share
        }
    })
}

pub(super) fn set_enabled(shares: &mut [LanShare], id: &str, enabled: bool) -> Result<(), String> {
    let share = shares
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("共享不存在: {id}"))?;
    share.enabled = enabled;
    share.updated_at = now_ms();
    Ok(())
}

/// 删除共享：托管站点连同站点目录一并清理；目录引用只删记录（不动源目录）
pub(super) fn remove(app: &tauri::AppHandle, shares: &mut Vec<LanShare>, id: &str) -> Result<(), String> {
    let index = shares
        .iter()
        .position(|s| s.id == id)
        .ok_or_else(|| format!("共享不存在: {id}"))?;
    let share = shares.remove(index);
    if share.managed {
        // 只删托管目录（sites/<id>），并用 id 再校验一次，避免记录被改坏后误删别的目录
        let site_dir = sites_dir(app).join(&share.id);
        if site_dir.starts_with(sites_dir(app)) && site_dir.exists() {
            fs::remove_dir_all(&site_dir).map_err(|e| format!("删除站点目录失败: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_id_is_unique_and_short() {
        let mut list: Vec<LanShare> = Vec::new();
        for _ in 0..200 {
            let id = new_share_id(&list);
            assert_eq!(id.len(), 8);
            assert!(id.chars().all(|c| c.is_ascii_alphanumeric()));
            assert!(!list.iter().any(|s| s.id == id));
            list.push(LanShare {
                id: id.clone(),
                kind: "site".into(),
                title: String::new(),
                note: String::new(),
                source: String::new(),
                entry: "index.html".into(),
                root: String::new(),
                managed: true,
                enabled: true,
                created_at: 0,
                updated_at: 0,
                file_count: 0,
                size: 0,
                hits: 0,
                last_access: 0,
                last_client: String::new(),
            });
        }
    }

    fn share_with(id: &str, source: &str, managed: bool) -> LanShare {
        LanShare {
            id: id.into(),
            kind: "site".into(),
            title: String::new(),
            note: String::new(),
            source: source.into(),
            entry: "index.html".into(),
            root: String::new(),
            managed,
            enabled: true,
            created_at: 0,
            updated_at: 0,
            file_count: 0,
            size: 0,
            hits: 0,
            last_access: 0,
            last_client: String::new(),
        }
    }

    #[test]
    fn find_target_prefers_explicit_id_and_rejects_stale_one() {
        let list = vec![share_with("aaa", "whiteboard:x", true), share_with("bbb", "d:/dir", false)];

        // 显式 id 命中
        assert_eq!(find_target(&list, Some("bbb"), "").unwrap(), Some(1));
        // 显式 id 已不存在：报错而不是默默新建（否则用户以为在更新，实际多了条新链接）
        let err = find_target(&list, Some("gone"), "").unwrap_err();
        assert!(err.contains("gone"), "{err}");
        // 空 id 视为未指定
        assert_eq!(find_target(&list, Some(""), "").unwrap(), None);
        // 按 source 复用只认托管站点：目录引用不该被同路径的站点发布顶掉
        assert_eq!(find_target(&list, None, "whiteboard:x").unwrap(), Some(0));
        assert_eq!(find_target(&list, None, "d:/dir").unwrap(), None);
        // 无来源信息则不匹配
        assert_eq!(find_target(&list, None, "").unwrap(), None);
    }
}
