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
    serialize_shader_file, suggest_material_rel, sync_shader_directive_text, write_material_asset,
    MaterialParams, SHADER_EXT,
};
use super::shader::{parse_custom_shader, CustomShaderProgram, ShaderPropertyDef};

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

/// 解析后的着色器文档（前端资产检查器/材质参数面板用）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShaderDoc {
    pub name: String,
    pub kind: String,
    /// 着色器源码全文（ShaderLab 风格；检查器/源码编辑器展示用）
    pub source: String,
    /// 自定义着色器（kind=custom）暴露的属性（材质面板字段；其它种类为空表）
    pub properties: Vec<ShaderPropertyDef>,
    /// 自定义着色器组装后的程序（顶点/片元源码 + 渲染状态）；不可组装/非自定义时为 null
    pub program: Option<CustomShaderProgram>,
    /// 自定义着色器组装失败原因（null = 无错误；程序缺失时给面板与日志展示）
    pub error: Option<String>,
}

/// 解析 .shader 文本 → 文档（含自定义着色器的属性与程序组装结果）
fn shader_doc_from(text: String, rel: &str) -> Option<ShaderDoc> {
    let (name, kind) = parse_shader_doc(&text)?;
    let (properties, program, error) = if kind == "custom" {
        let parsed = parse_custom_shader(&text, rel);
        (parsed.properties, parsed.program, parsed.error)
    } else {
        (Vec::new(), None, None)
    };
    Some(ShaderDoc {
        name,
        kind,
        source: text,
        properties,
        program,
        error,
    })
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

/// 读取并解析 .shader 着色器资产（源码全文 + 自定义着色器的属性/程序）；不存在/非着色器文档返回 null
#[tauri::command]
pub async fn shader_read(root: String, rel: String) -> Result<Option<ShaderDoc>, String> {
    let root = std::path::PathBuf::from(&root);
    match read_material_text(&root, &rel) {
        Ok(text) => Ok(shader_doc_from(text, &rel)),
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

/// 保存着色器源码（正文逻辑，便于测试）：守卫 → 校验 → 指令跟随路径 → 落盘 → 重解析。
/// 供「着色器源码编辑器保存」与「创意工坊效果原型 → 项目 .shader 资产」共用。
pub(crate) fn write_shader_source(
    root: &std::path::Path,
    rel: &str,
    source: &str,
) -> Result<ShaderDoc, String> {
    if rel == "internal" || rel.starts_with("internal/") {
        return Err(format!("内置着色器只读，不可保存: {rel}"));
    }
    if !rel.to_ascii_lowercase().ends_with(SHADER_EXT) {
        return Err(format!("不是着色器资产: {rel}"));
    }
    if parse_shader_doc(source).is_none() {
        return Err(
            "源码不是可解析的着色器文档（需包含 Shader \"名称\" 指令），已拒绝保存".to_string(),
        );
    }
    // 指令跟随路径（无指令行/已一致时为 None，保持原文）
    let content = sync_shader_directive_text(source, rel).unwrap_or_else(|| source.to_string());
    write_material_asset(root, rel, &content)?;
    shader_doc_from(content, rel).ok_or_else(|| format!("保存后解析失败: {rel}"))
}

/// 保存着色器源码（源码编辑器保存路径 / 创意工坊效果原型落盘）：
/// - 仅项目内 .shader 可写（internal/ 内置只读）；
/// - 保存前把 `Shader "…"` 指令同步为当前路径（改名/移动后仍与资产一致）；
/// - 内容必须仍是可解析的着色器文档（否则拒绝覆盖，避免写坏资产）；
/// - 返回重新解析后的文档（含组装报错，供面板展示）。
#[tauri::command]
pub async fn shader_write_source(
    root: String,
    rel: String,
    source: String,
) -> Result<ShaderDoc, String> {
    write_shader_source(&std::path::PathBuf::from(&root), &rel, &source)
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

    /// 保存/新建着色器源码（源码编辑器保存 与 创意工坊效果原型落盘共用）：
    /// 指令跟随路径写入、可保存后重解析；内置目录/非 .shader/非法源码一律拒绝。
    #[test]
    fn write_shader_source_roundtrip_and_guards() {
        let dir = std::env::temp_dir().join(format!("tve_shader_write_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 创意工坊效果原型：源码里的指令名是仓库路径，落盘到项目后应同步为目标路径
        let source = serialize_shader_file("effect/Hologram.shader", "custom");
        let rel = "assets/shaders/Hologram.shader";
        let doc = write_shader_source(&dir, rel, &source).unwrap();
        assert_eq!(doc.kind, "custom");
        assert_eq!(doc.name, "Hologram");
        assert!(!doc.properties.is_empty());
        let written = std::fs::read_to_string(dir.join(rel)).unwrap();
        assert!(
            written.contains("Shader \"assets/shaders/Hologram\""),
            "写入后 Shader 指令应跟随资产路径"
        );
        assert!(
            !written.contains("Shader \"effect/Hologram\""),
            "原仓库路径的指令名应已被替换"
        );
        // 落盘内容可再解析（重复保存幂等）
        let again = write_shader_source(&dir, rel, &written).unwrap();
        assert_eq!(again.name, "Hologram");

        // 守卫：内置只读 / 非 .shader / 非法源码
        assert!(write_shader_source(&dir, "internal/shaders/PBR.shader", &source).is_err());
        assert!(write_shader_source(&dir, "assets/shaders/Note.txt", &source).is_err());
        assert!(write_shader_source(&dir, rel, "not a shader").is_err());
        // 非法源码被拒绝时不覆盖已有文件
        assert!(std::fs::read_to_string(dir.join(rel)).unwrap().contains("Shader "));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 自定义着色器文档：kind=custom 时随文档返回属性表与组装后的程序；
    /// 其它种类不返回（空表/null），组装失败时给 error 说明。
    #[test]
    fn shader_doc_exposes_custom_program() {
        let rel = "assets/shaders/Glow.shader";
        let text = serialize_shader_file(rel, "custom");
        let doc = shader_doc_from(text, rel).unwrap();
        assert_eq!(doc.kind, "custom");
        assert_eq!(doc.name, "Glow");
        assert_eq!(doc.properties.len(), 3);
        assert!(doc.error.is_none());
        let prog = doc.program.expect("自定义程序应已组装");
        assert!(prog.vertex.contains("void main() { vert(); }"));
        assert!(prog.fragment.contains("gl_FragColor = frag();"));
        assert_eq!(prog.side, "front");

        // 内置分支：属性表为空、无程序（不参与自定义组装）
        let pbr = shader_doc_from(
            serialize_shader_file("internal/shaders/PBR.shader", "physical"),
            "internal/shaders/PBR.shader",
        )
        .unwrap();
        assert_eq!(pbr.kind, "physical");
        assert!(pbr.properties.is_empty());
        assert!(pbr.program.is_none());
        assert!(pbr.error.is_none());

        // 自定义但缺少片元块 → 程序为 null + error 文案
        let bad = "Shader \"assets/shaders/Bad\"\n{\n SubShader\n {\n CGINCLUDE\n ENDCG\n CGPROGRAM\n void vert() { gl_Position = vec4(position, 1.0); }\n ENDCG\n }\n}\n";
        let doc2 = shader_doc_from(bad.to_string(), "assets/shaders/Bad.shader").unwrap();
        assert_eq!(doc2.kind, "custom");
        assert!(doc2.program.is_none());
        assert!(doc2.error.unwrap().contains("CGPROGRAM"));
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
            ("Custom", "custom"),
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
