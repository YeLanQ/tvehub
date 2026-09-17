use std::fs;
use std::path::{Path, PathBuf};

use super::{AssetEntry, MetaEntry};

/// 递归扫描目录为平铺资产表（目录在前、深度优先）。
/// 跳过隐藏目录（`.` 开头）与内部产物目录（build=构建输出、graph=脚本图侧车），
/// 跳过 `.meta`（资产元数据）与项目根的 `*.config.json`（系统配置）——均不作为资产项。
pub fn scan_tree(root: &Path) -> Result<Vec<AssetEntry>, String> {
    if !root.is_dir() {
        return Err(format!("'{}' 不是目录", root.display()));
    }
    let mut out = Vec::new();
    scan_tree_inner(root, root, &mut out)?;
    Ok(out)
}

fn scan_tree_inner(base: &Path, dir: &Path, out: &mut Vec<AssetEntry>) -> Result<(), String> {
    let rd = fs::read_dir(dir).map_err(|e| format!("读取目录失败 '{}': {}", dir.display(), e))?;
    let mut children: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    children.sort_by_key(|p| (p.is_file(), p.file_name().map(|s| s.to_string_lossy().to_string())));

    for p in children {
        if p.is_dir() {
            let dname = p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if dname.starts_with('.') || dname == "build" || dname == "graph" {
                continue;
            }
        }
        let rel = p
            .strip_prefix(base)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if p.is_dir() {
            out.push(AssetEntry {
                name: p
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                path: rel,
                kind: "dir".into(),
                size: 0,
            });
            scan_tree_inner(base, &p, out)?;
        } else {
            if p
                .file_name()
                .map(|s| s.to_string_lossy().ends_with(".meta"))
                .unwrap_or(false)
            {
                continue;
            }
            // 项目根的系统配置文件（project.config.json / build.config.json 等）不作为资产项
            if dir == base
                && p.file_name()
                    .map(|s| s.to_string_lossy().ends_with(".config.json"))
                    .unwrap_or(false)
            {
                continue;
            }
            let kind = p
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_else(|| "bin".into());
            let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            out.push(AssetEntry {
                name: p
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                path: rel,
                kind,
                size,
            });
        }
    }
    Ok(())
}

/// 解析 `*.meta` 为 uuid -> url 映射表。
pub fn scan_meta_db(root: &Path) -> Result<Vec<MetaEntry>, String> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    scan_meta_inner(root, root, &mut out)?;
    Ok(out)
}

fn scan_meta_inner(base: &Path, dir: &Path, out: &mut Vec<MetaEntry>) -> Result<(), String> {
    let rd = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            scan_meta_inner(base, &p, out)?;
            continue;
        }
        let fname = p
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        if !fname.ends_with(".meta") {
            continue;
        }
        let Ok(content) = fs::read_to_string(&p) else { continue };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        let uuid = json.get("uuid").and_then(|v| v.as_str()).unwrap_or("");
        if uuid.is_empty() {
            continue;
        }
        let asset_name = fname.trim_end_matches(".meta").to_string();
        let rel_dir = p
            .parent()
            .and_then(|d| d.strip_prefix(base).ok())
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_default();
        let url = if rel_dir.is_empty() {
            asset_name
        } else {
            format!("{}/{}", rel_dir.replace('\\', "/"), asset_name)
        };
        out.push(MetaEntry {
            uuid: uuid.to_string(),
            url,
            size_grid: json
                .get("sizeGrid")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        });
    }
    Ok(())
}
