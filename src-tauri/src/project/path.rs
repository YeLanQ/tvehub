use std::path::{Path, PathBuf};

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

/// 把相对路径安全解析到 root 目录内（防越界 / 绝对路径 / 反斜杠）。
pub fn resolve_in_root(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("路径为空".to_string());
    }
    if rel.contains('\\') || Path::new(rel).is_absolute() {
        return Err(format!("非法资产路径: {rel}"));
    }
    let root_abs = root
        .canonicalize()
        .map_err(|e| format!("无法解析项目目录 '{}': {}", root.display(), e))?;
    let target = root_abs.join(rel);
    if !target.starts_with(&root_abs) {
        return Err(format!("非法资产路径（越界）: {rel}"));
    }
    Ok(target)
}