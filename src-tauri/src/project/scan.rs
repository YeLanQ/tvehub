use std::fs;
use std::path::{Path, PathBuf};

use rayon::prelude::*;

use super::{AssetEntry, MetaEntry};

/// 递归扫描目录为平铺资产表（目录在前、深度优先）。
/// 跳过隐藏目录（`.` 开头）与内部产物目录（build=构建输出、graph=场景图侧车），
/// 跳过 `.meta`（资产元数据）与项目根的 `*.config.json`（系统配置）——均不作为资产项。
/// 先串行收集全部路径（保持顺序），再并行读取文件元数据（size）。
pub fn scan_tree(root: &Path) -> Result<Vec<AssetEntry>, String> {
    if !root.is_dir() {
        return Err(format!("'{}' 不是目录", root.display()));
    }
    let mut entries = Vec::new();
    collect_tree_entries(root, root, &mut entries)?;
    // 并行填充文件 size（IO 密集，各文件独立）
    entries.par_iter_mut().for_each(|e| {
        if e.kind != "dir" && e.size == 0 {
            let p = root.join(&e.path);
            e.size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        }
    });
    Ok(entries)
}

fn collect_tree_entries(base: &Path, dir: &Path, out: &mut Vec<AssetEntry>) -> Result<(), String> {
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
            collect_tree_entries(base, &p, out)?;
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
            out.push(AssetEntry {
                name: p
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                path: rel,
                kind,
                size: 0,
            });
        }
    }
    Ok(())
}

/// 解析 `*.meta` 为 uuid -> url 映射表。
/// 先串行收集全部 .meta 路径（保持顺序），再并行读取解析（IO + CPU 密集）。
pub fn scan_meta_db(root: &Path) -> Result<Vec<MetaEntry>, String> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut meta_paths = Vec::new();
    collect_meta_paths(root, root, &mut meta_paths)?;
    let entries: Vec<MetaEntry> = meta_paths
        .par_iter()
        .filter_map(|(p, rel)| {
            let content = fs::read_to_string(p).ok()?;
            let json = serde_json::from_str::<serde_json::Value>(&content).ok()?;
            let uuid = json.get("uuid").and_then(|v| v.as_str())?;
            if uuid.is_empty() {
                return None;
            }
            Some(MetaEntry {
                uuid: uuid.to_string(),
                url: rel.clone(),
                size_grid: json
                    .get("sizeGrid")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            })
        })
        .collect();
    Ok(entries)
}

fn collect_meta_paths(base: &Path, dir: &Path, out: &mut Vec<(PathBuf, String)>) -> Result<(), String> {
    let rd = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_meta_paths(base, &p, out)?;
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
        out.push((p, url));
    }
    Ok(())
}
