// ---------------------------------------------------------------------------
// 场景数据逻辑（Rust 权威）：
// - 材质参数读取/收敛/序列化（.mat 文件格式，与前端 material/types.ts、
//   materialFile.ts 同构）；
// - 场景引用收集（材质/模型，供装载预取与网页预览导出）；
// - 旧场景迁移：材质参数内嵌时代（meshNode 上的 color/metalness/… 字段）
//   装载时"另存"为项目 .mat 资产并改写节点为 material 引用。
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub const MATERIAL_EXT: &str = ".mat";
pub const DEFAULT_MATERIAL_REL: &str = "internal/materials/Default.mat";
const LEGACY_KEYS: [&str; 5] = ["color", "metalness", "roughness", "emissive", "wireframe"];

/// 材质参数（PBR 超集；缺失字段回退默认——与 DEFAULT_MATERIAL_PARAMS 一致）。
/// serde 为前端 IPC 形态（camelCase、颜色为数字、贴图为字符串）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialParams {
    pub color: i64,
    pub metalness: f64,
    pub roughness: f64,
    pub specular_intensity: f64,
    pub specular_color: i64,
    pub ior: f64,
    pub emissive: i64,
    pub emissive_intensity: f64,
    pub emission_enabled: bool,
    pub clearcoat: f64,
    pub clearcoat_roughness: f64,
    pub clearcoat_enabled: bool,
    pub sheen: f64,
    pub sheen_color: i64,
    pub sheen_roughness: f64,
    pub sheen_enabled: bool,
    pub transmission: f64,
    pub thickness: f64,
    pub attenuation_color: i64,
    pub attenuation_distance: f64,
    pub transmission_enabled: bool,
    pub anisotropy: f64,
    pub anisotropy_rotation: f64,
    pub iridescence: f64,
    pub iridescence_ior: f64,
    pub opacity: f64,
    pub alpha_clip_threshold: f64,
    pub wireframe: bool,
    pub toon_steps: i64,
    pub toon_shadow_strength: f64,
    pub outline_enabled: bool,
    pub outline_color: i64,
    pub outline_width: f64,
    pub map: String,
    pub metalness_map: String,
    pub roughness_map: String,
    pub normal_map: String,
    pub emissive_map: String,
}

impl Default for MaterialParams {
    fn default() -> Self {
        Self {
            color: 0x9aa4b2,
            metalness: 0.1,
            roughness: 0.75,
            specular_intensity: 1.0,
            specular_color: 0xffffff,
            ior: 1.5,
            emissive: 0x000000,
            emissive_intensity: 1.0,
            emission_enabled: false,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            clearcoat_enabled: false,
            sheen: 0.0,
            sheen_color: 0xffffff,
            sheen_roughness: 0.5,
            sheen_enabled: false,
            transmission: 0.0,
            thickness: 0.0,
            attenuation_color: 0xffffff,
            attenuation_distance: 0.0,
            transmission_enabled: false,
            anisotropy: 0.0,
            anisotropy_rotation: 0.0,
            iridescence: 0.0,
            iridescence_ior: 1.3,
            opacity: 1.0,
            alpha_clip_threshold: 0.5,
            wireframe: false,
            toon_steps: 3,
            toon_shadow_strength: 0.6,
            outline_enabled: false,
            outline_color: 0x000000,
            outline_width: 0.02,
            map: String::new(),
            metalness_map: String::new(),
            roughness_map: String::new(),
            normal_map: String::new(),
            emissive_map: String::new(),
        }
    }
}

/// 颜色：number / "#rrggbb" → RGB hex（失败回退 fallback）
fn parse_color_hex(v: &Value, fallback: i64) -> i64 {
    match v {
        Value::Number(n) => n.as_f64().map(|f| (f as i64) & 0xffffff).unwrap_or(fallback),
        Value::String(s) => {
            let s = s.trim().trim_start_matches('#');
            if s.len() == 6 && s.chars().all(|c| c.is_ascii_hexdigit()) {
                i64::from_str_radix(s, 16).unwrap_or(fallback) & 0xffffff
            } else if s.len() == 3 && s.chars().all(|c| c.is_ascii_hexdigit()) {
                let n = i64::from_str_radix(s, 16).unwrap_or(fallback);
                let r = (n >> 8) & 0xf;
                let g = (n >> 4) & 0xf;
                let b = n & 0xf;
                ((r | (r << 4)) << 16) | ((g | (g << 4)) << 8) | (b | (b << 4))
            } else {
                fallback
            }
        }
        _ => fallback,
    }
}

