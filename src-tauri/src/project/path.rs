use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// 清理项目/资产名称：移除非法字符，不能为空
pub fn sanitize_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("名称不能为空".to_string());
    }
    // Windows 文件名非法字符：\ / : * ? " < > |
    let sanitized: String = trimmed
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        return Err("名称无效".to_string());
    }
    Ok(sanitized)
}

/// 项目根 canonicalize 结果缓存（key = 传入的根路径）。
/// Windows 上 canonicalize 涉及多级卷/设备解析、开销不小，而 read_text/
/// write_text/scene_open/meta/预览资产读取等所有文件命令每次都要走一次
/// resolve_in_root，且同一打开会话内项目根不变 —— 命中后每次仅剩一次廉价的
/// 根目录存在性检查（根被删除/重命名则丢弃缓存重新解析）。
fn canonical_root_cache() -> &'static Mutex<HashMap<PathBuf, PathBuf>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, PathBuf>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn canonicalize_root_cached(root: &Path) -> Result<PathBuf, String> {
    if let Some(cached) = canonical_root_cache()
        .lock()
        .ok()
        .and_then(|m| m.get(root).cloned())
    {
        if root.exists() {
            return Ok(cached);
        }
        if let Ok(mut m) = canonical_root_cache().lock() {
            m.remove(root);
        }
    }
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("无法解析项目目录 '{}': {}", root.display(), e))?;
    if let Ok(mut m) = canonical_root_cache().lock() {
        m.insert(root.to_path_buf(), canonical.clone());
    }
    Ok(canonical)
}

/// 把相对路径安全解析到 root 目录内（防越界 / 绝对路径 / 反斜杠）。
pub fn resolve_in_root(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("路径为空".to_string());
    }
    if rel.contains('\\') || Path::new(rel).is_absolute() {
        return Err(format!("非法资产路径: {rel}"));
    }
    let root_abs = canonicalize_root_cached(root)?;
    let target = root_abs.join(rel);
    if !target.starts_with(&root_abs) {
        return Err(format!("非法资产路径（越界）: {rel}"));
    }
    Ok(target)
}