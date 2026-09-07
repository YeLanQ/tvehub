// ---------------------------------------------------------------------------
// 材质资产命令（.mat 格式所有权在 Rust）：
// 前端不再读文本/解析/序列化 .mat——读取（含 internal/项目路由与解析）、
// 写入（序列化 + 落盘 + .meta 保障）、复制（internal → assets/materials）
// 全部在后端完成，前端只收发结构化的 MaterialDoc。
// ---------------------------------------------------------------------------

use serde::Serialize;
use serde_json::{Map, Value};

use super::migrate::{
    material_params_from, sanitize_asset_stem, serialize_material_file, suggest_material_rel,
    write_material_asset, MaterialParams,
};

/// 解析后的材质文档（前端 MaterialManager 缓存形态）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MaterialDoc {
    pub name: String,
    pub material_type: String,
    pub params: MaterialParams,
}

/// 读取 .mat 资产文本（internal/… → 内置目录；其余 → 项目根沙箱内）
pub(crate) fn read_material_text(root: &std::path::Path, rel: &str) -> Result<String, String> {
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

/// 解析 .mat 文本 → 材质文档（非材质文档/损坏 JSON 返回 None）
fn parse_material_doc(text: &str) -> Option<MaterialDoc> {
    let v: Value = serde_json::from_str(text).ok()?;
    let o = v.as_object()?;
    if o.get("$type").and_then(Value::as_str) != Some("material") {
        return None;
    }
    let name = o
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Material")
        .to_string();
    let material_type = o
        .get("materialType")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("physical")
        .to_string();
    Some(MaterialDoc {
        name,
        material_type,
        params: material_params_from(&{
            let mut m = Map::new();
            m.clone_from(o);
            m
        }),
    })
}

/// 读取并解析 .mat 材质资产；不存在/非材质文档返回 null（前端回退默认参数）
#[tauri::command]
pub async fn material_read(
    root: String,
    rel: String,
) -> Result<Option<MaterialDoc>, String> {
    let root = std::path::PathBuf::from(&root);
    match read_material_text(&root, &rel) {
        Ok(text) => Ok(parse_material_doc(&text)),
        Err(_) => Ok(None),
    }
}

/// 序列化并写入材质资产（项目 assets/…；自动补 .meta）
#[tauri::command]
pub async fn material_write(
    root: String,
    rel: String,
    name: String,
    material_type: String,
    params: MaterialParams,
) -> Result<(), String> {
    let content = serialize_material_file(&name, &material_type, &params);
    write_material_asset(&std::path::PathBuf::from(&root), &rel, &content)
}

/// 序列化并写入天空盒材质（.mat；shader/kind + 三段配色，配色缺省用内置默认）。
/// 与 material_write 同套路：序列化在 Rust（.mat 格式所有权），自动补 .meta。
#[tauri::command]
pub async fn skymat_write(
    root: String,
    rel: String,
    name: String,
    kind: String,
    top_color: Option<String>,
    horizon_color: Option<String>,
    ground_color: Option<String>,
) -> Result<(), String> {
    let content = crate::scene::migrate::serialize_sky_material_file(
        &name,
        &kind,
        top_color.as_deref().unwrap_or("#2f6fbb"),
        horizon_color.as_deref().unwrap_or("#cfe4f7"),
        ground_color.as_deref().unwrap_or("#8fa2b5"),
    );
    write_material_asset(&std::path::PathBuf::from(&root), &rel, &content)
}

/// 把引用路径的材质复制为项目材质资产（internal → assets/materials），
/// 目标名去重由后端扫盘保证；返回新相对路径。源缺失时按默认参数生成。
#[tauri::command]
pub async fn material_duplicate(
    root: String,
    src_rel: String,
    prefer_name: String,
) -> Result<String, String> {
    let root_path = std::path::PathBuf::from(&root);
    let src_doc = read_material_text(&root_path, &src_rel)
        .ok()
        .and_then(|t| parse_material_doc(&t));
    let stem = src_rel
        .rsplit('/')
        .next()
        .unwrap_or(&src_rel)
        .trim_end_matches(".mat");
    let doc = src_doc.unwrap_or(MaterialDoc {
        name: stem.to_string(),
        material_type: "physical".into(),
        params: MaterialParams::default(),
    });
    let name = sanitize_asset_stem(if prefer_name.trim().is_empty() {
        stem
    } else {
        &prefer_name
    });
    // 磁盘扫描已有 .mat 去重（与旧场景迁移同一套命名规则）
    let mut taken: Vec<String> = Vec::new();
    if let Ok(entries) = crate::project::scan_tree(&root_path) {
        taken.extend(entries.into_iter().filter(|e| e.kind == "mat").map(|e| e.path));
    }
    let rel = suggest_material_rel(&taken, &name);
    let content = serialize_material_file(&name, &doc.material_type, &doc.params);
    write_material_asset(&root_path, &rel, &content)?;
    Ok(rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_serialize_roundtrip() {
        let text = r##"{
            "$type": "material", "$ver": 1, "name": "Test", "materialType": "toon",
            "color": "#ff8800", "metalness": 0.2, "toonSteps": 4, "map": "assets/tex/a.png"
        }"##;
        let doc = parse_material_doc(text).unwrap();
        assert_eq!(doc.name, "Test");
        assert_eq!(doc.material_type, "toon");
        assert_eq!(doc.params.color, 0xff8800);
        assert_eq!(doc.params.toon_steps, 4);
        assert_eq!(doc.params.map, "assets/tex/a.png");

        let out = serialize_material_file(&doc.name, &doc.material_type, &doc.params);
        let doc2 = parse_material_doc(&out).unwrap();
        assert_eq!(doc2.params, doc.params);
        assert_eq!(doc2.material_type, "toon");
    }

    #[test]
    fn parse_rejects_non_material() {
        assert!(parse_material_doc("{}").is_none());
        assert!(parse_material_doc("not json").is_none());
    }

    #[test]
    fn serialize_sky_material_matches_internal_shape() {
        let text = crate::scene::migrate::serialize_sky_material_file(
            "MySky", "procedural", "#2f6fbb", "#cfe4f7", "#8fa2b5",
        );
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["shader"], "SkyProcedural");
        assert_eq!(v["kind"], "procedural");
        assert_eq!(v["topColor"], "#2f6fbb");
        // cube：持有 TextureCube 引用与渲染参数
        let text2 = crate::scene::migrate::serialize_sky_material_file("X", "cube", "#111111", "#222222", "#333333");
        let v2: Value = serde_json::from_str(&text2).unwrap();
        assert_eq!(v2["shader"], "SkyBox");
        assert_eq!(v2["kind"], "cube");
        assert_eq!(v2["cubeMap"], "internal/skybox/DefaultSkybox.texcube");
        assert_eq!(v2["strength"], 1);
        assert_eq!(v2["blur"], 0);
        // 未知 kind 归一为 cube
        let text3 = crate::scene::migrate::serialize_sky_material_file("Y", "whatever", "#111111", "#222222", "#333333");
        let v3: Value = serde_json::from_str(&text3).unwrap();
        assert_eq!(v3["shader"], "SkyBox");
        assert_eq!(v3["kind"], "cube");
    }
}
