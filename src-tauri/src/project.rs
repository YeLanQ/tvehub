use serde::Serialize;
use std::fs;
use std::path::Path;

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