//! 站点文件系统：共享产物的落盘、统计与路径守卫。
//!
//! 托管站点的文件都经这里写入——发布走「先写 staging 再整体替换」，避免访问者
//! 看到半成品；所有站点内相对路径先过 `safe_rel`，拒绝绝对路径、反斜杠与 `..`，
//! 写入前再用 starts_with 兜一次越界。目录引用共享的统计也复用这里的 `dir_stats`。
use std::collections::HashMap;
use std::fs;
use std::path::Path;

/// 托管站点总字节上限（发布要经 IPC 传输文本，超限直接拒绝而不是卡住）
const MAX_SITE_BYTES: usize = 64 * 1024 * 1024;
/// 托管站点文件数上限
const MAX_SITE_FILES: usize = 4096;

pub(super) fn safe_rel(rel: &str) -> Result<String, String> {
    let trimmed = rel.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err("站点文件路径为空".into());
    }
    if trimmed.starts_with('/') || trimmed.contains('\0') {
        return Err(format!("非法站点文件路径: {rel}"));
    }
    if trimmed
        .split('/')
        .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return Err(format!("非法站点文件路径: {rel}"));
    }
    Ok(trimmed)
}

pub(super) fn dir_stats(root: &Path) -> (usize, u64) {
    let mut files = 0usize;
    let mut size = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(meta) = entry.metadata() {
                files += 1;
                size += meta.len();
            }
        }
    }
    (files, size)
}

pub(super) fn write_site_files(site_dir: &Path, files: &HashMap<String, String>) -> Result<(usize, u64), String> {
    if files.is_empty() {
        return Err("站点没有任何文件".into());
    }
    if files.len() > MAX_SITE_FILES {
        return Err(format!("站点文件数超限（{} > {MAX_SITE_FILES}）", files.len()));
    }
    let total: usize = files.values().map(|v| v.len()).sum();
    if total > MAX_SITE_BYTES {
        return Err(format!(
            "站点体积超限（{:.1}MB > {}MB）",
            total as f64 / 1048576.0,
            MAX_SITE_BYTES / 1048576
        ));
    }

    let staging = site_dir.with_extension("staging");
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    fs::create_dir_all(&staging).map_err(|e| format!("创建站点目录失败: {e}"))?;
    for (rel, content) in files {
        let safe = safe_rel(rel)?;
        let target = staging.join(&safe);
        if !target.starts_with(&staging) {
            return Err(format!("站点文件路径越界: {rel}"));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建站点子目录失败: {e}"))?;
        }
        fs::write(&target, content).map_err(|e| format!("写入站点文件 {safe} 失败: {e}"))?;
    }
    if site_dir.exists() {
        fs::remove_dir_all(site_dir).map_err(|e| format!("清理旧站点目录失败: {e}"))?;
    }
    fs::rename(&staging, site_dir).map_err(|e| format!("提交站点目录失败: {e}"))?;
    Ok(dir_stats(site_dir))
}

/// 顶层目录里挑一个入口文件（没给 entry 又不存在 index.html 时的兜底）
pub(super) fn guess_entry(dir: &Path) -> String {
    let mut candidates: Vec<String> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().is_file())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    name.to_lowercase().ends_with(".html").then_some(name)
                })
                .collect()
        })
        .unwrap_or_default();
    candidates.sort_by_key(|a| a.to_lowercase());
    candidates
        .iter()
        .find(|n| n.eq_ignore_ascii_case("index.html"))
        .cloned()
        .or_else(|| candidates.into_iter().next())
        .unwrap_or_else(|| "index.html".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_rel_rejects_traversal() {
        assert!(safe_rel("index.html").is_ok());
        assert!(safe_rel("a/b/c.css").is_ok());
        assert!(safe_rel("../secret").is_err());
        assert!(safe_rel("a/../../b").is_err());
        assert!(safe_rel("/etc/passwd").is_err());
        assert!(safe_rel("a\\b").is_ok(), "反斜杠按平台差异归一为斜杠");
        assert!(safe_rel("").is_err());
        assert!(safe_rel("a//b").is_err());
        assert!(safe_rel("./a").is_err());
    }

    #[test]
    fn write_site_files_rejects_oversize_and_traversal() {
        let dir = std::env::temp_dir().join(format!("tve-lanshare-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let mut files = HashMap::new();
        files.insert("index.html".to_string(), "<html></html>".to_string());
        files.insert("../escape.txt".to_string(), "x".to_string());
        assert!(write_site_files(&dir, &files).is_err(), "越界路径必须拒绝");

        files.remove("../escape.txt");
        let (count, size) = write_site_files(&dir, &files).expect("正常写入");
        assert_eq!(count, 1);
        assert_eq!(size, 13);
        assert!(dir.join("index.html").exists());
        // 覆盖发布：旧文件不应残留
        files.insert("extra.css".to_string(), "body{}".to_string());
        let (count2, _) = write_site_files(&dir, &files).expect("覆盖写入");
        assert_eq!(count2, 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn guess_entry_picks_html_entry() {
        let dir = std::env::temp_dir().join(format!("tve-lanshare-entry-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // 没有任何 html：退回默认入口名（访问时才 404，不在共享时挡住用户）
        assert_eq!(guess_entry(&dir), "index.html");

        fs::write(dir.join("b.html"), "b").unwrap();
        fs::write(dir.join("a.html"), "a").unwrap();
        fs::write(dir.join("note.txt"), "t").unwrap();
        // 无 index.html：取按名排序后的第一个 html
        assert_eq!(guess_entry(&dir), "a.html");

        fs::write(dir.join("index.html"), "i").unwrap();
        assert_eq!(guess_entry(&dir), "index.html");
        let _ = fs::remove_dir_all(&dir);
    }
}

