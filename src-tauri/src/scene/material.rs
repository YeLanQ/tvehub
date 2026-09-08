// ---------------------------------------------------------------------------
// 材质/着色器资产命令（.mat/.shader 格式所有权在 Rust）：
// 前端不再读文本/解析/序列化——读取（含 internal/项目路由与解析）、
// 写入（序列化 + 落盘 + .meta 保障）、复制（internal → assets/materials）
// 全部在后端完成，前端只收发结构化的 MaterialDoc / ShaderDoc。
// 材质与着色器分离：.mat 的 shader 字段引用一份 .shader 资产（渲染程序），
// material_read 负责解析出渲染分支 kind（旧 materialType 字段作回退）。
// ---------------------------------------------------------------------------

use serde::Serialize;
use serde_json::{Map, Value};

use super::migrate::{
    material_params_from, parse_shader_doc, sanitize_asset_stem, serialize_material_file,
    serialize_shader_file, suggest_material_rel, write_material_asset, MaterialParams,
};

/// 解析后的材质文档（前端 MaterialManager 缓存形态）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MaterialDoc {
    pub name: String,
    /// 渲染分支 key（shader 引用解析结果；旧格式 = materialType 字段）
    pub material_type: String,
    /// 引用的着色器资产相对路径（空串 = 旧格式无引用）
    pub shader: String,
    pub params: MaterialParams,
}

/// 解析后的着色器文档（前端资产检查器/着色器下拉用）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShaderDoc {
    pub name: String,
    pub kind: String,
    /// 着色器源码全文（Unity ShaderLab 风格；检查器内容展示用）
    pub source: String,
}

/// 读取 .mat/.shader 资产文本（internal/… → 内置目录；其余 → 项目根沙箱内）
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

/// 解析 .mat 文本 → 材质文档（shader/materialType 均为原始字段，未解析引用；
/// 非材质文档/损坏 JSON 返回 None）
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
    let shader = o
        .get("shader")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
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
        shader,
        params: material_params_from(&{
            let mut m = Map::new();
            m.clone_from(o);
            m
        }),
    })
}

/// 解析 .shader 引用 → 渲染分支 kind（缺失/损坏回退 legacy 或 physical）。
/// 仅 .shader 资产引用可解析；天空材质等内置名（SkyBox…）不走材质管线。
fn resolve_shader_kind(root: &std::path::Path, shader: &str, legacy: &str) -> String {
    if shader.ends_with(".shader") {
        let kind = read_material_text(root, shader)
            .ok()
            .and_then(|t| parse_shader_doc(&t))
            .map(|(_, k)| k);
        return kind.unwrap_or_else(|| legacy.to_string());
    }
    if legacy.is_empty() { "physical".to_string() } else { legacy.to_string() }
}

/// 读取并解析 .mat 材质资产；shader 引用就地解析为渲染分支 kind。
/// 不存在/非材质文档返回 null（前端回退默认参数）。
#[tauri::command]
pub async fn material_read(
    root: String,
    rel: String,
) -> Result<Option<MaterialDoc>, String> {
    let root = std::path::PathBuf::from(&root);
    match read_material_text(&root, &rel) {
        Ok(text) => Ok(parse_material_doc(&text).map(|mut doc| {
            if !doc.shader.is_empty() {
                doc.material_type = resolve_shader_kind(&root, &doc.shader, &doc.material_type);
            }
            doc
        })),
        Err(_) => Ok(None),
    }
}

/// 序列化并写入材质资产（项目 assets/…；自动补 .meta）。
/// shader 为着色器资产相对路径（空串按旧格式写 materialType=physical）。
#[tauri::command]
pub async fn material_write(
    root: String,
    rel: String,
    name: String,
    shader: String,
    params: MaterialParams,
) -> Result<(), String> {
    let content = serialize_material_file(&name, &shader, "physical", &params);
    write_material_asset(&std::path::PathBuf::from(&root), &rel, &content)
}

/// 读取并解析 .shader 着色器资产（源码全文随文档返回）；不存在/非着色器文档返回 null
#[tauri::command]
pub async fn shader_read(root: String, rel: String) -> Result<Option<ShaderDoc>, String> {
    let root = std::path::PathBuf::from(&root);
    match read_material_text(&root, &rel) {
        Ok(text) => {
            let doc = parse_shader_doc(&text).map(|(name, kind)| ShaderDoc {
                name,
                kind,
                source: text,
            });
            Ok(doc)
        }
        Err(_) => Ok(None),
    }
}

