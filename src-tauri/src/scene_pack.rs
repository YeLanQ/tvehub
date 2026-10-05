//! 场景资产收集与产物落盘底座（预览导出与构建管线共用的最底层）：
//! - [`collect_scene_assets`]：单场景引用资产收集（材质/贴图/模型/天空盒/音频/
//!   动画/逻辑/粒子/UI/地形贴图），文本进 files、二进制进 binaries；
//! - [`write_export_dir`]：产物落盘（staging 暂存 + 整目录换入，原子语义）；
//! - [`split_wasm_base64_files`]：前端 base64 混在文本 map 里的 .wasm 分流；
//! - [`gltf_sibling_rel`] / [`percent_decode`]：.gltf 外部引用解析与路径解码。
//!
//! 本模块是 crate 的叶子底座：只依赖 scene/project 等基础模块，不依赖
//! preview（预览）与 build（构建）两个上层消费者。

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use base64::Engine as _;

/// 重建 `out` 导出目录，写入文本与二进制产物（预览/构建导出共用）。
/// 先写 `out.staging` 再整体换入：导出上百个文件要持续数秒，而该目录会被网页
/// 预览服务与局域网共享**按引用实时读盘**——边删边写会让访问者撞上半成品 404；
/// 换入只占两次 rename 的毫秒级空窗。
pub(crate) fn write_export_dir(
    out: &Path,
    files: HashMap<String, String>,
    binaries: &HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    let staging = out.with_extension("staging");
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    fs::create_dir_all(&staging).map_err(|e| format!("创建导出目录失败: {}", e))?;
    for (rel, content) in &files {
        write_export_file(&staging, rel, content.as_bytes())?;
    }
    for (rel, bytes) in binaries {
        write_export_file(&staging, rel, bytes)?;
    }

    let backup = out.with_extension("old");
    if out.exists() {
        let _ = fs::remove_dir_all(&backup);
        fs::rename(out, &backup).map_err(|e| format!("换出旧导出目录失败: {}", e))?;
    }
    // Windows 下批量新写文件后立即整目录换名，偶发被杀软/索引器的瞬时句柄
    // 拒绝（os error 5）：短重试消化瞬时锁；持续失败多为外部进程长期持有
    // （如 dev 时 vite watcher 监听了仓库内 .tmp）——按原语义报错并保留旧目录
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..4 {
        match fs::rename(&staging, out) {
            Ok(()) => {
                last_err = None;
                break;
            }
            Err(e) => {
                eprintln!("[write_export] 目录换入重试 #{attempt}: {e}");
                last_err = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(600));
            }
        }
    }
    if let Some(e) = last_err {
        // 换入失败把旧目录放回去：宁可继续服务旧内容，也不留一个空目录
        let restored = fs::rename(&backup, out).is_ok();
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "提交导出目录失败: {e}{}",
            if restored { "" } else { "（旧目录未能恢复）" }
        ));
    }
    if backup.exists() {
        let _ = fs::remove_dir_all(&backup);
    }
    Ok(())
}

/// 写入单个导出文件（路径守卫：拒绝绝对路径/反斜杠/越界段）
fn write_export_file(out: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
    if rel.is_empty()
        || Path::new(rel).is_absolute()
        || rel.contains('\\')
        || rel.split('/').any(|s| s == "..")
    {
        return Err(format!("非法预览文件相对路径: {rel}"));
    }
    let target = out.join(rel);
    if let Some(parent_dir) = target.parent() {
        fs::create_dir_all(parent_dir).map_err(|e| e.to_string())?;
    }
    fs::write(&target, bytes).map_err(|e| format!("写入预览文件失败 '{}': {}", rel, e))
}

/// 读取资产二进制（internal/… → 内置目录；其余 → 项目根沙箱内）
fn read_asset_bytes(root: &Path, rel: &str) -> Result<Vec<u8>, String> {
    if rel == "internal" || rel.starts_with("internal/") {
        let sub = rel.strip_prefix("internal/").unwrap_or("");
        if sub.is_empty()
            || sub.contains('\\')
            || sub.split('/').any(|s| s == ".." || s.is_empty())
        {
            return Err(format!("非法内置资源相对路径: {rel}"));
        }
        let path = crate::internal_root().join(sub);
        return fs::read(&path).map_err(|e| format!("读取内置资源失败 '{rel}': {e}"));
    }
    let path = crate::project::resolve_in_root(root, rel)?;
    fs::read(&path).map_err(|e| format!("读取文件失败 '{rel}': {e}"))
}

