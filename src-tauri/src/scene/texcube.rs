// ---------------------------------------------------------------------------
// TextureCube 资产命令（.texcube 格式所有权在 Rust，与 .mat 同套路）：
// 前端只收发结构化字段；序列化（字段顺序稳定）与落盘（自动补 .meta）在后端完成。
// .texcube 表示一张立方体纹理（cubemap）：
// - source = "equirect"：引用一张等距柱状全景图（png/jpg/webp/hdr…），字段 map；
// - source = "faces"：引用六张面贴图（px/nx/py/ny/pz/nz），字段 faces。
// 引用值为项目相对路径或 internal/…（内置只读资源）。
// ---------------------------------------------------------------------------

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::migrate::sanitize_asset_stem;

/// 六面贴图引用（source=faces 时有效；空串 = 该面未设置）
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TexCubeFaces {
    #[serde(default)]
    pub px: String,
    #[serde(default)]
    pub nx: String,
    #[serde(default)]
    pub py: String,
    #[serde(default)]
    pub ny: String,
    #[serde(default)]
    pub pz: String,
    #[serde(default)]
    pub nz: String,
}

/// 来源模式归一化（未知值回退 equirect）
fn normalize_source(source: &str) -> &'static str {
    if source.trim() == "faces" {
        "faces"
    } else {
        "equirect"
    }
}

/// 序列化 .texcube 文本（字段顺序稳定：equirect 写 map，faces 写 faces）
pub fn serialize_texcube_file(
    name: &str,
    source: &str,
    map: &str,
    faces: Option<&TexCubeFaces>,
) -> String {
    let source = normalize_source(source);
    let mut v = json!({
        "$type": "texcube",
        "$ver": 1,
        "name": sanitize_asset_stem(name),
        "source": source,
    });
    let obj = v.as_object_mut().expect("对象字面量必为 Object");
    if source == "faces" {
        let f = faces.cloned().unwrap_or_default();
        obj.insert(
            "faces".into(),
            json!({
                "px": f.px, "nx": f.nx,
                "py": f.py, "ny": f.ny,
                "pz": f.pz, "nz": f.nz,
            }),
        );
    } else {
        obj.insert("map".into(), json!(map));
    }
    let mut text = serde_json::to_string_pretty(&v).unwrap_or_default();
    text.push('\n');
    text
}

/// 解析 .texcube 文本 → (name, source, map, faces)；非 texcube 文档返回 None
pub fn parse_texcube_doc(text: &str) -> Option<(String, String, String, Option<TexCubeFaces>)> {
    let v: Value = serde_json::from_str(text).ok()?;
    let obj = v.as_object()?;
    if obj.get("$type").and_then(Value::as_str) != Some("texcube") {
        return None;
    }
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("TextureCube")
        .to_string();
    let source = normalize_source(obj.get("source").and_then(Value::as_str).unwrap_or(""));
    let map = obj
        .get("map")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // faces 全空视为未设置（None），与 equirect 模式形态一致
    let faces = obj
        .get("faces")
        .and_then(|f| serde_json::from_value::<TexCubeFaces>(f.clone()).ok())
        .filter(|f| *f != TexCubeFaces::default());
    Some((name, source.to_string(), map, faces))
}

/// 读取 .texcube 资产文本（internal/… → 内置目录；其余 → 项目根沙箱内）
pub(crate) fn read_texcube_text(root: &std::path::Path, rel: &str) -> Result<String, String> {
    if rel == "internal" || rel.starts_with("internal/") {
        let sub = rel.strip_prefix("internal/").unwrap_or("");
        if sub.is_empty()
            || sub.contains('\\')
            || sub.split('/').any(|s| s == ".." || s.is_empty())
        {
            return Err(format!("非法内置资源相对路径: {rel}"));
        }
        let path = crate::internal_root().join(sub);
        return std::fs::read_to_string(&path)
            .map_err(|e| format!("读取内置资源失败 'internal/{sub}': {e}"));
    }
    let path = crate::project::resolve_in_root(root, rel)?;
    std::fs::read_to_string(&path).map_err(|e| format!("读取失败 '{rel}': {e}"))
}

/// 序列化并写入 TextureCube 资产（项目 assets/…；自动补 .meta）
#[tauri::command]
pub async fn texcube_write(
    root: String,
    rel: String,
    name: String,
    source: String,
    map: String,
    faces: Option<TexCubeFaces>,
) -> Result<(), String> {
    let content = serialize_texcube_file(&name, &source, &map, faces.as_ref());
    write_texcube_asset(&std::path::PathBuf::from(&root), &rel, &content)
}

/// 落盘（沙箱解析 + 建父目录 + 补 .meta）；与 write_material_asset 同规则
pub(crate) fn write_texcube_asset(root: &std::path::Path, rel: &str, content: &str) -> Result<(), String> {
    let p = crate::project::resolve_in_root(root, rel)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, content).map_err(|e| format!("写入失败 '{rel}': {e}"))?;
    if crate::project::is_meta_candidate(root, rel) {
        let _ = crate::project::ensure_meta(&p);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_equirect_roundtrip() {
        let text = serialize_texcube_file(
            "DefaultSkybox",
            "equirect",
            "internal/skybox/default_skybox.png",
            None,
        );
        let (name, source, map, faces) = parse_texcube_doc(&text).unwrap();
        assert_eq!(name, "DefaultSkybox");
        assert_eq!(source, "equirect");
        assert_eq!(map, "internal/skybox/default_skybox.png");
        assert!(faces.is_none());
    }

    #[test]
    fn serialize_faces_roundtrip() {
        let faces = TexCubeFaces {
            px: "assets/tex/px.png".into(),
            nx: "assets/tex/nx.png".into(),
            py: "assets/tex/py.png".into(),
            ny: "assets/tex/ny.png".into(),
            pz: "assets/tex/pz.png".into(),
            nz: "assets/tex/nz.png".into(),
        };
        let text = serialize_texcube_file("Faces", "faces", "", Some(&faces));
        let (_, source, _, parsed) = parse_texcube_doc(&text).unwrap();
        assert_eq!(source, "faces");
        assert_eq!(parsed, Some(faces));
    }

    #[test]
    fn parse_rejects_non_texcube() {
        assert!(parse_texcube_doc("{}").is_none());
        assert!(parse_texcube_doc(r#"{"$type": "material"}"#).is_none());
        assert!(parse_texcube_doc("not json").is_none());
    }

    #[test]
    fn unknown_source_falls_back_to_equirect() {
        let text = serialize_texcube_file("X", "whatever", "a.png", None);
        let (_, source, _, _) = parse_texcube_doc(&text).unwrap();
        assert_eq!(source, "equirect");
    }
}
