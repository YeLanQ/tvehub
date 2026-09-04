pub mod assets;
pub mod meta;
pub mod path;
pub mod scan;

pub use assets::*;
pub use meta::*;
pub use path::*;
pub use scan::*;

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

/// 项目信息返回给前端
#[derive(Serialize, Clone)]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
    pub scene_count: usize,
}

/// 单个资产条目（递归扫描结果）
#[derive(Serialize, Clone)]
pub struct AssetEntry {
    pub name: String,
    /// 相对项目根路径（正斜杠）
    pub path: String,
    /// "dir" 或小写扩展名（如 "scene"、"ts"）
    pub kind: String,
    pub size: u64,
}

/// uuid -> 相对路径映射（由 `*.meta` 汇总）
#[derive(Serialize, Clone)]
pub struct MetaEntry {
    pub uuid: String,
    pub url: String,
    /// 纹理九宫格（.meta 的 sizeGrid 字段，"上,右,下,左"），无则 null
    pub size_grid: Option<String>,
}

/// 获取项目信息
pub fn project_info(root: &Path) -> Result<ProjectInfo, String> {
    if !root.is_dir() {
        return Err(format!("'{}' is not a directory", root.display()));
    }
    let name = root
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| root.display().to_string());

    let assets = root.join("assets");
    let scene_count = if assets.is_dir() {
        count_ext(&assets, "scene")
    } else {
        0
    };

    Ok(ProjectInfo {
        path: root.to_string_lossy().to_string(),
        name,
        scene_count,
    })
}

/// 递归统计指定扩展名的文件数量
fn count_ext(root: &Path, ext: &str) -> usize {
    let mut count = 0;
    if let Ok(rd) = fs::read_dir(root) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                count += count_ext(&p, ext);
            } else if p
                .extension()
                .map(|e| e.eq_ignore_ascii_case(ext))
                .unwrap_or(false)
            {
                count += 1;
            }
        }
    }
    count
}

/// 重命名项目：目录名改为新名，返回重命名后的项目信息
pub fn rename_project_dir(root: &Path, new_name: &str) -> Result<ProjectInfo, String> {
    let name = sanitize_name(new_name)?;
    let parent = root.parent().ok_or("项目目录没有父目录")?;
    let new_dir = parent.join(&name);
    if new_dir == root {
        return project_info(root);
    }
    if !root.exists() {
        return Err(format!("项目目录不存在: '{}'", root.display()));
    }
    if new_dir.exists() {
        return Err(format!("目标目录已存在: '{}'", new_dir.display()));
    }
    fs::rename(root, &new_dir).map_err(|e| format!("重命名项目目录失败: {}", e))?;
    project_info(&new_dir)
}


/// 模板占位符替换：{{NAME}} → 项目名，{{NAME_LOWER}} → 项目名小写，
/// {{UUID}} → 每次出现生成一个全新 UUID（场景节点 _$id 需要彼此不同）。
pub fn substitute_template(content: &str, name: &str) -> String {
    let step1 = content
        .replace("{{NAME}}", name)
        .replace("{{NAME_LOWER}}", &name.to_lowercase());
    let mut parts = step1.split("{{UUID}}");
    let mut out = String::with_capacity(step1.len() + 64);
    if let Some(head) = parts.next() {
        out.push_str(head);
    }
    for tail in parts {
        out.push_str(&uuid::Uuid::new_v4().to_string());
        out.push_str(tail);
    }
    out
}

/// 从模板文件列表创建项目：写入时替换占位符（项目名 / UUID），并递归生成 .meta。
/// files 为相对路径 → 内容（内置模板由前端从 public/templates fetch）。返回项目信息。
pub fn scaffold_from_files(
    parent: &Path,
    name: &str,
    files: &HashMap<String, String>,
) -> Result<ProjectInfo, String> {
    let name = sanitize_name(name)?;
    let root = parent.join(&name);
    if root.exists() {
        return Err(format!("目录已存在: '{}'", root.display()));
    }
    fs::create_dir_all(&root).map_err(|e| format!("创建项目目录失败: {}", e))?;

    // 写入模板文件（相对路径 → 内容），替换占位符
    for (rel, content) in files {
        let target = root.join(rel);
        // 防御：相对路径不得逃逸出项目目录
        let normalized = Path::new(rel);
        if normalized.is_absolute()
            || rel.contains('\\')
            || rel.split('/').any(|s| s == "..")
        {
            return Err(format!("非法模板相对路径: {rel}"));
        }
        if let Some(parent_dir) = target.parent() {
            fs::create_dir_all(parent_dir).map_err(|e| e.to_string())?;
        }
        fs::write(&target, substitute_template(content, &name))
            .map_err(|e| format!("写入模板文件失败 '{}': {}", rel, e))?;
    }

    // 为 assets 与 src 下所有文件自动生成 .meta
    let assets = root.join("assets");
    if assets.is_dir() {
        let _ = ensure_meta_recursive(&assets);
    }
    let src = root.join("src");
    if src.is_dir() {
        let _ = ensure_meta_recursive(&src);
    }

    project_info(&root)
}