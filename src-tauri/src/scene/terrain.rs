// ---------------------------------------------------------------------------
// 地形资产命令（.terrain 格式所有权在 Rust，与 .texcube 同套路）：
// 前端只收发结构化字段；序列化（字段顺序稳定）与落盘（自动补 .meta）在后端完成。
// .terrain 表示一套程序化地形设置预设（高度场参数 + 表面配色）：
// { "$type":"terrain", "$ver":1, "name":"…", "settings":{ seed, size, … } }
// settings 为前端已收敛（parseTerrainSettings）的对象，后端原样存储不解释 ——
// 参数语义与取值域的单一事实源在前端 framework/terrain；节点引用资产时快照
// settings 到节点上（运行时不读资产文件）。
// ---------------------------------------------------------------------------

use serde_json::{json, Map, Value};

use super::migrate::sanitize_asset_stem;

/// 序列化 .terrain 文本（字段顺序稳定：$type/$ver/name/settings）
pub fn serialize_terrain_file(name: &str, settings: &Value) -> String {
    let v = json!({
        "$type": "terrain",
        "$ver": 1,
        "name": sanitize_asset_stem(name),
        "settings": settings.as_object().cloned().unwrap_or_else(Map::new),
    });
    let mut text = serde_json::to_string_pretty(&v).unwrap_or_default();
    text.push('\n');
    text
}

/// 解析 .terrain 文本 → (name, settings)；非 terrain 文档返回 None
/// （当前仅测试与未来 terrain_read 使用；写入路径由前端回读原文本）
#[cfg_attr(not(test), allow(dead_code))]
pub fn parse_terrain_doc(text: &str) -> Option<(String, Value)> {
    let v: Value = serde_json::from_str(text).ok()?;
    let obj = v.as_object()?;
    if obj.get("$type").and_then(Value::as_str) != Some("terrain") {
        return None;
    }
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Terrain")
        .to_string();
    let settings = obj
        .get("settings")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    Some((name, settings))
}

/// 序列化并写入地形资产（项目 assets/…；内置只读拒绝；自动补 .meta）
#[tauri::command]
pub async fn terrain_write(
    root: String,
    rel: String,
    name: String,
    settings: Value,
) -> Result<(), String> {
    if rel == "internal" || rel.starts_with("internal/") {
        return Err(format!("内置目录只读，不可写入: {rel}"));
    }
    if !rel.to_ascii_lowercase().ends_with(".terrain") {
        return Err(format!("不是地形资产: {rel}"));
    }
    if !settings.is_object() {
        return Err("地形设置必须是对象".to_string());
    }
    let content = serialize_terrain_file(&name, &settings);
    let p = crate::project::resolve_in_root(&std::path::PathBuf::from(&root), &rel)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, content).map_err(|e| format!("写入失败 '{rel}': {e}"))?;
    if crate::project::is_meta_candidate(&std::path::PathBuf::from(&root), &rel) {
        let _ = crate::project::ensure_meta(&p);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serialize_roundtrip() {
        let settings = json!({
            "seed": 7, "size": 200, "segments": 192,
            "heightScale": 65, "frequency": 0.01, "octaves": 5,
            "lacunarity": 1.97, "gain": 0.5, "erosion": 0.7, "warp": 0.35,
            "valleyBias": 1.2, "seaLevel": 0.15, "talus": 1, "talusPasses": 12,
            "grassColor": 7238739, "rockColor": 7564127, "snowColor": 15325424,
        });
        let text = serialize_terrain_file("MyHills", &settings);
        let (name, parsed) = parse_terrain_doc(&text).unwrap();
        assert_eq!(name, "MyHills");
        assert_eq!(parsed, settings);
    }

    #[test]
    fn parse_rejects_non_terrain() {
        assert!(parse_terrain_doc("{}").is_none());
        assert!(parse_terrain_doc(r#"{"$type": "material"}"#).is_none());
        assert!(parse_terrain_doc("not json").is_none());
    }

    #[test]
    fn missing_settings_defaults_empty_object() {
        let text = r#"{"$type":"terrain","$ver":1,"name":"X"}"#;
        let (_, settings) = parse_terrain_doc(text).unwrap();
        assert!(settings.as_object().unwrap().is_empty());
    }
}