/// 颜色 → "#rrggbb" 展示串
fn color_to_hex_string(c: i64) -> String {
    format!("#{:06x}", c & 0xffffff)
}

fn num(v: Option<&Value>, fb: f64) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(fb)
}

fn unit(v: Option<&Value>, fb: f64) -> f64 {
    num(v, fb).clamp(0.0, 1.0)
}

fn bool_or(v: Option<&Value>, fb: bool) -> bool {
    v.and_then(Value::as_bool).unwrap_or(fb)
}

fn str_or(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or("").to_string()
}

/// 从任意 JSON 对象读取材质参数（缺失字段回退默认；与前端 materialParamsFrom 同构）
pub fn material_params_from(o: &Map<String, Value>) -> MaterialParams {
    let d = MaterialParams::default();
    MaterialParams {
        color: parse_color_hex(o.get("color").unwrap_or(&Value::Null), d.color),
        metalness: unit(o.get("metalness"), d.metalness),
        roughness: unit(o.get("roughness"), d.roughness),
        specular_intensity: unit(o.get("specularIntensity"), d.specular_intensity),
        specular_color: parse_color_hex(o.get("specularColor").unwrap_or(&Value::Null), d.specular_color),
        ior: num(o.get("ior"), d.ior).clamp(1.0, 2.333),
        emissive: parse_color_hex(o.get("emissive").unwrap_or(&Value::Null), d.emissive),
        emissive_intensity: num(o.get("emissiveIntensity"), d.emissive_intensity).clamp(0.0, 10.0),
        emission_enabled: bool_or(o.get("emissionEnabled"), d.emission_enabled),
        clearcoat: unit(o.get("clearcoat"), d.clearcoat),
        clearcoat_roughness: unit(o.get("clearcoatRoughness"), d.clearcoat_roughness),
        clearcoat_enabled: bool_or(o.get("clearcoatEnabled"), d.clearcoat_enabled),
        sheen: unit(o.get("sheen"), d.sheen),
        sheen_color: parse_color_hex(o.get("sheenColor").unwrap_or(&Value::Null), d.sheen_color),
        sheen_roughness: unit(o.get("sheenRoughness"), d.sheen_roughness),
        sheen_enabled: bool_or(o.get("sheenEnabled"), d.sheen_enabled),
        transmission: unit(o.get("transmission"), d.transmission),
        thickness: num(o.get("thickness"), d.thickness).clamp(0.0, 100.0),
        attenuation_color: parse_color_hex(o.get("attenuationColor").unwrap_or(&Value::Null), d.attenuation_color),
        attenuation_distance: num(o.get("attenuationDistance"), d.attenuation_distance).clamp(0.0, 10.0),
        transmission_enabled: bool_or(o.get("transmissionEnabled"), d.transmission_enabled),
        anisotropy: unit(o.get("anisotropy"), d.anisotropy),
        anisotropy_rotation: unit(o.get("anisotropyRotation"), d.anisotropy_rotation),
        iridescence: unit(o.get("iridescence"), d.iridescence),
        iridescence_ior: num(o.get("iridescenceIOR"), d.iridescence_ior).clamp(1.0, 2.333),
        opacity: unit(o.get("opacity"), d.opacity),
        alpha_clip_threshold: unit(o.get("alphaClipThreshold"), d.alpha_clip_threshold),
        wireframe: bool_or(o.get("wireframe"), d.wireframe),
        toon_steps: num(o.get("toonSteps"), d.toon_steps as f64).round().clamp(2.0, 6.0) as i64,
        toon_shadow_strength: unit(o.get("toonShadowStrength"), d.toon_shadow_strength),
        outline_enabled: bool_or(o.get("outlineEnabled"), d.outline_enabled),
        outline_color: parse_color_hex(o.get("outlineColor").unwrap_or(&Value::Null), d.outline_color),
        outline_width: num(o.get("outlineWidth"), d.outline_width).clamp(0.0, 0.1),
        map: str_or(o.get("map")),
        metalness_map: str_or(o.get("metalnessMap")),
        roughness_map: str_or(o.get("roughnessMap")),
        normal_map: str_or(o.get("normalMap")),
        emissive_map: str_or(o.get("emissiveMap")),
    }
}

