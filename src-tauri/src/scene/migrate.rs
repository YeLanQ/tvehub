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
/// 着色器资产文件扩展名
pub(crate) const SHADER_EXT: &str = ".shader";
pub const DEFAULT_MATERIAL_REL: &str = "internal/materials/Default.mat";
const LEGACY_KEYS: [&str; 5] = ["color", "metalness", "roughness", "emissive", "wireframe"];

/// 材质参数（PBR 超集；缺失字段回退默认——与 DEFAULT_MATERIAL_PARAMS 一致）。
/// serde 为前端 IPC 形态（camelCase、颜色为数字、贴图为字符串）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
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
    /// three.js 属性名即资产/IPC 键：serde 的 camelCase 会把 ior 规整成 Ior，
    /// 这里显式钉住前端与 .mat 文件的写法（iridescenceIOR），否则 material_write 参数缺失。
    #[serde(rename = "iridescenceIOR")]
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
    /// 着色器参数（.shader 的 Properties 值；键 = 属性名）。
    /// 值按属性类型存储（颜色 → RGB hex 数字 / 数值 → 数字 / 向量 → [x,y,z,w] / 贴图 → 资产路径）。
    /// 空表不写字段（旧 .mat 逐字节不变）。
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub props: Map<String, Value>,
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
            props: Map::new(),
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
        props: o
            .get("props")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
    }
}

/// 内置默认着色器引用（.mat shader 字段缺省写入值；与 public/internal/shaders 一致）
pub(crate) const DEFAULT_SHADER_REL: &str = "internal/shaders/PBR.shader";

/// 内置天空着色器引用（天空材质 shader 字段的正形值）
pub const SKY_PROCEDURAL_SHADER_REL: &str = "internal/shaders/SkyProcedural.shader";
pub const SKY_CUBE_SHADER_REL: &str = "internal/shaders/SkyBox.shader";

/// 材质文档 → .mat 文件内容（字段顺序与前端 serializeMaterialFile 一致）：
/// shader 非空写 shader 字段（材质 ↔ 着色器分离后的正形），否则回退写
/// materialType（旧格式兼容：迁移产物/旧项目重复制保留原引用方式）。
pub fn serialize_material_file(name: &str, shader: &str, fallback_type: &str, p: &MaterialParams) -> String {
    let mut v = serde_json::Map::new();
    v.insert("$type".into(), Value::String("material".into()));
    v.insert("$ver".into(), Value::from(1));
    v.insert("name".into(), Value::String(name.to_string()));
    if shader.trim().is_empty() {
        v.insert(
            "materialType".into(),
            Value::String(if fallback_type.trim().is_empty() {
                "physical".to_string()
            } else {
                fallback_type.to_string()
            }),
        );
    } else {
        v.insert("shader".into(), Value::String(shader.to_string()));
    }
    v.insert("color".into(), Value::String(color_to_hex_string(p.color)));
    v.insert("metalness".into(), Value::from(p.metalness));
    v.insert("roughness".into(), Value::from(p.roughness));
    v.insert("specularIntensity".into(), Value::from(p.specular_intensity));
    v.insert("specularColor".into(), Value::String(color_to_hex_string(p.specular_color)));
    v.insert("ior".into(), Value::from(p.ior));
    v.insert("emissive".into(), Value::String(color_to_hex_string(p.emissive)));
    v.insert("emissiveIntensity".into(), Value::from(p.emissive_intensity));
    v.insert("emissionEnabled".into(), Value::Bool(p.emission_enabled));
    v.insert("clearcoat".into(), Value::from(p.clearcoat));
    v.insert("clearcoatRoughness".into(), Value::from(p.clearcoat_roughness));
    v.insert("clearcoatEnabled".into(), Value::Bool(p.clearcoat_enabled));
    v.insert("sheen".into(), Value::from(p.sheen));
    v.insert("sheenColor".into(), Value::String(color_to_hex_string(p.sheen_color)));
    v.insert("sheenRoughness".into(), Value::from(p.sheen_roughness));
    v.insert("sheenEnabled".into(), Value::Bool(p.sheen_enabled));
    v.insert("transmission".into(), Value::from(p.transmission));
    v.insert("thickness".into(), Value::from(p.thickness));
    v.insert("attenuationColor".into(), Value::String(color_to_hex_string(p.attenuation_color)));
    v.insert("attenuationDistance".into(), Value::from(p.attenuation_distance));
    v.insert("transmissionEnabled".into(), Value::Bool(p.transmission_enabled));
    v.insert("anisotropy".into(), Value::from(p.anisotropy));
    v.insert("anisotropyRotation".into(), Value::from(p.anisotropy_rotation));
    v.insert("iridescence".into(), Value::from(p.iridescence));
    v.insert("iridescenceIOR".into(), Value::from(p.iridescence_ior));
    v.insert("opacity".into(), Value::from(p.opacity));
    v.insert("alphaClipThreshold".into(), Value::from(p.alpha_clip_threshold));
    v.insert("wireframe".into(), Value::Bool(p.wireframe));
    v.insert("toonSteps".into(), Value::from(p.toon_steps));
    v.insert("toonShadowStrength".into(), Value::from(p.toon_shadow_strength));
    v.insert("outlineEnabled".into(), Value::Bool(p.outline_enabled));
    v.insert("outlineColor".into(), Value::String(color_to_hex_string(p.outline_color)));
    v.insert("outlineWidth".into(), Value::from(p.outline_width));
    v.insert("map".into(), Value::String(p.map.clone()));
    v.insert("metalnessMap".into(), Value::String(p.metalness_map.clone()));
    v.insert("roughnessMap".into(), Value::String(p.roughness_map.clone()));
    v.insert("normalMap".into(), Value::String(p.normal_map.clone()));
    v.insert("emissiveMap".into(), Value::String(p.emissive_map.clone()));
    // 着色器参数（.shader 的 Properties 值；空表不写字段，旧 .mat 逐字节不变）
    if !p.props.is_empty() {
        v.insert("props".into(), Value::Object(p.props.clone()));
    }
    serde_json::to_string_pretty(&Value::Object(v)).unwrap_or_default()
}

