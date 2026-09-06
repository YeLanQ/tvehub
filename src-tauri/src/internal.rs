// ---------------------------------------------------------------------------
// 编辑器内置资源（internal/…）：只读资源，真实目录 = public/internal（唯一事实源）。
// - 开发（debug）：直接读仓库 public/internal；
// - 生产：build.rs 把 public/internal 打进二进制，启动时释放到 exe 同级 public/internal，
//   这里按目录运行时扫描/读取。
// 本文件只提供“按目录扫描/读取”命令，路径判定在前端 internal-assets.ts。
// ---------------------------------------------------------------------------

use std::fs;

use crate::project::{AssetEntry, scan_tree};

/// 去掉 "internal/" 前缀并校验相对路径不越界；非法返回 None
fn safe_internal_rel(rel: &str) -> Option<String> {
    let rel = rel.strip_prefix("internal/").unwrap_or(rel);
    if rel.is_empty() || rel.contains('\\') || rel.split('/').any(|s| s == ".." || s.is_empty()) {
        return None;
    }
    Some(rel.to_string())
}

/// 扫描内置资源目录（public/internal），返回以 "internal/" 为根的资产条目表。
/// 排除 templates 子目录（模板仅供创建资产时读取，不作为面板资产）。
#[tauri::command]
pub async fn scan_internal_assets() -> Result<Vec<AssetEntry>, String> {
    let root = crate::internal_root();
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let entries = scan_tree(&root)?;
    Ok(entries
        .into_iter()
        .filter(|e| !(e.path == "templates" || e.path.starts_with("templates/")))
        .map(|e| AssetEntry {
            name: e.name,
            path: format!("internal/{}", e.path),
            kind: e.kind,
            size: e.size,
        })
        .collect())
}

/// 读取内置文本资源文件内容（rel 为 "internal/…"；只读）。
#[tauri::command]
pub async fn read_internal_asset(rel: String) -> Result<String, String> {
    let rel = safe_internal_rel(&rel).ok_or_else(|| format!("非法内置资源相对路径: {rel}"))?;
    let root = crate::internal_root();
    let path = root.join(&rel);
    if !path.is_file() {
        return Err(format!("内置资源文件不存在: internal/{rel}"));
    }
    fs::read_to_string(&path).map_err(|e| format!("读取内置资源失败 'internal/{rel}': {e}"))
}

/// 读取内置二进制资源（rel 为 "internal/…"；如贴图），以 base64 文本返回。
#[tauri::command]
pub async fn read_internal_binary(rel: String) -> Result<String, String> {
    let rel = safe_internal_rel(&rel).ok_or_else(|| format!("非法内置资源相对路径: {rel}"))?;
    let root = crate::internal_root();
    let path = root.join(&rel);
    if !path.is_file() {
        return Err(format!("内置二进制资源不存在: internal/{rel}"));
    }
    let bytes = fs::read(&path).map_err(|e| format!("读取内置资源失败 'internal/{rel}': {e}"))?;
    Ok(crate::base64_encode(&bytes))
}
