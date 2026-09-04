use std::fs;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Unity 风格 .meta 文件：为资产/目录自动生成带 uuid 的元数据
// ---------------------------------------------------------------------------

/// 取资产同级的 .meta 路径（`foo.png` → `foo.png.meta`）
pub fn sibling_with_meta(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(".meta");
    PathBuf::from(s)
}

/// 确保资产带 .meta（不存在或缺失 uuid 则用新 uuid 创建并写盘）。返回 uuid。
pub fn ensure_meta(asset: &Path) -> Result<String, String> {
    let meta = sibling_with_meta(asset);
    if meta.is_file() {
        if let Ok(content) = fs::read_to_string(&meta) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(u) = v.get("uuid").and_then(|x| x.as_str()) {
                    if !u.is_empty() {
                        return Ok(u.to_string());
                    }
                }
            }
        }
    }
    let uuid = uuid::Uuid::new_v4().to_string();
    let doc = serde_json::json!({ "uuid": uuid });
    fs::write(&meta, serde_json::to_string_pretty(&doc).unwrap_or_default())
        .map_err(|e| format!("写入 meta 失败 '{}': {}", meta.display(), e))?;
    Ok(uuid)
}

/// 递归确保目录下所有资产（文件/子目录）都带 .meta。
/// 跳过隐藏项（`.` 开头，含 `.meta` / `.git` / `.tmp` 等编辑器不管理）。
pub fn ensure_meta_recursive(dir: &Path) -> Result<(), String> {
    let rd = fs::read_dir(dir).map_err(|e| format!("读取目录失败 '{}': {}", dir.display(), e))?;
    for entry in rd.flatten() {
        let p = entry.path();
        let name = p
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() {
            ensure_meta(&p)?;
            ensure_meta_recursive(&p)?;
        } else {
            ensure_meta(&p)?;
        }
    }
    Ok(())
}