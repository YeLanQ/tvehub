use std::fs;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// .meta 元数据文件：为资产/目录自动生成带 uuid 的元数据
// ---------------------------------------------------------------------------

/// 取资产同级的 .meta 路径（`foo.png` → `foo.png.meta`）
pub fn sibling_with_meta(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(".meta");
    PathBuf::from(s)
}

/// 该相对路径资源是否应自动生成 .meta：
/// - 只对编辑器管理的资源目录 `assets/` 与 `src/` 下的文件生成；
/// - 排除根级配置文件（project.config.json 等）与任何隐藏项 / `.meta` 本身。
pub fn is_meta_candidate(_root: &Path, rel: &str) -> bool {
    if rel.ends_with(".meta") {
        return false;
    }
    // 隐藏项（如 `.git`、`.hidden`）不管理
    if rel.starts_with('.') || rel.split('/').any(|s| s.starts_with('.')) {
        return false;
    }
    // 仅 assets/ 与 src/ 目录内的资源生成（配置文件在项目根，如 project.config.json）
    let first = rel.split('/').next().unwrap_or("");
    first == "assets" || first == "src"
}

/// 读取资产 .meta 文档（不存在返回 null）。
pub fn read_meta(asset: &Path) -> Result<serde_json::Value, String> {
    let meta = sibling_with_meta(asset);
    if !meta.is_file() {
        return Ok(serde_json::Value::Null);
    }
    let content = fs::read_to_string(&meta).map_err(|e| format!("读取 meta 失败 '{}': {}", meta.display(), e))?;
    serde_json::from_str(&content).map_err(|e| format!("解析 meta 失败 '{}': {}", meta.display(), e))
}

/// 合并写入资产 .meta（内部先确保 uuid 存在），保持既有字段。
pub fn write_meta(asset: &Path, fields: &serde_json::Value) -> Result<(), String> {
    let mut doc = read_meta(asset)?;
    if !doc.is_object() {
        doc = serde_json::json!({});
    }
    if let Some(obj) = doc.as_object_mut() {
        if let Some(fields) = fields.as_object() {
            for (k, v) in fields {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    if doc.get("uuid").and_then(|v| v.as_str()).map(|s| s.is_empty()).unwrap_or(true) {
        if let Some(obj) = doc.as_object_mut() {
            obj.insert("uuid".into(), serde_json::Value::String(uuid::Uuid::new_v4().to_string()));
        }
    }
    fs::write(&sibling_with_meta(asset), serde_json::to_string_pretty(&doc).unwrap_or_default())
        .map_err(|e| format!("写入 meta 失败 '{}': {}", sibling_with_meta(asset).display(), e))
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

/// 复制资产时把源 .meta 一并复制到目标，并重新生成其中的 uuid（避免与源冲突）。
pub fn copy_meta_sibling(src: &Path, dest: &Path) -> Result<(), String> {
    let src_meta = sibling_with_meta(src);
    if !src_meta.is_file() {
        return Ok(());
    }
    let dest_meta = sibling_with_meta(dest);
    fs::copy(&src_meta, &dest_meta).map_err(|e| format!("复制 meta 失败 '{}': {}", src_meta.display(), e))?;
    let uuid = uuid::Uuid::new_v4().to_string();
    let doc = serde_json::json!({ "uuid": uuid });
    fs::write(&dest_meta, serde_json::to_string_pretty(&doc).unwrap_or_default())
        .map_err(|e| format!("重写 meta 失败 '{}': {}", dest_meta.display(), e))?;
    Ok(())
}

/// 重写已有 .meta 中的 uuid（递归复制目录时对每个子文件同步处理）。
pub fn refresh_meta_uuid(path: &Path) -> Result<(), String> {
    let meta = sibling_with_meta(path);
    if !meta.is_file() {
        return Ok(());
    }
    let mut doc = read_meta(path)?;
    if let Some(obj) = doc.as_object_mut() {
        obj.insert("uuid".into(), serde_json::Value::String(uuid::Uuid::new_v4().to_string()));
    }
    fs::write(&meta, serde_json::to_string_pretty(&doc).unwrap_or_default())
        .map_err(|e| format!("刷新 meta 失败 '{}': {}", meta.display(), e))?;
    Ok(())
}

/// 递归确保目录下所有资产（文件/子目录）都带 .meta。
/// 跳过隐藏项（`.` 开头，含 `.meta` / `.git` / `.tmp` 等编辑器不管理）。
/// 各文件 ensure_meta 互独立（只读写各自 .meta），用 rayon 并行。
pub fn ensure_meta_recursive(dir: &Path) -> Result<(), String> {
    use rayon::prelude::*;
    let entries = collect_meta_candidates(dir)?;
    entries
        .par_iter()
        .map(|p| ensure_meta(p))
        .collect::<Result<Vec<_>, _>>()
        .map(|_| ())
}

/// 收集需要生成 .meta 的全部路径（文件 + 目录，跳过隐藏项与 .meta 本身）
fn collect_meta_candidates(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    collect_meta_candidates_inner(dir, &mut out)?;
    Ok(out)
}

fn collect_meta_candidates_inner(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
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
        out.push(p.clone());
        if p.is_dir() {
            collect_meta_candidates_inner(&p, out)?;
        }
    }
    Ok(())
}