/// 序列化并写着色器资产（项目 assets/…；自动补 .meta）。
/// Shader 指令名直接取 rel（路径去扩展名），保证与资产位置一致。
#[tauri::command]
pub async fn shader_write(root: String, rel: String, kind: String) -> Result<(), String> {
    let content = serialize_shader_file(&rel, &kind);
    write_material_asset(&std::path::PathBuf::from(&root), &rel, &content)
}

/// 序列化并写入天空盒材质（.mat；shader/kind + 天空参数，后端持有格式，自动补 .meta）
#[tauri::command]
pub async fn skymat_write(
    root: String,
    rel: String,
    name: String,
    kind: String,
) -> Result<(), String> {
    let content = crate::scene::migrate::serialize_sky_material_file(&name, &kind);
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
        shader: String::new(),
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
    // shader 引用随副本保留；旧格式（materialType）同样原样带回
    let content = serialize_material_file(&name, &doc.shader, &doc.material_type, &doc.params);
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
        assert_eq!(doc.shader, "");
        assert_eq!(doc.params.color, 0xff8800);
        assert_eq!(doc.params.toon_steps, 4);
        assert_eq!(doc.params.map, "assets/tex/a.png");

        // 旧格式（shader 空）回退写 materialType
        let out = serialize_material_file(&doc.name, "", &doc.material_type, &doc.params);
        let doc2 = parse_material_doc(&out).unwrap();
        assert_eq!(doc2.params, doc.params);
        assert_eq!(doc2.material_type, "toon");

        // 新格式：shader 引用优先，materialType 不再写出
        let out2 = serialize_material_file(&doc.name, "internal/shaders/Toon.shader", "", &doc.params);
        let v: Value = serde_json::from_str(&out2).unwrap();
        assert_eq!(v["shader"], "internal/shaders/Toon.shader");
        assert!(v.get("materialType").is_none());
        let doc3 = parse_material_doc(&out2).unwrap();
        assert_eq!(doc3.shader, "internal/shaders/Toon.shader");
    }

    #[test]
    fn parse_rejects_non_material() {
        assert!(parse_material_doc("{}").is_none());
        assert!(parse_material_doc("not json").is_none());
    }

    #[test]
    fn shader_doc_roundtrip() {
        // kind → 模板序列化，再从源码解析回来（name 取 Shader 指令末段、kind 按 pragma）。
        // Shader 指令名 = 资产 rel 去扩展名，与路径一致。
        let text = serialize_shader_file("assets/shaders/My Toon.shader", "toon");
        assert!(text.contains("Shader \"assets/shaders/My Toon\""));
        assert!(text.contains("#pragma surface surf Toon"));
        let (name, kind) = parse_shader_doc(&text).unwrap();
        assert_eq!(name, "My Toon");
        assert_eq!(kind, "toon");

        // unlit 模板是顶点片元（无 surface pragma）→ unlit
        let (_, kind2) =
            parse_shader_doc(&serialize_shader_file("assets/shaders/X.shader", "unlit")).unwrap();
        assert_eq!(kind2, "unlit");
        // 未知 kind 归一为 physical（surface Standard）
        let (_, kind3) =
            parse_shader_doc(&serialize_shader_file("assets/shaders/Y.shader", "whatever")).unwrap();
        assert_eq!(kind3, "physical");
        // 天空程序：PreviewType=Skybox 标签识别（_SUNDISK → 散射 / samplerCUBE → 立方体）
        let (_, sky1) =
            parse_shader_doc(&serialize_shader_file("internal/shaders/SkyProcedural.shader", "skyprocedural"))
                .unwrap();
        assert_eq!(sky1, "skyprocedural");
        let (_, sky2) =
            parse_shader_doc(&serialize_shader_file("internal/shaders/SkyBox.shader", "skycube"))
                .unwrap();
        assert_eq!(sky2, "skycube");

        // 无 Shader 指令的文本拒绝
        assert!(parse_shader_doc("not a shader").is_none());
        assert!(parse_shader_doc("{\"$type\":\"material\"}").is_none());
        // 旧版 JSON 格式（早期内部实现）兼容读取
        let (n, k) = parse_shader_doc("{\"$type\":\"shader\",\"name\":\"Old\",\"kind\":\"unlit\"}").unwrap();
        assert_eq!(n, "Old");
        assert_eq!(k, "unlit");
    }

    /// 内置 .shader（public/internal/shaders，打包进 exe 的唯一事实源）必须与
    /// 序列化模板逐字节一致（仅行尾归一），防止两边漂移。
    #[test]
    fn internal_shader_files_match_templates() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/internal/shaders");
        for (stem, kind) in [
            ("PBR", "physical"),
            ("Unlit", "unlit"),
            ("Toon", "toon"),
            ("SkyProcedural", "skyprocedural"),
            ("SkyBox", "skycube"),
        ] {
            let rel = format!("internal/shaders/{stem}.shader");
            let text = std::fs::read_to_string(dir.join(format!("{stem}.shader")))
                .expect("内置着色器文件缺失");
            let expect = serialize_shader_file(&rel, kind).replace("\r\n", "\n");
            let norm = text.replace("\r\n", "\n");
            assert_eq!(norm, expect, "internal/{stem}.shader 与序列化模板不一致");
        }
    }

    #[test]
    fn resolve_shader_kind_falls_back() {
        let dir = std::env::temp_dir().join(format!("tve_shader_test_{}", std::process::id()));
        let shader_rel = "assets/shaders/T.shader";
        let full = dir.join(&shader_rel);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(&full, serialize_shader_file(shader_rel, "unlit")).unwrap();
        assert_eq!(
            resolve_shader_kind(&dir, shader_rel, "physical"),
            "unlit"
        );
        // 缺失文件回退 legacy
        assert_eq!(
            resolve_shader_kind(&dir, "assets/shaders/Missing.shader", "toon"),
            "toon"
        );
        // 非 .shader 引用（天空等内置名）不走解析
        assert_eq!(resolve_shader_kind(&dir, "SkyBox", ""), "physical");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn serialize_sky_material_references_shaders() {
        // 天空材质 shader 字段引用内置天空着色器资产（材质 ↔ 着色器分离）；kind 保留为快照判别
        let v: Value = serde_json::from_str(
            &crate::scene::migrate::serialize_sky_material_file("MySky", "procedural"),
        )
        .unwrap();
        assert_eq!(v["shader"], "internal/shaders/SkyProcedural.shader");
        assert_eq!(v["kind"], "procedural");
        let v2: Value = serde_json::from_str(
            &crate::scene::migrate::serialize_sky_material_file("X", "cube"),
        )
        .unwrap();
        assert_eq!(v2["shader"], "internal/shaders/SkyBox.shader");
        assert_eq!(v2["kind"], "cube");
        assert_eq!(v2["cubeMap"], "internal/skybox/DefaultSkybox.texcube");
        // 未知 kind 归一为 cube
        let v3: Value = serde_json::from_str(
            &crate::scene::migrate::serialize_sky_material_file("Y", "whatever"),
        )
        .unwrap();
        assert_eq!(v3["shader"], "internal/shaders/SkyBox.shader");
        assert_eq!(v3["kind"], "cube");
    }

    #[test]
    fn rewrite_shader_directive_follows_path() {
        use crate::scene::migrate::rewrite_shader_directive;
        let dir = std::env::temp_dir().join(format!("tve_shader_rewrite_{}", std::process::id()));
        // 文件：旧指令（如历史遗留 "Custom/T"）在复制/移动后跟随新路径
        let rel = "assets/shaders/Copy.shader";
        let full = dir.join(rel);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(&full, serialize_shader_file("assets/shaders/Old.shader", "toon")).unwrap();
        rewrite_shader_directive(&dir, rel);
        let (name, kind) = parse_shader_doc(&std::fs::read_to_string(&full).unwrap()).unwrap();
        assert_eq!(name, "Copy");
        assert_eq!(kind, "toon");

        // 目录：递归改写目录下全部 .shader
        let sub_rel = "assets/shaders/dir/Nested.shader";
        let sub = dir.join(sub_rel);
        std::fs::create_dir_all(sub.parent().unwrap()).unwrap();
        std::fs::write(&sub, serialize_shader_file("assets/shaders/Other.shader", "unlit")).unwrap();
        rewrite_shader_directive(&dir, "assets/shaders/dir");
        let (name2, _) = parse_shader_doc(&std::fs::read_to_string(&sub).unwrap()).unwrap();
        assert_eq!(name2, "Nested");
        std::fs::remove_dir_all(&dir).ok();
    }
}