/// 材质文档 → .mat 文件内容（字段顺序与前端 serializeMaterialFile 一致）
pub fn serialize_material_file(name: &str, material_type: &str, p: &MaterialParams) -> String {
    let v = json!({
        "$type": "material",
        "$ver": 1,
        "name": name,
        "materialType": if material_type.trim().is_empty() { "physical" } else { material_type },
        "color": color_to_hex_string(p.color),
        "metalness": p.metalness,
        "roughness": p.roughness,
        "specularIntensity": p.specular_intensity,
        "specularColor": color_to_hex_string(p.specular_color),
        "ior": p.ior,
        "emissive": color_to_hex_string(p.emissive),
        "emissiveIntensity": p.emissive_intensity,
        "emissionEnabled": p.emission_enabled,
        "clearcoat": p.clearcoat,
        "clearcoatRoughness": p.clearcoat_roughness,
        "clearcoatEnabled": p.clearcoat_enabled,
        "sheen": p.sheen,
        "sheenColor": color_to_hex_string(p.sheen_color),
        "sheenRoughness": p.sheen_roughness,
        "sheenEnabled": p.sheen_enabled,
        "transmission": p.transmission,
        "thickness": p.thickness,
        "attenuationColor": color_to_hex_string(p.attenuation_color),
        "attenuationDistance": p.attenuation_distance,
        "transmissionEnabled": p.transmission_enabled,
        "anisotropy": p.anisotropy,
        "anisotropyRotation": p.anisotropy_rotation,
        "iridescence": p.iridescence,
        "iridescenceIOR": p.iridescence_ior,
        "opacity": p.opacity,
        "alphaClipThreshold": p.alpha_clip_threshold,
        "wireframe": p.wireframe,
        "toonSteps": p.toon_steps,
        "toonShadowStrength": p.toon_shadow_strength,
        "outlineEnabled": p.outline_enabled,
        "outlineColor": color_to_hex_string(p.outline_color),
        "outlineWidth": p.outline_width,
        "map": p.map,
        "metalnessMap": p.metalness_map,
        "roughnessMap": p.roughness_map,
        "normalMap": p.normal_map,
        "emissiveMap": p.emissive_map,
    });
    serde_json::to_string_pretty(&v).unwrap_or_default()
}

/// 资产名规范化（去扩展名/非法字符；空值回退 "Material"）
pub(crate) fn sanitize_asset_stem(raw: &str) -> String {
    let trimmed = raw.trim();
    let stem = match trimmed.rfind('.') {
        Some(i) if i > 0 => &trimmed[..i],
        _ => trimmed,
    };
    let cleaned: String = stem
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c => c,
        })
        .collect();
    let collapsed: String = collapsed_spaces(&cleaned);
    let trimmed_again = collapsed.trim_start_matches('.').trim().to_string();
    if trimmed_again.is_empty() {
        "Material".to_string()
    } else {
        trimmed_again
    }
}

fn collapsed_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for c in s.chars() {
        if c == ' ' {
            pending_space = true;
        } else {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(c);
        }
    }
    out
}