/// 天空盒材质序列化（.mat 中 shader=天空着色器引用的特殊材质）：
/// - cube：持有 TextureCube 引用（cubeMap）+ 旋转/强度/世界不透明度/模糊；
/// - procedural：三段配色；
/// shader 字段引用内置天空着色器资产（材质 ↔ 着色器分离）；kind 为渲染快照
/// 判别字段（与旧格式一致，读取端以 kind 优先）。kind 未知值归一为 cube。
pub fn serialize_sky_material_file(name: &str, kind: &str) -> String {
    let procedural = kind.trim() == "procedural";
    let v = json!({
        "$type": "material",
        "$ver": 1,
        "name": sanitize_asset_stem(name),
        "shader": if procedural { SKY_PROCEDURAL_SHADER_REL } else { SKY_CUBE_SHADER_REL },
        "kind": if procedural { "procedural" } else { "cube" },
        // cube 专属：TextureCube 引用 + 渲染参数（默认与引擎兜底一致）
        "cubeMap": "internal/skybox/DefaultSkybox.texcube",
        "rotation": 0,
        "strength": 1,
        "worldOpacity": 0,
        "blur": 0,
        // procedural 专属：Nishita 天空参数
        "sunDisc": true,
        "sunSize": 1.0,
        "sunStrength": 1.0,
        "sunElevation": 25.0,
        "sunRotation": 0.0,
        "altitude": 0,
        "air": 1.0,
        "dust": 1.0,
        "ozone": 1.0,
        "ms": true,
        "color": "#9aa4b2",
        "metalness": 0,
        "roughness": 1,
        "emissive": "#000000",
        "wireframe": false,
    });
    let mut text = serde_json::to_string_pretty(&v).unwrap_or_default();
    text.push('\n');
    text
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

/// 遍历场景 JSON 收集 meshNode/skyboxNode 的材质资产引用（去重、忽略空）。
/// skyboxNode 的 .mat（天空材质）随导出：player 据此渲染天空贴图/参数。
pub fn collect_material_refs(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Array(items) => {
            for item in items {
                collect_material_refs(item, out);
            }
        }
        Value::Object(o) => {
            let ty = o.get("type").and_then(Value::as_str);
            if ty == Some("meshNode") || ty == Some("skyboxNode") {
                if let Some(Value::String(rel)) = o.get("material") {
                    if !rel.is_empty() && !out.iter().any(|r| r == rel) {
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

/// 遍历场景 JSON 收集天空盒节点的 TextureCube（.texcube）资产引用（去重、忽略空）
pub fn collect_texcube_refs(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Array(items) => {
            for item in items {
                collect_texcube_refs(item, out);
            }
        }
        Value::Object(o) => {
            if o.get("type").and_then(Value::as_str) == Some("skyboxNode") {
                if let Some(Value::String(rel)) = o.get("cubeMap") {
                    if !rel.is_empty() && !out.contains(rel) {
                        out.push(rel.clone());
                    }
                }
            }
            if let Some(children) = o.get("children") {
                collect_texcube_refs(children, out);
            }
            if let Some(root) = o.get("root") {
                collect_texcube_refs(root, out);
            }
        }
        _ => {}
    }
}

/// 遍历场景 JSON 收集音频资产引用（去重、按扩展名过滤）：
/// 音源节点（audioNode.audio.source）+ 音源组件（任意节点 components 中
/// type=audioSource 的 audio.source，组件模式）。
pub fn collect_audio_refs(v: &Value, out: &mut Vec<String>) {
    fn is_audio_rel(rel: &str) -> bool {
        let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        matches!(ext.as_str(), "mp3" | "wav" | "ogg" | "m4a" | "aac" | "flac") && rel.contains('.')
    }
    // 音源组件引用收集（任意节点可挂，组件模式）
    fn push_audio_comp(o: &Map<String, Value>, out: &mut Vec<String>) {
        let Some(Value::Array(comps)) = o.get("components") else {
            return;
        };
        for c in comps {
            let Some(cobj) = c.as_object() else { continue };
            if cobj.get("type").and_then(Value::as_str) == Some("audioSource") {
                if let Some(Value::String(rel)) = cobj.get("audio").and_then(|a| a.get("source")) {
                    if is_audio_rel(rel) && !out.contains(rel) {
                        out.push(rel.clone());
                    }
                }
            }
        }
    }
    match v {
        Value::Array(items) => {
            for item in items {
                collect_audio_refs(item, out);
            }
        }
        Value::Object(o) => {
            if o.get("type").and_then(Value::as_str) == Some("audioNode") {
                if let Some(Value::String(rel)) = o.get("audio").and_then(|a| a.get("source")) {
                    if is_audio_rel(rel) && !out.contains(rel) {
                        out.push(rel.clone());
                    }
                }
            }
            push_audio_comp(o, out);
            if let Some(children) = o.get("children") {
                collect_audio_refs(children, out);
            }
            if let Some(root) = o.get("root") {
                collect_audio_refs(root, out);
            }
        }
        _ => {}
    }
}

/// 遍历场景 JSON 收集关键帧动画剪辑引用（.anim 文本资产；去重）：
/// 任意节点 components 中 type=animationClip 的 clip 字段（组件模式）。
pub fn collect_anim_refs(v: &Value, out: &mut Vec<String>) {
    fn is_anim_rel(rel: &str) -> bool {
        rel.to_ascii_lowercase().ends_with(".anim")
    }
    match v {
        Value::Array(items) => {
            for item in items {
                collect_anim_refs(item, out);
            }
        }
        Value::Object(o) => {
            if let Some(Value::Array(comps)) = o.get("components") {
                for c in comps {
                    let Some(cobj) = c.as_object() else { continue };
                    if cobj.get("type").and_then(Value::as_str) == Some("animationClip") {
                        // 绑定形状：clip: { clip: "assets/...anim", ... }（外层是绑定对象，资产路径在内层 clip 字段）
                        if let Some(rel) = cobj.get("clip").and_then(|a| a.get("clip")).and_then(Value::as_str) {
                            if is_anim_rel(rel) && !out.iter().any(|r| r == rel) {
                                out.push(rel.to_string());
                            }
                        }
                    }
                }
            }
            if let Some(children) = o.get("children") {
                collect_anim_refs(children, out);
            }
            if let Some(root) = o.get("root") {
                collect_anim_refs(root, out);
            }
        }
        _ => {}
    }
}

/// 遍历场景 JSON 收集粒子系统节点的贴图引用（图片二进制资产；去重）：
/// particleSystemNode 的 particles.texture 字段（空串 = 内置软圆点，不收集）。
/// 扩展名集合与前端 PARTICLE_TEXTURE_EXTS / 材质贴图通道一致。
pub fn collect_particle_texture_refs(v: &Value, out: &mut Vec<String>) {
    fn is_image_rel(rel: &str) -> bool {
        let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        matches!(
            ext.as_str(),
            "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tga" | "svg"
        ) && rel.contains('.')
    }
    match v {
        Value::Array(items) => {
            for item in items {
                collect_particle_texture_refs(item, out);
            }
        }
        Value::Object(o) => {
            if o.get("type").and_then(Value::as_str) == Some("particleSystemNode") {
                if let Some(rel) = o.get("particles").and_then(|p| p.get("texture")).and_then(Value::as_str) {
                    if is_image_rel(rel) && !out.iter().any(|r| r == rel) {
                        out.push(rel.to_string());
                    }
                }
            }
            if let Some(children) = o.get("children") {
                collect_particle_texture_refs(children, out);
            }
            if let Some(root) = o.get("root") {
                collect_particle_texture_refs(root, out);
            }
        }
        _ => {}
    }
}

/// 遍历场景 JSON 收集 UI Widget 的图片资产引用（图片二进制资产；去重）：
/// uiImageNode 的 image 字段 + uiButtonNode 的背景 image 字段（空串 = 纯色，不收集）。
/// 扩展名集合与 collect_particle_texture_refs 一致。
pub fn collect_ui_image_refs(v: &Value, out: &mut Vec<String>) {
    fn is_image_rel(rel: &str) -> bool {
        let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        matches!(
            ext.as_str(),
            "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tga" | "svg"
        ) && rel.contains('.')
    }
    match v {
        Value::Array(items) => {
            for item in items {
                collect_ui_image_refs(item, out);
            }
        }
        Value::Object(o) => {
            let ty = o.get("type").and_then(Value::as_str);
            if ty == Some("uiImageNode") || ty == Some("uiButtonNode") {
                if let Some(rel) = o.get("image").and_then(Value::as_str) {
                    if is_image_rel(rel) && !out.iter().any(|r| r == rel) {
                        out.push(rel.to_string());
                    }
                }
            }
            if let Some(children) = o.get("children") {
                collect_ui_image_refs(children, out);
            }
            if let Some(root) = o.get("root") {
                collect_ui_image_refs(root, out);
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
                                    &serialize_material_file(&stem, DEFAULT_SHADER_REL, "physical", &legacy),
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

    /// 着色器参数（.mat 的 props = 挂载着色器的 Properties 值）：非空才写字段、
    /// 逐字段原样往返；空表不落字段（未挂效果着色器的 .mat 序列化结果逐字节不变）。
    #[test]
    fn shader_props_roundtrip_and_omitted_when_empty() {
        let mut o = Map::new();
        o.insert(
            "props".into(),
            json!({
                "_RimPower": 2.5,
                "_RimColor": "#ff8800",
                "_Dir": [0, 1, 0, 0],
                "_MainTex": "assets/textures/a.png"
            }),
        );
        let p = material_params_from(&o);
        assert_eq!(p.props.len(), 4);
        assert_eq!(p.props["_RimPower"], json!(2.5));
        assert_eq!(p.props["_Dir"], json!([0, 1, 0, 0]));

        let text = serialize_material_file("M", "assets/shaders/RimLight.shader", "", &p);
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["shader"], json!("assets/shaders/RimLight.shader"));
        assert_eq!(v["props"]["_MainTex"], json!("assets/textures/a.png"));
        let back = material_params_from(v.as_object().unwrap());
        assert_eq!(back.props, p.props);

        // 无着色器参数 → 不写 props 字段
        let plain = serialize_material_file("M", "", "physical", &MaterialParams::default());
        assert!(!plain.contains("\"props\""));
        // 旧 .mat 的 extension/extensionProps 字段（上一版扩展着色器）读取时被忽略、不再回写
        let legacy = material_params_from(
            json!({
                "extension": "assets/shaders/Old.ext.shader",
                "extensionProps": { "_Speed": 2.0 }
            })
            .as_object()
            .unwrap(),
        );
        let legacy_text = serialize_material_file("M", "", "physical", &legacy);
        assert!(!legacy_text.contains("\"extension\""));
        assert!(!legacy_text.contains("\"props\""));
    }


    /// IPC（material_write 参数）与 .mat 文件共用 three.js 键 iridescenceIOR；
    /// serde camelCase 默认会把 ior 规整成 Ior，须由字段级 rename 钉住。
    #[test]
    fn ipc_roundtrip_keeps_iridescence_ior_key() {
        let v = serde_json::to_value(MaterialParams::default()).unwrap();
        assert!(
            v.get("iridescenceIOR").is_some(),
            "IPC 材质参数必须带 three.js 键 iridescenceIOR（实际: {v}）"
        );
        assert!(v.get("iridescenceIor").is_none());
        let back: MaterialParams =
            serde_json::from_value(serde_json::json!({ "iridescenceIOR": 1.3 })).unwrap();
        assert_eq!(back.iridescence_ior, 1.3);
        assert_eq!(back.color, MaterialParams::default().color); // 其余字段走 default
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

    /// 组件模式：音源组件（任意节点 components 中 type=audioSource）引用的音频
    /// 随音源节点引用一并通过 collect_audio_refs 收集（构建导出打包用）。
    #[test]
    fn collect_audio_refs_includes_audio_source_components() {
        let doc = json!({
            "type": "scene",
            "root": {
                "type": "node", "id": "r",
                "components": [
                    { "id": "c1", "type": "light", "enabled": true, "light": { "kind": "point" } },
                    { "id": "c2", "type": "audioSource", "enabled": true, "audio": { "source": "assets/audio/hit.wav" } },
                    { "id": "c3", "type": "audioSource", "enabled": false, "audio": { "source": "assets/audio/disabled.mp3" } },
                    { "id": "c4", "type": "script", "script": "src/a.ts", "enabled": true, "props": {} }
                ],
                "children": [
                    { "type": "audioNode", "id": "s", "audio": { "source": "internal/audio/bgm.ogg" } },
                    { "type": "node", "id": "n", "components": [
                        { "id": "c5", "type": "audioSource", "enabled": true, "audio": { "source": "assets/audio/hit.wav" } }
                    ] }
                ]
            }
        });
        let mut refs = Vec::new();
        collect_audio_refs(&doc, &mut refs);
        assert_eq!(
            refs,
            vec![
                "assets/audio/hit.wav".to_string(),
                "assets/audio/disabled.mp3".to_string(),
                "internal/audio/bgm.ogg".to_string(),
            ],
            "组件引用去重收集（不看 enabled：导出兜底宁多勿缺，播放端按 enabled 决定是否实例化）"
        );
    }

    /// 粒子系统节点 particles.texture 的图片引用：去重、跳过空串（内置软圆点）与
    /// 非图片扩展名，递归 root/children（构建导出打包用）。
    #[test]
    fn collect_particle_texture_refs_dedups_and_skips_builtin() {
        let doc = json!({
            "type": "scene",
            "root": {
                "type": "node", "id": "r",
                "children": [
                    { "type": "particleSystemNode", "id": "p1", "particles": { "emissionRate": 20, "texture": "assets/textures/spark.png" } },
                    { "type": "particleSystemNode", "id": "p2", "particles": { "texture": "" } },
                    { "type": "particleSystemNode", "id": "p3" },
                    { "type": "particleSystemNode", "id": "p4", "particles": { "texture": "assets/materials/not-image.mat" } },
                    { "type": "node", "id": "n", "children": [
                        { "type": "particleSystemNode", "id": "p5", "particles": { "texture": "assets/textures/spark.png" } },
                        { "type": "particleSystemNode", "id": "p6", "particles": { "texture": "internal/textures/smoke.webp" } }
                    ] },
                    { "type": "meshNode", "id": "m", "material": "assets/materials/M.mat" }
                ]
            }
        });
        let mut refs = Vec::new();
        collect_particle_texture_refs(&doc, &mut refs);
        assert_eq!(
            refs,
            vec![
                "assets/textures/spark.png".to_string(),
                "internal/textures/smoke.webp".to_string(),
            ],
            "去重收集、空串/无 particles/非图片扩展名跳过、递归子级"
        );
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

    /// 关键帧动画剪辑引用收集：组件真实形状（animationClip.clip 为绑定对象，
    /// 资产路径在绑定对象内层 clip 字段）必须能被收集（曾因取错字段层级漏收集，
    /// 导致预览/发布产物缺失 .anim 文件、动画不播放）。
    #[test]
    fn collect_anim_refs_reads_binding_object() {
        let doc = json!({
            "type": "scene",
            "root": {
                "type": "node", "id": "r", "components": [
                    { "id": "ac1", "type": "animationClip", "enabled": true,
                      "clip": { "clip": "assets/animations/Bob.anim", "autoplay": true, "loop": true, "speed": 1 } },
                    { "id": "s1", "type": "script", "script": "src/a.ts", "enabled": true, "props": {} }
                ]
            }
        });
        let mut refs = Vec::new();
        collect_anim_refs(&doc, &mut refs);
        assert_eq!(refs, vec!["assets/animations/Bob.anim".to_string()]);
    }
}
