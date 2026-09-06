//! 用户自定义模板运行时发现：
//! - 打包后的 exe 中，public/ 下静态资源随前端产物内嵌，vite 插件编译期扫描注册的
//!   内置模板（项目模板/导出模板）在 exe 中依然生效；
//! - 用户自定义模板放到 exe 同级的 public 目录（`<exe目录>/public/templates/`、
//!   `<exe目录>/public/exports/web/`），前端经 `scan_user_templates` 运行时扫描，
//!   与内置列表合并展示；模板文件经 `read_user_template_text` 读取（路径守卫防越界）。
//! 开发环境 exe 在 target/debug 下无 public 目录，扫描返回空列表，仅内置模板生效。

use std::fs;
use std::path::PathBuf;

use serde::Serialize;

/// 用户自定义模板信息（与前端内置模板注册表字段对齐）
#[derive(Serialize)]
pub struct UserTemplateInfo {
    /// 模板目录名（public/<kind>/ 下的目录）
    pub dir: String,
    pub name: String,
    pub description: String,
    /// 导出模板产物形态（multi/single；项目模板固定 "multi"）
    pub mode: String,
    /// 模板文件清单（相对模板目录，来自 template.json 的 files）
    pub files: Vec<String>,
}

/// kind → exe 旁模板根目录（templates=项目模板 / exports-web=web 导出模板）
fn template_root(kind: &str) -> Result<PathBuf, String> {
    let rel = match kind {
        "templates" => "public/templates",
        "exports-web" => "public/exports/web",
        _ => return Err(format!("未知模板类别: '{kind}'")),
    };
    let exe = std::env::current_exe().map_err(|e| format!("定位程序目录失败: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "定位程序目录失败".to_string())?
        .join(rel);
    Ok(dir)
}

/// 目录段守卫：不允许反斜杠、空段与 ..（dir 不允许含 /，rel 允许多级）
fn safe_rel(s: &str, allow_slash: bool) -> bool {
    !s.is_empty()
        && !s.contains('\\')
        && (allow_slash || !s.contains('/'))
        && s.split('/').all(|seg| !seg.is_empty() && seg != "..")
}

/// 扫描 exe 旁 public/<kind>/ 下的自定义模板目录（含合法 template.json 才收录，
/// 目录名排序保证稳定顺序；无目录/解析失败均不致命——返回已识别项）
#[tauri::command]
pub fn scan_user_templates(kind: String) -> Result<Vec<UserTemplateInfo>, String> {
    let root = template_root(&kind)?;
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut dirs: Vec<PathBuf> = fs::read_dir(&root)
        .map_err(|e| format!("读取模板目录失败: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    let mut out = Vec::new();
    for dir_path in dirs {
        let Ok(text) = fs::read_to_string(dir_path.join("template.json")) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let dir = dir_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if dir.is_empty() {
            continue;
        }
        let name = v
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or(&dir)
            .to_string();
        let description = v
            .get("description")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let mode = if kind == "exports-web"
            && v.get("mode").and_then(|x| x.as_str()) == Some("single")
        {
            "single".to_string()
        } else {
            "multi".to_string()
        };
        let files = v
            .get("files")
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        out.push(UserTemplateInfo {
            dir,
            name,
            description,
            mode,
            files,
        });
    }
    Ok(out)
}

/// 读取 exe 旁自定义模板的文本文件（如 index.html / 模板内项目文件）
#[tauri::command]
pub fn read_user_template_text(kind: String, dir: String, rel: String) -> Result<String, String> {
    let root = template_root(&kind)?;
    if !safe_rel(&dir, false) || !safe_rel(&rel, true) {
        return Err(format!("非法模板路径: '{dir}' / '{rel}'"));
    }
    fs::read_to_string(root.join(dir).join(rel))
        .map_err(|e| format!("读取模板文件失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::safe_rel;

    #[test]
    fn safe_rel_guards() {
        assert!(safe_rel("multi", false));
        assert!(safe_rel("index.html", true));
        assert!(safe_rel("assets/Main.scene", true));
        assert!(!safe_rel("a/b", false));
        assert!(!safe_rel("../etc/passwd", true));
        assert!(!safe_rel("a\\b", true));
        assert!(!safe_rel("", false));
        assert!(!safe_rel("//x", true));
    }
}
