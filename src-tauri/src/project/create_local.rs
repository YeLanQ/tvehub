//! `project.create` 的 Rust 直答实现（devtools 命令模式的本地执行段）。
//! 此前该方法是前端流程（fetch 模板 → create_project），助手工具改经大脑
//! 决策中心统一派发后，执行权收归后端：devtools try_local 命中本模块，
//! 模板从 exe 旁 public/templates（生产，启动时已由内嵌归档释放）或仓库
//! public/templates（开发）读取，脚手架/登记最近/广播刷新全在后端完成。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter};

use super::scaffold_from_files;
use crate::{appdirs, store};

/// 内置模板目录：开发读仓库 public/templates；生产读 exe 旁 public/templates
/// （extract_builtin_archive 已随启动释放，templates 类在内嵌归档里）。
pub fn builtin_template_dir(name: &str) -> Result<PathBuf, String> {
    let base = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/templates")
    } else {
        appdirs::exe_dir().join("public/templates")
    };
    let dir = base.join(name);
    if dir.is_dir() {
        Ok(dir)
    } else {
        Err(format!("内置模板不存在: {name}"))
    }
}

/// 模板内相对路径守卫：拒空/绝对/反斜杠/..（与 scaffold_from_files 的写侧防御同口径）
fn safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && !Path::new(rel).is_absolute()
        && !rel.contains('\\')
        && rel.split('/').all(|seg| !seg.is_empty() && seg != "..")
}

/// 读出模板文件清单与内容（template.json 的 files 数组 → rel → 文本）
fn read_template_files(dir: &Path) -> Result<HashMap<String, String>, String> {
    let spec = fs::read_to_string(dir.join("template.json"))
        .map_err(|e| format!("读取模板清单失败: {e}"))?;
    let v: Value = serde_json::from_str(&spec).map_err(|e| format!("模板清单非法: {e}"))?;
    let files = v
        .get("files")
        .and_then(|x| x.as_array())
        .ok_or("模板清单缺少 files 数组")?;
    let mut out = HashMap::new();
    for rel in files {
        let Some(rel) = rel.as_str() else { continue };
        if !safe_rel(rel) {
            return Err(format!("非法模板相对路径: {rel}"));
        }
        let content = fs::read_to_string(dir.join(rel))
            .map_err(|e| format!("读取模板文件失败: {rel} ({e})"))?;
        out.insert(rel.to_string(), content);
    }
    if out.is_empty() {
        return Err("模板清单没有可用的 files".to_string());
    }
    Ok(out)
}

/// 默认父目录：prefs 的 default_project_dir（纯函数，缺省时给可操作的报错——
/// 后端执行不弹原生目录选择框，让模型显式传 parent 或提示用户去设置）
fn default_parent_of(prefs: &Map<String, Value>) -> Option<String> {
    prefs
        .get("default_project_dir")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// devtools `project.create` 直答：params { name, parent? } → 脚手架 + 登记最近 +
/// 广播 projects:changed。返回项目信息 JSON（path/name/sceneCount）。
pub fn create_local(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        return Err("缺少 name 参数".to_string());
    }
    let parent = params
        .get("parent")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or_else(|| default_parent_of(&store::load_app_prefs(app)))
        .ok_or("缺少 parent 参数且未设置默认项目目录（首页「设置」可设），请显式传 parent")?;
    let files = read_template_files(&builtin_template_dir("3d")?)?;
    let info = scaffold_from_files(Path::new(&parent), &name, &files)?;
    store::push_recent(app, &info.path);
    // 广播给所有窗口：助手在进程内创建的项目，首页面板即时刷新可见
    let _ = app.emit("projects:changed", ());
    serde_json::to_value(info).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::project_info;
    use serde_json::json;

    #[test]
    fn template_dir_resolves_and_files_read() {
        let dir = builtin_template_dir("3d").expect("内置 3d 模板应存在");
        let files = read_template_files(&dir).expect("模板文件应可读出");
        assert!(files.contains_key("project.config.json"), "应含项目配置");
        assert!(files.values().all(|c| !c.is_empty()));
        assert!(builtin_template_dir("no-such-tpl").is_err());
    }

    #[test]
    fn safe_rel_guards_traversal() {
        assert!(safe_rel("src/main.rs"));
        assert!(safe_rel("project.config.json"));
        assert!(!safe_rel("../etc/passwd"));
        assert!(!safe_rel("a\\b"));
        assert!(!safe_rel(""));
        assert!(!safe_rel("/abs"));
    }

    #[test]
    fn default_parent_prefers_nonempty_pref() {
        let mut prefs = Map::new();
        assert!(default_parent_of(&prefs).is_none(), "未设置时无默认目录");
        prefs.insert("default_project_dir".into(), json!("  "));
        assert!(default_parent_of(&prefs).is_none(), "空白视为未设置");
        prefs.insert("default_project_dir".into(), json!("D:/projects"));
        assert_eq!(default_parent_of(&prefs).as_deref(), Some("D:/projects"));
    }

    #[test]
    fn scaffold_from_template_produces_project() {
        let dir = builtin_template_dir("3d").unwrap();
        let files = read_template_files(&dir).unwrap();
        let parent = std::env::temp_dir().join(format!("tve-brain-create-{}", std::process::id()));
        let _ = fs::remove_dir_all(&parent);
        fs::create_dir_all(&parent).unwrap();
        let info = scaffold_from_files(&parent, "大脑建项测试", &files).expect("脚手架应成功");
        assert!(project_info(Path::new(&info.path)).is_ok());
        let _ = fs::remove_dir_all(&parent);
    }
}