/// 在 assets/materials 下建议一个不冲突的 .mat 相对路径
pub(crate) fn suggest_material_rel(taken: &[String], stem: &str) -> String {
    let base = sanitize_asset_stem(stem);
    let used: std::collections::HashSet<String> = taken
        .iter()
        .map(|r| r.to_lowercase())
        .collect();
    let mut name = base.clone();
    let mut n = 2;
    while used.contains(&format!("assets/materials/{name}{MATERIAL_EXT}").to_lowercase()) {
        name = format!("{base} {n}");
        n += 1;
    }
    format!("assets/materials/{name}{MATERIAL_EXT}")
}

/// 遍历场景 JSON 收集 meshNode 的材质资产引用（去重、忽略空）
pub fn collect_material_refs(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Array(items) => {
            for item in items {
                collect_material_refs(item, out);
            }
        }
        Value::Object(o) => {
            if o.get("type").and_then(Value::as_str) == Some("meshNode") {
                if let Some(Value::String(rel)) = o.get("material") {
                    if !rel.is_empty() && !out.contains(rel) {
                        out.push(rel.clone());
                    }
                }
            }
            if let Some(children) = o.get("children") {
                collect_material_refs(children, out);
            }
            if let Some(root) = o.get("root") {
                collect_material_refs(root, out);
            }
        }
        _ => {}
    }
}

/// 遍历场景 JSON 收集模型网格的模型资产引用（去重；按扩展名过滤）
pub fn collect_model_refs(v: &Value, out: &mut Vec<String>) {
    fn is_model_rel(rel: &str) -> bool {
        let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        matches!(ext.as_str(), "glb" | "gltf" | "fbx" | "obj") && rel.contains('.')
    }
    match v {
        Value::Array(items) => {
            for item in items {
                collect_model_refs(item, out);
            }
        }
        Value::Object(o) => {
            if o.get("type").and_then(Value::as_str) == Some("meshNode")
                && o.get("source").and_then(Value::as_str) == Some("model")
            {
                if let Some(Value::String(rel)) = o.get("model") {
                    if is_model_rel(rel) && !out.contains(rel) {
                        out.push(rel.clone());
                    }
                }
            }
            if let Some(children) = o.get("children") {
                collect_model_refs(children, out);
            }
            if let Some(root) = o.get("root") {
                collect_model_refs(root, out);
            }
        }
        _ => {}
    }
}

/// 旧 meshNode 是否携带内嵌材质参数（material 非字符串且存在任一 legacy 字段）
fn legacy_params_of(o: &Map<String, Value>) -> Option<MaterialParams> {
    if matches!(o.get("material"), Some(Value::String(_))) {
        return None;
    }
    if !LEGACY_KEYS.iter().any(|k| o.contains_key(*k)) {
        return None;
    }
    Some(material_params_from(o))
}

fn legacy_signature(p: &MaterialParams) -> String {
    format!(
        "{:x}|{}|{}|{:x}|{}",
        p.color, p.metalness, p.roughness, p.emissive, p.wireframe
    )
}

fn legacy_is_default(p: &MaterialParams) -> bool {
    let d = MaterialParams::default();
    p.color == d.color
        && p.metalness == d.metalness
        && p.roughness == d.roughness
        && p.emissive == d.emissive
        && p.wireframe == d.wireframe
}

