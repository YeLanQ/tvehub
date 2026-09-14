// ---------------------------------------------------------------------------
// 逻辑资产命令（.fsm 状态机 / .bt 行为树，与 .terrainmat 同套路）：
// 前端只收发结构化 JSON；序列化与落盘（自动补 .meta）在后端完成。
// 图/树结构由前端 parse 收敛（framework/fsm、framework/behavior），后端原样
// 存储不解释，只做形状校验（必须是对象）：
// { "$type":"fsm", "$ver":1, "name":"…", "graph":{ entry, states, transitions, params } }
// { "$type":"behaviortree", "$ver":1, "name":"…", "tree":{ id, type, children, … } }
// ---------------------------------------------------------------------------

use serde_json::{json, Map, Value};

use super::migrate::sanitize_asset_stem;

/// 序列化 .fsm 文本（字段顺序稳定：$type/$ver/name/graph）
pub fn serialize_fsm_file(name: &str, graph: &Value) -> String {
    let v = json!({
        "$type": "fsm",
        "$ver": 1,
        "name": sanitize_asset_stem(name),
        "graph": graph.as_object().cloned().unwrap_or_else(Map::new),
    });
    let mut text = serde_json::to_string_pretty(&v).unwrap_or_default();
    text.push('\n');
    text
}

/// 序列化 .bt 文本（字段顺序稳定：$type/$ver/name/tree）
pub fn serialize_behavior_tree_file(name: &str, tree: &Value) -> String {
    let v = json!({
        "$type": "behaviortree",
        "$ver": 1,
        "name": sanitize_asset_stem(name),
        "tree": tree.as_object().cloned().unwrap_or_else(Map::new),
    });
    let mut text = serde_json::to_string_pretty(&v).unwrap_or_default();
    text.push('\n');
    text
}

/// 通用写入：校验内置只读与扩展名 → 序列化落盘 → 自动补 .meta
fn write_logic_asset(
    root: &str,
    rel: &str,
    content: String,
    ext: &str,
    kind_label: &str,
) -> Result<(), String> {
    if rel == "internal" || rel.starts_with("internal/") {
        return Err(format!("内置目录只读，不可写入: {rel}"));
    }
    if !rel.to_ascii_lowercase().ends_with(ext) {
        return Err(format!("不是{kind_label}资产: {rel}"));
    }
    let p = crate::project::resolve_in_root(&std::path::PathBuf::from(root), rel)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, content).map_err(|e| format!("写入失败 '{rel}': {e}"))?;
    if crate::project::is_meta_candidate(&std::path::PathBuf::from(root), rel) {
        let _ = crate::project::ensure_meta(&p);
    }
    Ok(())
}

/// 序列化并写入状态机资产（.fsm）
#[tauri::command]
pub async fn fsm_write(root: String, rel: String, name: String, graph: Value) -> Result<(), String> {
    if !graph.is_object() {
        return Err("状态机图必须是对象".to_string());
    }
    write_logic_asset(&root, &rel, serialize_fsm_file(&name, &graph), ".fsm", "状态机")
}

/// 序列化并写入行为树资产（.bt）
#[tauri::command]
pub async fn behaviortree_write(
    root: String,
    rel: String,
    name: String,
    tree: Value,
) -> Result<(), String> {
    if !tree.is_object() {
        return Err("行为树必须是对象".to_string());
    }
    write_logic_asset(&root, &rel, serialize_behavior_tree_file(&name, &tree), ".bt", "行为树")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serialize_fsm_basic() {
        let graph = json!({
            "entry": "s1",
            "states": [{ "id": "s1", "name": "Idle", "x": 120, "y": 140, "color": "#569cd6" }],
            "transitions": [],
            "params": {}
        });
        let text = serialize_fsm_file("MyFsm", &graph);
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["$type"], "fsm");
        assert_eq!(v["name"], "MyFsm");
        assert_eq!(v["graph"]["entry"], "s1");
    }

    #[test]
    fn serialize_behavior_tree_basic() {
        let tree = json!({
            "id": "n1", "type": "sequence",
            "children": [
                { "id": "n2", "type": "action", "action": "idle" },
                { "id": "n3", "type": "wait", "seconds": 1 }
            ]
        });
        let text = serialize_behavior_tree_file("MyBT", &tree);
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["$type"], "behaviortree");
        assert_eq!(v["name"], "MyBT");
        assert_eq!(v["tree"]["type"], "sequence");
    }

    #[test]
    fn fsm_write_rejects_bad_ext() {
        let dir = std::env::temp_dir().join(format!("tve_fsm_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let err = write_logic_asset(
            dir.to_str().unwrap(),
            "notafsm.json",
            serialize_fsm_file("X", &json!({})),
            ".fsm",
            "状态机",
        );
        assert!(err.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
