use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// 项目信息返回给前端
#[derive(Serialize, Clone)]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
    pub scene_count: usize,
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

/// 清理项目名称：移除非法字符，不能为空
fn sanitize_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("项目名称不能为空".to_string());
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
        return Err("项目名称无效".to_string());
    }
    Ok(sanitized)
}