/// 材质文档引用的贴图字段（.mat JSON 内为相对路径字符串）
pub(crate) const TEXTURE_FIELDS: [&str; 5] =
    ["map", "metalnessMap", "roughnessMap", "normalMap", "emissiveMap"];

/// 收集单个场景引用的全部资产（材质/贴图/模型），写入 files（文本）与 binaries
/// （二进制）；跨场景共用同一 map 以去重。返回缺失（读取失败被跳过）的资产相对路径。
/// - .mat 材质文本随导出（缺失跳过，player 回退默认参数）；
/// - 材质引用的贴图二进制（缺失跳过，player 回退无贴图）；
/// - 模型资产（glb/gltf/fbx/obj）二进制随导出——player 按同相对路径 fetch 后解析回放
///   （含内嵌动画）；缺失项跳过（player 渲染空组并告警）；
/// - .gltf（JSON 文本）外部引用的 buffers[].uri / images[].uri 指向模型同目录
///   文件（.bin/贴图），一并随拷，保持与编辑器“同目录资源”解析规则一致。
pub(crate) fn collect_scene_assets(
    root_path: &Path,
    scene_text: &str,
    files: &mut HashMap<String, String>,
    binaries: &mut HashMap<String, Vec<u8>>,
) -> Vec<String> {
    let mut missing = Vec::new();
    let scene_json: serde_json::Value =
        serde_json::from_str(scene_text).unwrap_or(serde_json::Value::Null);

    let mut mat_refs = Vec::new();
    crate::scene::migrate::collect_material_refs(&scene_json, &mut mat_refs);
    for rel in &mat_refs {
        let Ok(text) = crate::scene::material::read_material_text(root_path, rel) else {
            missing.push(rel.clone());
            continue;
        };
        files.insert(rel.clone(), text.clone());
        // 材质引用的贴图二进制（缺失跳过，player 回退无贴图）
        if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&text) {
            // 材质引用的着色器资产（.shader 文本随导出；缺失跳过，player 回退 PBR）
            // 与着色器 Properties 的贴图参数（props 中按属性名存的贴图引用）：
            // 属性类型来自着色器源码（2D → sampler2D），据此把 props 里的引用一并打包
            if let Some(shader_rel) = doc.get("shader").and_then(|v| v.as_str()) {
                if shader_rel.ends_with(".shader") {
                    let shader_src = match files.get(shader_rel) {
                        Some(src) => Some(src.clone()),
                        None => match crate::scene::material::read_material_text(root_path, shader_rel) {
                            Ok(text) => {
                                files.insert(shader_rel.to_string(), text.clone());
                                Some(text)
                            }
                            Err(_) => {
                                missing.push(shader_rel.to_string());
                                None
                            }
                        },
                    };
                    if let Some(shader_src) = shader_src {
                        let parsed = crate::scene::shader::parse_shader(&shader_src);
                        let props = doc.get("props").and_then(|v| v.as_object());
                        for prop in parsed
                            .properties
                            .iter()
                            .filter(|p| p.kind == crate::scene::shader::PROP_TEXTURE)
                        {
                            let Some(tex) = props
                                .and_then(|m| m.get(&prop.key))
                                .and_then(|v| v.as_str())
                            else {
                                continue;
                            };
                            if tex.is_empty() || binaries.contains_key(tex) {
                                continue;
                            }
                            match read_asset_bytes(root_path, tex) {
                                Ok(bytes) => {
                                    binaries.insert(tex.to_string(), bytes);
                                }
                                Err(_) => missing.push(tex.to_string()),
                            }
                        }
                    }
                }
            }
            for field in TEXTURE_FIELDS {
                if let Some(tex) = doc.get(field).and_then(|v| v.as_str()) {
                    if !tex.is_empty() && !binaries.contains_key(tex) {
                        match read_asset_bytes(root_path, tex) {
                            Ok(bytes) => {
                                binaries.insert(tex.to_string(), bytes);
                            }
                            Err(_) => missing.push(tex.to_string()),
                        }
                    }
                }
            }
        }
    }

    let mut model_refs = Vec::new();
    crate::scene::migrate::collect_model_refs(&scene_json, &mut model_refs);
    for rel in &model_refs {
        let Ok(bytes) = read_asset_bytes(root_path, rel) else {
            missing.push(rel.clone());
            continue;
        };
        if rel.to_ascii_lowercase().ends_with(".gltf") {
            if let Ok(doc) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                for key in ["buffers", "images"] {
                    let Some(items) = doc.get(key).and_then(|v| v.as_array()) else {
                        continue;
                    };
                    for item in items {
                        let Some(uri) = item.get("uri").and_then(|v| v.as_str()) else {
                            continue;
                        };
                        if let Some(sibling) = gltf_sibling_rel(rel, uri) {
                            if sibling != *rel && !binaries.contains_key(&sibling) {
                                match read_asset_bytes(root_path, &sibling) {
                                    Ok(b) => {
                                        binaries.insert(sibling, b);
                                    }
                                    Err(_) => missing.push(sibling),
                                }
                            }
                        }
                    }
                }
            }
        }
        binaries.insert(rel.clone(), bytes);
    }

    // 天空盒 TextureCube 引用：.texcube 文本随导出（缺失跳过，player 回退色带天空），
    // 其引用的全景图/六面贴图二进制一并随拷（缺失项跳过）
    let mut texcube_refs = Vec::new();
    crate::scene::migrate::collect_texcube_refs(&scene_json, &mut texcube_refs);
    for rel in &texcube_refs {
        let Ok(text) = crate::scene::texcube::read_texcube_text(root_path, rel) else {
            missing.push(rel.clone());
            continue;
        };
        files.insert(rel.clone(), text.clone());
        // 解析失败视作无引用（player 读取该文件同样解析失败 → 回退色带天空）
        let Some((_, _, map, faces)) = crate::scene::texcube::parse_texcube_doc(&text) else {
            continue;
        };
        let mut tex_refs: Vec<String> = Vec::new();
        if !map.is_empty() {
            tex_refs.push(map);
        }
        if let Some(faces) = faces {
            for f in [faces.px, faces.nx, faces.py, faces.ny, faces.pz, faces.nz] {
                if !f.is_empty() {
                    tex_refs.push(f);
                }
            }
        }
        for tex in tex_refs {
            if binaries.contains_key(&tex) || files.contains_key(&tex) {
                continue;
            }
            match read_asset_bytes(root_path, &tex) {
                Ok(bytes) => {
                    binaries.insert(tex, bytes);
                }
                Err(_) => missing.push(tex),
            }
        }
    }

    // 音源节点音频引用：二进制随导出（缺失跳过，player 侧该音源静音）
    let mut audio_refs = Vec::new();
    crate::scene::migrate::collect_audio_refs(&scene_json, &mut audio_refs);
    for rel in &audio_refs {
        if binaries.contains_key(rel) {
            continue;
        }
        match read_asset_bytes(root_path, rel) {
            Ok(bytes) => {
                binaries.insert(rel.clone(), bytes);
            }
            Err(_) => missing.push(rel.clone()),
        }
    }
    // 关键帧动画剪辑引用：.anim 文本随导出（缺失跳过，player 侧该组件空转）
    let mut anim_refs = Vec::new();
    crate::scene::migrate::collect_anim_refs(&scene_json, &mut anim_refs);
    for rel in &anim_refs {
        if files.contains_key(rel) {
            continue;
        }
        match crate::scene::material::read_material_text(root_path, rel) {
            Ok(text) => {
                files.insert(rel.clone(), text);
            }
            Err(_) => missing.push(rel.clone()),
        }
    }
    // 逻辑运行器引用：.fsm/.bt 文本随导出（缺失跳过，player 侧该运行器空转并告警）
    let mut logic_refs = Vec::new();
    crate::scene::migrate::collect_logic_refs(&scene_json, &mut logic_refs);
    for rel in &logic_refs {
        if files.contains_key(rel) {
            continue;
        }
        match crate::scene::material::read_material_text(root_path, rel) {
            Ok(text) => {
                files.insert(rel.clone(), text);
            }
            Err(_) => missing.push(rel.clone()),
        }
    }
    // 粒子系统节点贴图引用：图片二进制随导出（缺失跳过，player 回退内置软圆点）
    let mut particle_tex_refs = Vec::new();
    crate::scene::migrate::collect_particle_texture_refs(&scene_json, &mut particle_tex_refs);
    for rel in &particle_tex_refs {
        if binaries.contains_key(rel) {
            continue;
        }
        match read_asset_bytes(root_path, rel) {
            Ok(bytes) => {
                binaries.insert(rel.clone(), bytes);
            }
            Err(_) => missing.push(rel.clone()),
        }
    }
    // UI Widget 图片引用（uiImageNode/uiButtonNode 的 image）：二进制随导出
    // （缺失跳过，player 侧该 Widget 回退纯色矩形）
    let mut ui_image_refs = Vec::new();
    crate::scene::migrate::collect_ui_image_refs(&scene_json, &mut ui_image_refs);
    for rel in &ui_image_refs {
        if binaries.contains_key(rel) {
            continue;
        }
        match read_asset_bytes(root_path, rel) {
            Ok(bytes) => {
                binaries.insert(rel.clone(), bytes);
            }
            Err(_) => missing.push(rel.clone()),
        }
    }
    // 地形节点地形材质引用的贴图（splatmap + 图层 albedoMap/normalMap）：
    // 图片二进制随导出（缺失跳过，player 侧 splatmap 回退程序化混合）
    let mut terrain_tex_refs = Vec::new();
    crate::scene::migrate::collect_terrain_texture_refs(&scene_json, &mut terrain_tex_refs);
    for rel in &terrain_tex_refs {
        if binaries.contains_key(rel) {
            continue;
        }
        match read_asset_bytes(root_path, rel) {
            Ok(bytes) => {
                binaries.insert(rel.clone(), bytes);
            }
            Err(_) => missing.push(rel.clone()),
        }
    }
    missing
}