/// 写 .mat 资产到项目（建目录 + 补 .meta；与 write_text 命令同语义）
pub(crate) fn write_material_asset(root: &Path, rel: &str, content: &str) -> Result<(), String> {
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

/// 递归改写旧节点（内嵌材质 → 材质资产引用），必要时落盘 .mat
fn walk_legacy(v: &mut Value, root: &Path, taken: &mut Vec<String>, sigs: &mut HashMap<String, String>) -> Result<(), String> {
    match v {
        Value::Array(items) => {
            for item in items {
                walk_legacy(item, root, taken, sigs)?;
            }
        }
        Value::Object(o) => {
            if o.get("type").and_then(Value::as_str) == Some("meshNode") {
                if let Some(legacy) = legacy_params_of(o) {
                    if legacy_is_default(&legacy) {
                        o.insert("material".into(), Value::String(DEFAULT_MATERIAL_REL.into()));
                    } else {
                        let sig = legacy_signature(&legacy);
                        let rel = match sigs.get(&sig) {
                            Some(rel) => rel.clone(),
                            None => {
                                let node_name = o
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Material");
                                let rel = suggest_material_rel(taken, node_name);
                                let stem = sanitize_asset_stem(node_name);
                                write_material_asset(
                                    root,
                                    &rel,
                                    &serialize_material_file(&stem, "physical", &legacy),
                                )?;
                                taken.push(rel.clone());
                                sigs.insert(sig, rel.clone());
                                rel
                            }
                        };
                        o.insert("material".into(), Value::String(rel));
                    }
                }
            }
            if let Some(children) = o.get_mut("children") {
                walk_legacy(children, root, taken, sigs)?;
            }
            if let Some(root_node) = o.get_mut("root") {
                walk_legacy(root_node, root, taken, sigs)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// 迁移旧版场景文档（内嵌材质 → 材质资产引用）。
/// 返回是否发生改写；写盘失败返回 Err（调用方决定是否按原内容装载）。
pub fn migrate_legacy_scene(root: &Path, doc: &mut Value) -> Result<bool, String> {
    // 收集磁盘已有 .mat 资产名，避免生成同名覆盖
    let mut taken: Vec<String> = Vec::new();
    if let Ok(entries) = crate::project::scan_tree(root) {
        taken.extend(entries.into_iter().filter(|e| e.kind == "mat").map(|e| e.path));
    }
    let mut sigs = HashMap::new();
    let before = doc.to_string();
    walk_legacy(doc, root, &mut taken, &mut sigs)?;
    Ok(doc.to_string() != before)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_from_defaults_and_clamps() {
        let mut o = Map::new();
        o.insert("color".into(), json!("#ff8800"));
        o.insert("metalness".into(), json!(2.0)); // 超界收敛到 1
        o.insert("roughness".into(), json!(-1.0)); // 收敛到 0
        let p = material_params_from(&o);
        assert_eq!(p.color, 0xff8800);
        assert_eq!(p.metalness, 1.0);
        assert_eq!(p.roughness, 0.0);
        assert_eq!(p.ior, 1.5); // 缺失回退默认
    }

    #[test]
    fn collect_refs_walks_children_and_wrapper() {
        let doc = json!({
            "type": "scene",
            "root": {
                "type": "node", "id": "r",
                "children": [
                    { "type": "meshNode", "id": "a", "source": "primitive", "material": "internal/materials/Default.mat" },
                    { "type": "meshNode", "id": "b", "source": "model", "model": "assets/models/x.glb", "material": "assets/materials/M.mat" }
                ]
            }
        });
        let mut mats = Vec::new();
        collect_material_refs(&doc, &mut mats);
        assert_eq!(mats.len(), 2);
        let mut models = Vec::new();
        collect_model_refs(&doc, &mut models);
        assert_eq!(models, vec!["assets/models/x.glb".to_string()]);
    }

    #[test]
    fn migrate_rewrites_legacy_and_writes_mat() {
        let dir = std::env::temp_dir().join(format!("tve-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let mut doc = json!({
            "type": "scene",
            "root": {
                "type": "node", "id": "r", "name": "Root",
                "children": [
                    { "type": "meshNode", "id": "a", "name": "Box A", "color": "#ff0000", "metalness": 0.5 },
                    { "type": "meshNode", "id": "b", "name": "Box B", "color": "#ff0000", "metalness": 0.5 },
                    { "type": "meshNode", "id": "c", "name": "Default Like" }
                ]
            }
        });
        let changed = migrate_legacy_scene(&dir, &mut doc).unwrap();
        assert!(changed);
        // 非默认内嵌 → 生成 .mat 并改写引用；两节点同签名共享同一资产
        let a = &doc["root"]["children"][0];
        let b = &doc["root"]["children"][1];
        assert_eq!(a["material"], b["material"]);
        let rel = a["material"].as_str().unwrap();
        assert!(rel.starts_with("assets/materials/"));
        assert!(dir.join(rel).is_file());
        // 新格式节点（无内嵌字段）不被改写
        assert!(doc["root"]["children"][2].get("material").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
