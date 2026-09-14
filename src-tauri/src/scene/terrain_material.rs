// ---------------------------------------------------------------------------
// 地形材质资产命令（.terrainmat 格式所有权在 Rust，与 .terrain 同套路）：
// 前端只收发结构化字段；序列化与落盘（自动补 .meta）在后端完成。
// .terrainmat 表示一套地形材质设置（4 纹理图层 + splatmap + 全局 PBR）：
// { "$type":"terrainmat", "$ver":1, "name":"…", "settings":{ layerCount, layers, … } }
// settings 为前端已收敛（parseTerrainMaterialSettings）的对象，后端原样存储不解释。
// ---------------------------------------------------------------------------

use serde_json::{json, Map, Value};

use super::migrate::sanitize_asset_stem;

/// 序列化 .terrainmat 文本（字段顺序稳定：$type/$ver/name/settings）
pub fn serialize_terrain_material_file(name: &str, settings: &Value) -> String {
    let v = json!({
        "$type": "terrainmat",
        "$ver": 1,
        "name": sanitize_asset_stem(name),
        "settings": settings.as_object().cloned().unwrap_or_else(Map::new),
    });
    let mut text = serde_json::to_string_pretty(&v).unwrap_or_default();
    text.push('\n');
    text
}

/// 序列化并写入地形材质资产（项目 assets/…；内置只读拒绝；自动补 .meta）
#[tauri::command]
pub async fn terrainmat_write(
    root: String,
    rel: String,
    name: String,
    settings: Value,
) -> Result<(), String> {
    if rel == "internal" || rel.starts_with("internal/") {
        return Err(format!("内置目录只读，不可写入: {rel}"));
    }
    if !rel.to_ascii_lowercase().ends_with(".terrainmat") {
        return Err(format!("不是地形材质资产: {rel}"));
    }
    if !settings.is_object() {
        return Err("地形材质设置必须是对象".to_string());
    }
    let content = serialize_terrain_material_file(&name, &settings);
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
    fn serialize_terrain_material_basic() {
        let settings = json!({
            "layerCount": 3,
            "layers": [
                { "albedoMap": "", "normalMap": "", "tiling": 1, "color": 7238739, "metalness": 0, "roughness": 0.95 },
                { "albedoMap": "", "normalMap": "", "tiling": 1, "color": 7564127, "metalness": 0, "roughness": 0.9 },
                { "albedoMap": "", "normalMap": "", "tiling": 1, "color": 15325424, "metalness": 0, "roughness": 0.8 },
                { "albedoMap": "", "normalMap": "", "tiling": 1, "color": 9077358, "metalness": 0, "roughness": 0.92 }
            ],
            "splatmap": "",
            "metalness": 0,
            "roughness": 0.95
        });
        let text = serialize_terrain_material_file("MyTerrainMat", &settings);
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["$type"], "terrainmat");
        assert_eq!(v["name"], "MyTerrainMat");
        assert_eq!(v["settings"]["layerCount"], 3);
    }
}