/// .wasm 运行时文件分流：前端清单把二进制 wasm 以 base64 混在 files map 里传入
/// （文本 IPC 通道会 UTF-8 损坏二进制），此处解码进 binaries 按字节写盘。
/// web 预览导出与 web 构建管线共用（微信管线有同构逻辑，错误文案渠道化）。
pub(crate) fn split_wasm_base64_files(
    files: &mut HashMap<String, String>,
    binaries: &mut HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    let wasm_keys: Vec<String> = files
        .keys()
        .filter(|rel| rel.ends_with(".wasm"))
        .cloned()
        .collect();
    for rel in wasm_keys {
        let text = files.remove(&rel).expect("key 刚从本 map 收集");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(text.as_bytes())
            .map_err(|e| format!("运行时 wasm 文件 base64 解码失败 '{rel}': {e}"))?;
        binaries.insert(rel, bytes);
    }
    Ok(())
}

/// .gltf 内外部引用（buffers[].uri / images[].uri）→ 模型同目录的资产相对路径。
/// data:/绝对地址、反斜杠与越出资产根（..）的引用返回 None（跳过不拷贝）。
pub(crate) fn gltf_sibling_rel(model_rel: &str, uri: &str) -> Option<String> {
    if uri.is_empty() || uri.contains('\\') || uri.contains("://") || uri.starts_with("data:") {
        return None;
    }
    let decoded = percent_decode(uri);
    let dir = match model_rel.rfind('/') {
        Some(i) => &model_rel[..i],
        None => "",
    };
    let joined = if dir.is_empty() { decoded } else { format!("{dir}/{decoded}") };
    let mut parts: Vec<&str> = Vec::new();
    for seg in joined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return None; // 越出资产根
                }
            }
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// 百分号解码（UTF-8；非法序列原样保留）——预览服务器与 .gltf 外部引用共用
pub(crate) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = hex_val(bytes[i + 1]);
            let l = hex_val(bytes[i + 2]);
            if let (Some(h), Some(l)) = (h, l) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use super::{collect_scene_assets, gltf_sibling_rel, percent_decode, split_wasm_base64_files, write_export_dir};

    /// .wasm 键（base64）从文本 files 分流进 binaries 按字节写盘；非 wasm 键不动；
    /// 非法 base64 报错。
    #[test]
    fn split_wasm_base64_files_routes_wasm_keys_to_binaries() {
        use base64::Engine as _;
        let mut files = std::collections::HashMap::new();
        files.insert("index.html".to_string(), "<html>".to_string());
        files.insert(
            "engine/runtime/physics-engines/rapier.wasm".to_string(),
            base64::engine::general_purpose::STANDARD.encode([0u8, 0x61, 0x73, 0x6d, 1]),
        );
        let mut binaries = std::collections::HashMap::new();
        split_wasm_base64_files(&mut files, &mut binaries).expect("合法 base64");
        assert!(!files.contains_key("engine/runtime/physics-engines/rapier.wasm"), "wasm 键移出文本表");
        assert_eq!(binaries.get("engine/runtime/physics-engines/rapier.wasm").unwrap(), &[0, 0x61, 0x73, 0x6d, 1]);
        assert_eq!(files.get("index.html").unwrap(), "<html>", "文本键不动");

        let mut bad = std::collections::HashMap::new();
        bad.insert("engine/x.wasm".to_string(), "!!not-base64!!".to_string());
        assert!(split_wasm_base64_files(&mut bad, &mut std::collections::HashMap::new()).is_err());
    }

    /// 导出目录必须整体换入：成功时旧文件清干净、无暂存残留；
    /// 中途失败（非法路径）时旧产物原样保留——共享/预览不能撞到半成品。
    #[test]
    fn write_export_dir_swaps_atomically_and_keeps_old_on_failure() {
        let out = std::env::temp_dir().join(format!("tve-export-swap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&out);
        let mut files = std::collections::HashMap::new();
        files.insert("index.html".to_string(), "<v1>".to_string());
        files.insert("engine/core/log.mjs".to_string(), "export const v = 1;".to_string());
        write_export_dir(&out, files.clone(), &Default::default()).expect("首次导出");
        assert!(out.join("index.html").exists());
        assert!(out.join("engine/core/log.mjs").exists());
        assert!(!out.with_extension("staging").exists(), "无暂存残留");
        assert!(!out.with_extension("old").exists(), "无备份残留");

        // 二次导出删旧纳新
        let mut files2 = std::collections::HashMap::new();
        files2.insert("index.html".to_string(), "<v2>".to_string());
        write_export_dir(&out, files2, &Default::default()).expect("覆盖导出");
        assert_eq!(fs::read_to_string(out.join("index.html")).unwrap(), "<v2>");
        assert!(!out.join("engine").exists(), "旧文件不残留");
        assert!(!out.with_extension("old").exists());

        // 中途失败（非法相对路径在写入阶段被拒）：旧产物原样保留，可继续被访问
        let mut bad = std::collections::HashMap::new();
        bad.insert("index.html".to_string(), "<v3>".to_string());
        bad.insert("../escape.txt".to_string(), "x".to_string());
        assert!(write_export_dir(&out, bad, &Default::default()).is_err());
        assert_eq!(
            fs::read_to_string(out.join("index.html")).unwrap(),
            "<v2>",
            "失败不破坏既有产物"
        );
        let _ = fs::remove_dir_all(&out);
        let _ = fs::remove_dir_all(&out.with_extension("staging"));
        let _ = fs::remove_dir_all(&out.with_extension("old"));
    }

    /// 材质引用的着色器（.mat 的 shader）与其贴图参数（props）必须随产物打包：
    /// 缺失会让产物内效果整体消失（且只表现为"没效果"，不好排查）。
    #[test]
    fn collect_scene_assets_packs_shader_and_its_textures() {
        let root = std::env::temp_dir().join(format!("tve-shader-pack-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("assets/materials")).unwrap();
        fs::create_dir_all(root.join("assets/shaders")).unwrap();
        fs::create_dir_all(root.join("assets/textures")).unwrap();
        fs::write(
            root.join("assets/shaders/Rim.shader"),
            "Shader \"assets/shaders/Rim\"\n{\n    Properties\n    {\n        _Tint (\"Tint\", Color) = (1, 1, 1, 1)\n        _MainTex (\"Tex\", 2D) = \"white\" {}\n    }\n    Base \"PBR\"\n    Hook \"Emissive\" { emissive += _Tint.rgb; }\n}\n",
        )
        .unwrap();
        fs::write(root.join("assets/textures/a.png"), b"png").unwrap();
        fs::write(
            root.join("assets/materials/M.mat"),
            serde_json::json!({
                "$type": "material",
                "name": "M",
                "shader": "assets/shaders/Rim.shader",
                "props": { "_MainTex": "assets/textures/a.png" },
            })
            .to_string(),
        )
        .unwrap();

        let scene = serde_json::json!({
            "type": "scene",
            "root": { "type": "meshNode", "id": "m", "material": "assets/materials/M.mat" },
        })
        .to_string();
        let mut files = std::collections::HashMap::new();
        let mut binaries = std::collections::HashMap::new();
        let missing = collect_scene_assets(&root, &scene, &mut files, &mut binaries);

        assert!(
            files.contains_key("assets/shaders/Rim.shader"),
            "着色器文本应随产物打包（files: {:?}）",
            files.keys().collect::<Vec<_>>()
        );
        assert!(
            binaries.contains_key("assets/textures/a.png"),
            "着色器的贴图参数应随产物打包（binaries: {:?}）",
            binaries.keys().collect::<Vec<_>>()
        );
        assert!(missing.is_empty(), "无缺失资产（实际 {missing:?}）");

        let _ = fs::remove_dir_all(&root);
    }

    /// 逻辑运行器节点的 .fsm/.bt 引用必须随产物打包为文本：
    /// 缺失会让播放器侧运行器空转（只表现为"逻辑没跑"，不好排查）。
    #[test]
    fn collect_scene_assets_packs_logic_assets() {
        let root = std::env::temp_dir().join(format!("tve-logic-pack-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("assets/logic")).unwrap();
        fs::write(
            root.join("assets/logic/Enemy.fsm"),
            serde_json::json!({
                "$type": "fsm", "$ver": 1, "name": "Enemy",
                "graph": { "entry": "s1", "states": [], "transitions": [], "params": {} }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            root.join("assets/logic/Patrol.bt"),
            serde_json::json!({
                "$type": "behaviortree", "$ver": 1, "name": "Patrol",
                "tree": { "id": "n1", "type": "sequence", "children": [] }
            })
            .to_string(),
        )
        .unwrap();

        let scene = serde_json::json!({
            "type": "scene",
            "root": { "type": "node", "id": "grp", "children": [
                { "type": "fsmRunnerNode", "id": "r1", "settings": { "asset": "assets/logic/Enemy.fsm", "autoStart": true, "speed": 1 } },
                { "type": "btRunnerNode", "id": "r2", "settings": { "asset": "assets/logic/Patrol.bt", "autoStart": true, "speed": 1 } },
                { "type": "btRunnerNode", "id": "r3", "settings": { "asset": "", "autoStart": true, "speed": 1 } }
            ] }
        })
        .to_string();
        let mut files = std::collections::HashMap::new();
        let mut binaries = std::collections::HashMap::new();
        let missing = collect_scene_assets(&root, &scene, &mut files, &mut binaries);

        assert!(
            files.contains_key("assets/logic/Enemy.fsm"),
            ".fsm 文本应随产物打包（files: {:?}）",
            files.keys().collect::<Vec<_>>()
        );
        assert!(
            files.contains_key("assets/logic/Patrol.bt"),
            ".bt 文本应随产物打包（files: {:?}）",
            files.keys().collect::<Vec<_>>()
        );
        assert!(missing.is_empty(), "无缺失资产（实际 {missing:?}）");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn gltf_sibling_resolves_against_model_dir() {
        assert_eq!(
            gltf_sibling_rel("assets/models/a.glb".into(), "scene.bin").as_deref(),
            Some("assets/models/scene.bin")
        );
        // 子目录与 ../ 回溯按相对路径归一化
        assert_eq!(
            gltf_sibling_rel("assets/models/a.gltf".into(), "tex/diffuse.png").as_deref(),
            Some("assets/models/tex/diffuse.png")
        );
        assert_eq!(
            gltf_sibling_rel("assets/models/sub/a.gltf".into(), "../shared.buf").as_deref(),
            Some("assets/models/shared.buf")
        );
        // 根目录模型（无目录段）直接归一化
        assert_eq!(gltf_sibling_rel("a.gltf".into(), "./b.bin").as_deref(), Some("b.bin"));
    }

    #[test]
    fn gltf_sibling_rejects_absolute_and_escape() {
        assert_eq!(gltf_sibling_rel("assets/models/a.gltf".into(), ""), None);
        assert_eq!(gltf_sibling_rel("assets/models/a.gltf".into(), "data:application/octet;base64,AAA"), None);
        assert_eq!(gltf_sibling_rel("assets/models/a.gltf".into(), "https://cdn.example.com/x.png"), None);
        assert_eq!(gltf_sibling_rel("assets/models/a.gltf".into(), "C:\\x.png"), None);
        // .. 越出资产根 → 空地址（守卫拒绝）
        assert_eq!(gltf_sibling_rel("assets/models/a.gltf".into(), "../../../../etc/passwd"), None);
    }

    /// 百分号解码：常规编码、+% 字面量、非法十六进制保留原样
    #[test]
    fn percent_decode_decodes_and_preserves_invalid() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("%E4%B8%AD"), "中");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
