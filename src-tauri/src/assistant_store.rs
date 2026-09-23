// ---------------------------------------------------------------------------
// 助手会话存储（独立于 ui-state KV）：配置根/assistant/conversations/ 下
// index.json（全工作区会话索引）+ conv-<id>.json（每会话一文档，原子写）。
// 与 ui-state 分离的原因：会话是"数据"不是"界面状态"——索引整体覆盖的写法
// 一旦前端在加载完成前回写（窗口重启时序），整个索引被空副本吃掉，全部会话
// 丢失；独立目录 + 每会话一文件把这类事故的影响面收窄，且便于备份/清理。
// setup 阶段一次性迁移 ui-state 里的 tve:ai:conv-index 与 tve:ai:conv:* 键。
// ---------------------------------------------------------------------------

use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

fn store_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::appdirs::config_root(app)
        .join("assistant")
        .join("conversations");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 会话 id 白名单：[A-Za-z0-9_-]{1,64}（防路径穿越与文件名歧义）
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 原子写：临时文件 + 改名，避免中途退出留下半截文档
fn atomic_write(path: &Path, value: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, value).map_err(|e| format!("写入会话失败: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("提交会话失败: {e}"))
}

#[tauri::command]
pub fn assistant_conv_index_get(app: AppHandle) -> Result<Option<String>, String> {
    let path = store_dir(&app)?.join("index.json");
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn assistant_conv_index_set(app: AppHandle, value: String) -> Result<(), String> {
    atomic_write(&store_dir(&app)?.join("index.json"), &value)
}

#[tauri::command]
pub fn assistant_conv_doc_get(app: AppHandle, id: String) -> Result<Option<String>, String> {
    if !valid_id(&id) {
        return Err(format!("非法会话 id: {id}"));
    }
    let path = store_dir(&app)?.join(format!("conv-{id}.json"));
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn assistant_conv_doc_set(app: AppHandle, id: String, value: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err(format!("非法会话 id: {id}"));
    }
    atomic_write(&store_dir(&app)?.join(format!("conv-{id}.json")), &value)
}

#[tauri::command]
pub fn assistant_conv_doc_delete(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err(format!("非法会话 id: {id}"));
    }
    let path = store_dir(&app)?.join(format!("conv-{id}.json"));
    match fs::remove_file(path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// 轻量路径探测（助手工作区清理用）：目录是否存在。metadata 微秒级，同步
/// fs 即可；目录不存在/不可达统一返回 false（由调用方决定保守策略）。
#[tauri::command]
pub fn workspace_path_exists(path: String) -> Result<bool, String> {
    if path.trim().is_empty() {
        return Ok(false);
    }
    Ok(fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false))
}

/// setup 一次性迁移：ui-state 目录中 conv 系列键搬入独立会话目录。
/// 返回迁移的文档数（含索引）。幂等：目标已存在时只清旧键文件。
pub fn migrate(app: &AppHandle) -> usize {
    let ui_dir = crate::appdirs::config_root(app).join("ui-state");
    let target = match store_dir(app) {
        Ok(d) => d,
        Err(_) => return 0,
    };
    migrate_dir(&ui_dir, &target)
}

/// 迁移核心（与 Tauri 解耦，可单测）：读 ui_dir 下 conv 系列键文件 →
/// 写入 target（目标已存在则跳过写但旧文件仍清掉）→ 删除旧文件。
/// 键文件名是 ui_state 的 %XX 转义：tve:ai:conv-index → tve%3Aai%3Aconv-index，
/// tve:ai:conv:<id> → tve%3Aai%3Aconv%3A<id>。
fn migrate_dir(ui_dir: &Path, target: &Path) -> usize {
    const IDX_OLD: &str = "tve%3Aai%3Aconv-index";
    const DOC_PREFIX: &str = "tve%3Aai%3Aconv%3A";
    let _ = fs::create_dir_all(target);
    let mut moved = 0usize;
    // 索引：复制成功（或目标已在）才清旧键；失败保留旧文件下次再迁
    let old_idx = ui_dir.join(IDX_OLD);
    if old_idx.is_file() {
        let new_idx = target.join("index.json");
        if new_idx.exists() {
            let _ = fs::remove_file(&old_idx);
        } else if fs::copy(&old_idx, &new_idx).is_ok() {
            moved += 1;
            let _ = fs::remove_file(&old_idx);
        }
    }
    // 消息文档
    let Ok(entries) = fs::read_dir(ui_dir) else {
        return moved;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(rest) = name.to_str().and_then(|n| n.strip_prefix(DOC_PREFIX)) else {
            continue;
        };
        if !valid_id(rest) {
            continue; // 不认识的键留在原地，绝不误删
        }
        let new_path = target.join(format!("conv-{rest}.json"));
        if new_path.exists() {
            let _ = fs::remove_file(entry.path());
        } else if fs::copy(entry.path(), &new_path).is_ok() {
            moved += 1;
            let _ = fs::remove_file(entry.path());
        }
    }
    moved
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path, content: &str) {
        if let Some(p) = path.parent() {
            let _ = fs::create_dir_all(p);
        }
        fs::write(path, content).expect("写测试文件");
    }

    #[test]
    fn migrates_index_and_docs_then_cleans_old() {
        let dir = std::env::temp_dir().join(format!("tve-conv-mig-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let ui = dir.join("ui-state");
        let target = dir.join("conversations");
        touch(&ui.join("tve%3Aai%3Aconv-index"), r#"{"projects":{}}"#);
        touch(&ui.join("tve%3Aai%3Aconv%3Ac_abc"), r#"{"messages":[]}"#);
        touch(&ui.join("tve%3Aeditor%3Adock"), "keep");
        assert_eq!(migrate_dir(&ui, &target), 2, "索引 + 1 文档");
        assert!(target.join("index.json").is_file());
        assert!(target.join("conv-c_abc.json").is_file());
        assert!(ui.join("tve%3Aeditor%3Adock").is_file(), "无关键不动");
        assert!(!ui.join("tve%3Aai%3Aconv-index").exists(), "旧键清理");
        // 幂等：目标已在时不再计数，旧键也不复活
        touch(&ui.join("tve%3Aai%3Aconv-index"), r#"{"projects":{}}"#);
        assert_eq!(migrate_dir(&ui, &target), 0);
        assert_eq!(
            fs::read_to_string(target.join("index.json")).unwrap(),
            r#"{"projects":{}}"#,
            "已迁移的新文件不被旧文件覆盖"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn skips_invalid_doc_ids() {
        let dir = std::env::temp_dir().join(format!("tve-conv-migbad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let ui = dir.join("ui-state");
        let target = dir.join("conversations");
        touch(&ui.join("tve%3Aai%3Aconv%3A..%2Fevil"), "x");
        assert_eq!(migrate_dir(&ui, &target), 0, "非法 id 不迁移");
        assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn valid_id_rules() {
        assert!(valid_id("c_abc123-XYZ"));
        assert!(!valid_id(""));
        assert!(!valid_id("../evil"));
        assert!(!valid_id("带中文"));
        assert!(!valid_id(&"x".repeat(65)));
    }
}
