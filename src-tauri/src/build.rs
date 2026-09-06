//! 构建导出：前端收集运行时文本 → Rust 执行打包 → 产物写入
//! `<项目>/build/<渠道>/` → 返回自描述结果）：
//! - `build_export`：把选中的场景及其引用资产（.mat 材质/贴图/模型）与网页运行时
//!   （player + three libs，由前端 fetch 传入）打包为可部署的静态网页产物；
//!   多场景时写入 scenes/<场景名>.json，入口由 config.json 的 mainScene 决定
//!   （player 支持 ?scene=<场景名> 查询参数切换）；
//! - 产物形态：多文件（场景/资产按相对路径落盘）或单页（场景/资产内联进 index.html
//!   的 `window.__TVE_BUILD_DATA`，产物无 assets/、scenes/ 目录；运行时代码文件保留）；
//! - Gzip 压缩：场景与资产打进单个 gzip 归档（多文件写 assets.gzip；单页 base64 内联），
//!   运行时用浏览器原生 DecompressionStream 解压并经 fetch 拦截供资产（无需服务器配合）；
//! - 渠道：web 完整实现；wechat（微信小游戏）为占位渠道，明确报"暂未支持"。
//!
//! 复用 preview.rs 的资产收集（collect_scene_assets）与文件写入（write_export_dir），
//! 资源二进制全部由 Rust 直接从磁盘读取，不以 base64 穿过 IPC。

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::Serialize;

/// 当前支持的构建渠道（wechat 为 UI 占位，未实现）
const SUPPORTED_CHANNELS: [&str; 1] = ["web"];

/// 产物内单场景条目（前端结果展示用）
#[derive(Serialize, Clone)]
pub struct PackedScene {
    /// 场景显示名（去扩展名的文件名，重名自动加序号；?scene= 参数用它）
    pub name: String,
    /// 项目内相对路径（.scene 文件）
    pub rel: String,
    /// 产物内相对文件（scenes/<name>.json）
    pub file: String,
}

/// 构建结果（自描述；前端结果展示用）
#[derive(Serialize)]
pub struct BuildResult {
    pub ok: bool,
    pub channel: String,
    /// 输出目录绝对路径
    pub output_dir: String,
    /// 主场景项目相对路径
    pub main_scene: String,
    pub main_scene_name: String,
    pub scenes: Vec<PackedScene>,
    /// 产物形态：true = 单页（数据内联 index.html）/ false = 多文件
    pub single_page: bool,
    /// 资产是否 gzip 归档
    pub gzip: bool,
    /// 发布模式：资源 uid 重命名 + 引用重写 + JSON 压缩
    pub release: bool,
    pub assets_packed: usize,
    pub missing: Vec<String>,
    pub message: String,
}

/// 场景文件在产物内的显示名（去目录与 .scene 扩展名；重名追加序号去重）
fn scene_entry_name(rel: &str, used: &mut Vec<String>) -> String {
    let base = rel.rsplit('/').next().unwrap_or(rel);
    let stem = base.strip_suffix(".scene").unwrap_or(base);
    let mut name = stem.to_string();
    let mut n = 2;
    while used.iter().any(|u| u == &name) {
        name = format!("{stem}-{n}");
        n += 1;
    }
    used.push(name.clone());
    name
}

/// 网页运行时代码文件（多文件/单页均按文件落盘，不进归档/内联数据）；
/// 入口页 index.html 与多模板附加页 index-<模板>.html 都算运行时代码
fn is_runtime_code(rel: &str) -> bool {
    rel == "player.mjs"
        || rel.starts_with("libs/")
        || is_entry_page(rel)
}

/// 入口页：首个模板生成 index.html，其余模板生成 index-<模板目录>.html
fn is_entry_page(rel: &str) -> bool {
    rel == "index.html" || (rel.starts_with("index-") && rel.ends_with(".html"))
}

/// fnv1a64 → 16 位十六进制（无 .meta 资产的确定性 uid，路径稳定）
fn fallback_uid(rel: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in rel.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// uid 新相对路径：保留目录与扩展名，仅换文件名（player 按扩展名分派解析器）
fn uid_rel(rel: &str, uid: &str) -> String {
    let (dir, file) = match rel.rfind('/') {
        Some(i) => (&rel[..=i], &rel[i + 1..]),
        None => ("", rel),
    };
    let ext = match file.rfind('.') {
        Some(_) => format!(".{}", file.rsplit('.').next().unwrap_or("")),
        None => String::new(),
    };
    format!("{dir}{uid}{ext}")
}

/// 项目资产的 .meta uuid（internal 内置资产无 .meta，返回 None 走哈希回退）
fn meta_uuid(root_path: &Path, rel: &str) -> Option<String> {
    if rel.starts_with("internal/") {
        return None;
    }
    let text = fs::read_to_string(
        crate::project::resolve_in_root(root_path, &format!("{rel}.meta")).ok()?,
    )
    .ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("uuid")
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 递归重写 JSON 里 meshNode 的 material/model 资产引用
fn rewrite_scene_refs(v: &mut serde_json::Value, renames: &HashMap<String, String>) {
    match v {
        serde_json::Value::Array(items) => {
            for i in items {
                rewrite_scene_refs(i, renames);
            }
        }
        serde_json::Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                if (k == "material" || k == "model") && val.is_string() {
                    if let Some(new) = renames.get(val.as_str().unwrap_or("")) {
                        *val = serde_json::Value::String(new.clone());
                    }
                } else {
                    rewrite_scene_refs(val, renames);
                }
            }
        }
        _ => {}
    }
}

/// 重写 .mat JSON 里贴图字段引用；parse 成功则同时紧凑化（发布模式 JSON 压缩）
fn rewrite_mat_text(text: &str, renames: &HashMap<String, String>) -> String {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(text) else {
        return text.to_string();
    };
    if let serde_json::Value::Object(map) = &mut v {
        for (k, val) in map.iter_mut() {
            if crate::preview::TEXTURE_FIELDS.contains(&k.as_str()) && val.is_string() {
                if let Some(new) = renames.get(val.as_str().unwrap_or("")) {
                    *val = serde_json::Value::String(new.clone());
                }
            }
        }
    }
    v.to_string()
}

/// 发布模式处理：为打包资产分配 uid（.meta uuid 优先，否则路径哈希；保留目录与
/// 扩展名）、重写场景与材质引用、场景/材质 JSON 紧凑化。返回重命名表。
/// 场景 JSON 文件名保持不变（config.scenes 按名引用，是产物公开入口）。
fn apply_release(
    root_path: &Path,
    files: &mut HashMap<String, String>,
    binaries: &mut HashMap<String, Vec<u8>>,
    scene_texts: &mut [(String, String)],
) -> HashMap<String, String> {
    let mut renames: HashMap<String, String> = HashMap::new();
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut uid_for = |rel: &str| -> String {
        let base = || meta_uuid(root_path, rel).unwrap_or_else(|| fallback_uid(rel));
        let mut uid = base();
        let mut n = 2;
        while !used.insert(uid.clone()) {
            uid = format!("{}-{n}", base());
            n += 1;
        }
        uid
    };

    // 重命名表（运行时代码与入口页除外）
    let asset_rels: Vec<String> = files
        .keys()
        .chain(binaries.keys())
        .filter(|rel| !is_runtime_code(rel))
        .cloned()
        .collect();
    for rel in asset_rels {
        let new_rel = uid_rel(&rel, &uid_for(&rel));
        renames.insert(rel, new_rel);
    }

    // 键重命名
    for (old, new) in &renames {
        if let Some(v) = files.remove(old) {
            files.insert(new.clone(), v);
        }
        if let Some(v) = binaries.remove(old) {
            binaries.insert(new.clone(), v);
        }
    }

    // 场景引用重写 + JSON 紧凑化
    for (_, text) in scene_texts.iter_mut() {
        if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(text) {
            rewrite_scene_refs(&mut v, &renames);
            *text = v.to_string();
        }
    }

    // 材质贴图引用重写 + 紧凑化
    for (rel, text) in files.iter_mut() {
        if rel.ends_with(".mat") {
            *text = rewrite_mat_text(text, &renames);
        }
    }

    renames
}

/// 归档帧格式：u32 条数(LE) + 每条 [u32 pathLen][path][u32 dataLen][data]，整体 gzip
fn build_archive_bytes(entries: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let mut raw = Vec::new();
    raw.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (path, data) in entries {
        raw.extend_from_slice(&(path.len() as u32).to_le_bytes());
        raw.extend_from_slice(path.as_bytes());
        raw.extend_from_slice(&(data.len() as u32).to_le_bytes());
        raw.extend_from_slice(data);
    }
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(&raw).map_err(|e| format!("gzip 压缩失败: {e}"))?;
    enc.finish().map_err(|e| format!("gzip 压缩失败: {e}"))
}

/// 单页模式的内联数据脚本：注入 index.html，运行时经 window.__TVE_BUILD_DATA 读取
fn inline_data_script(
    config: serde_json::Map<String, serde_json::Value>,
    entries: &[(String, Vec<u8>)],
    gzip: bool,
) -> Result<String, String> {
    let mut data = serde_json::Map::new();
    data.insert("config".to_string(), serde_json::Value::Object(config));
    if gzip {
        data.insert(
            "pak".to_string(),
            serde_json::Value::String(BASE64.encode(build_archive_bytes(entries)?)),
        );
    } else {
        let assets: serde_json::Map<String, serde_json::Value> = entries
            .iter()
            .map(|(rel, bytes)| (rel.clone(), serde_json::Value::String(BASE64.encode(bytes))))
            .collect();
        data.insert("assets".to_string(), serde_json::Value::Object(assets));
    }
    Ok(format!(
        "<script>window.__TVE_BUILD_DATA = {};</script>",
        serde_json::Value::Object(data)
    ))
}

/// 构建导出：打包选中场景 + 引用资产 + 网页运行时到 `<项目>/build/web/`。
/// files 为前端 fetch 传入的网页运行时文本（index.html/player.mjs/libs/*，
/// 属 WebView 打包资源，编辑器离线可用）；场景与资产由 Rust 直读磁盘。
#[tauri::command]
pub async fn build_export(
    root: String,
    channel: String,
    scenes: Vec<String>,
    main_scene: String,
    title: String,
    debug: bool,
    single_page: bool,
    gzip: bool,
    release: bool,
    files: HashMap<String, String>,
) -> Result<BuildResult, String> {
    build_export_impl(
        root,
        channel,
        scenes,
        main_scene,
        title,
        debug,
        single_page,
        gzip,
        release,
        files,
    )
}

/// 发布模式 JS 压缩：保守压缩（去注释 + 空白折叠，语义不变；见 js_minify 模块）
fn minify_js_source(text: &str) -> String {
    crate::js_minify::minify_js(text)
}

/// 需要压缩的运行时脚本（.js/.mjs；已压缩的 *.min.* 跳过，如 three 运行时）
fn is_minifiable_script(rel: &str) -> bool {
    is_runtime_code(rel)
        && (rel.ends_with(".js") || rel.ends_with(".mjs"))
        && !rel.contains(".min.")
}

/// 构建导出实现（同步，便于单元测试直接驱动完整流程）
#[allow(clippy::too_many_arguments)]
fn build_export_impl(
    root: String,
    channel: String,
    scenes: Vec<String>,
    main_scene: String,
    title: String,
    debug: bool,
    single_page: bool,
    gzip: bool,
    release: bool,
    files: HashMap<String, String>,
) -> Result<BuildResult, String> {
    let _ = title; // 产物清单已移除；保留参数与前端配置对齐
    if !SUPPORTED_CHANNELS.contains(&channel.as_str()) {
        return Err(format!("构建渠道 '{channel}' 暂未支持"));
    }
    if scenes.is_empty() {
        return Err("至少选择一个构建场景".to_string());
    }
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("项目目录不存在: '{}'", root_path.display()));
    }

    // 主场景必须在选中列表内（前端默认首个选中项；这里兜底）
    let main_scene = if scenes.iter().any(|s| s == &main_scene) {
        main_scene
    } else {
        scenes[0].clone()
    };

    let out = root_path.join("build").join(&channel);
    let mut files = files;
    if !files.contains_key("index.html") {
        return Err("网页运行时缺少 index.html".to_string());
    }
    let mut binaries: HashMap<String, Vec<u8>> = HashMap::new();

    // 逐场景：读盘 → 收集引用资产（跨场景去重）；场景文本暂存，按产物形态落盘/进归档
    let mut packed: Vec<PackedScene> = Vec::new();
    let mut used_names: Vec<String> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let mut scene_texts: Vec<(String, String)> = Vec::new();
    for rel in &scenes {
        let text = crate::project::resolve_in_root(&root_path, rel)
            .and_then(|p| fs::read_to_string(&p).map_err(|e| e.to_string()))
            .map_err(|e| format!("读取场景失败 '{rel}': {e}"))?;
        missing.extend(crate::preview::collect_scene_assets(
            &root_path,
            &text,
            &mut files,
            &mut binaries,
        ));
        let name = scene_entry_name(rel, &mut used_names);
        scene_texts.push((format!("scenes/{name}.json"), text));
        packed.push(PackedScene {
            name,
            rel: rel.clone(),
            file: String::new(),
        });
    }
    for (i, (file, _)) in scene_texts.iter().enumerate() {
        packed[i].file = file.clone();
    }

    // 发布模式：资源 uid 重命名 + 场景/材质引用重写 + JSON 压缩
    if release {
        apply_release(&root_path, &mut files, &mut binaries, &mut scene_texts);
    }

    // config = 项目配置（设计分辨率/缩放模式/渲染合成等，player 舞台直接消费）
    // + 构建入口信息（mainScene/scenes/debug）
    let project_cfg: serde_json::Value = fs::read_to_string(root_path.join("project.config.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::Value::Null);
    let main_name = packed
        .iter()
        .find(|s| s.rel == main_scene)
        .map(|s| s.name.clone())
        .unwrap_or_default();
    let mut cfg = match project_cfg {
        serde_json::Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    cfg.insert("mainScene".to_string(), serde_json::Value::String(main_name.clone()));
    cfg.insert(
        "scenes".to_string(),
        serde_json::Value::Array(
            packed
                .iter()
                .map(|s| serde_json::json!({ "name": s.name, "file": s.file }))
                .collect(),
        ),
    );
    cfg.insert("debug".to_string(), serde_json::Value::Bool(debug));

    // 归档/内联条目：场景 JSON + 材质等文本（files 里非运行时代码的部分）+ 资产二进制
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    if single_page || gzip {
        for (rel, text) in scene_texts {
            entries.push((rel, text.into_bytes()));
        }
        let mut code_files: HashMap<String, String> = HashMap::new();
        for (rel, text) in files.drain() {
            if is_runtime_code(&rel) {
                code_files.insert(rel, text);
            } else {
                entries.push((rel, text.into_bytes()));
            }
        }
        files = code_files;
        for (rel, bytes) in binaries.drain() {
            entries.push((rel, bytes));
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
    } else {
        // 多文件非 gzip：场景/材质/资产按相对路径落盘
        for (rel, text) in scene_texts {
            files.insert(rel, text);
        }
    }

    // 发布模式：压缩运行时脚本（player / libs 模块 / 加载器；已压缩的 *.min.* 跳过）
    if release {
        for (rel, text) in files.iter_mut() {
            if is_minifiable_script(rel) {
                *text = minify_js_source(text);
            }
        }
    }

    // 产物组装
    if single_page {
        // 单页：数据内联全部入口页（index.html / index-<模板>.html；模板可用
        // {{BUILD_DATA}} 占位指定注入位置，无占位符时回退注入 </body> 前；
        // config 不落盘），运行时代码保留为文件
        let script = inline_data_script(cfg, &entries, gzip)?;
        for (rel, html) in files.iter_mut() {
            if is_entry_page(rel) {
                *html = if html.contains("{{BUILD_DATA}}") {
                    html.replacen("{{BUILD_DATA}}", &script, 1)
                } else if html.contains("</body>") {
                    html.replacen("</body>", &format!("{script}\n</body>"), 1)
                } else {
                    format!("{html}\n{script}")
                };
            }
        }
    } else {
        files.insert(
            "config.json".to_string(),
            serde_json::Value::Object(cfg).to_string(),
        );
        if gzip {
            // 多文件 gzip：场景/资产在 assets.gzip 归档中，运行时经 fetch 拦截读取
            let pak = build_archive_bytes(&entries)?;
            binaries.insert("assets.gzip".to_string(), pak);
        }
    }

    // 清空重建输出目录并写入全部产物
    crate::preview::write_export_dir(&out, files, &binaries)
        .map_err(|e| format!("写入构建产物失败: {e}"))?;

    let assets_packed = if single_page || gzip {
        entries.len()
    } else {
        binaries.len() + packed.len()
    };
    let output_dir = out.display().to_string();
    let missing_n = missing.len();
    Ok(BuildResult {
        ok: true,
        channel,
        output_dir,
        main_scene,
        main_scene_name: main_name,
        scenes: packed,
        single_page,
        gzip,
        release,
        assets_packed,
        missing: missing.clone(),
        message: if missing_n > 0 {
            format!("构建完成（{} 项缺失资产被跳过）", missing_n)
        } else {
            "构建完成".to_string()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_archive_bytes, build_export_impl, fallback_uid, is_runtime_code, scene_entry_name,
    };
    use std::collections::HashMap;
    use std::fs;

    #[test]
    fn scene_entry_name_dedups() {
        let mut used = Vec::new();
        assert_eq!(scene_entry_name("assets/Main.scene", &mut used), "Main");
        assert_eq!(scene_entry_name("assets/sub/Main.scene", &mut used), "Main-2");
        assert_eq!(scene_entry_name("Level1.scene", &mut used), "Level1");
    }

    #[test]
    fn archive_is_gzip() {
        let entries = vec![
            ("scenes/a.json".to_string(), b"{\"root\":1}".to_vec()),
            ("assets/models/x.glb".to_string(), vec![1u8, 2, 3]),
        ];
        let pak = build_archive_bytes(&entries).unwrap();
        // gzip 魔数 1f 8b
        assert_eq!(&pak[..2], &[0x1f, 0x8b]);
    }

    #[test]
    fn runtime_code_detection() {
        assert!(is_runtime_code("index.html"));
        assert!(is_runtime_code("index-single.html"));
        assert!(is_runtime_code("player.mjs"));
        assert!(is_runtime_code("libs/three.module.min.js"));
        assert!(!is_runtime_code("assets/materials/Default.mat"));
        assert!(!is_runtime_code("scenes/Main.json"));
        assert!(!is_runtime_code("config.json"));
        assert!(!is_runtime_code("index.json"));
    }

    /// 端到端：搭一个最小临时项目（场景 + 材质），跑单页/多文件 × gzip 全部形态，
    /// 校验产物内容（单页入口页含内联数据、多文件 + gzip 写 assets.gzip）。
    #[test]
    fn build_export_end_to_end_all_modes() {
        let base = std::env::temp_dir().join(format!("tve-build-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("proj");
        fs::create_dir_all(root.join("assets/materials")).unwrap();
        fs::create_dir_all(root.join("assets/models")).unwrap();
        fs::write(
            root.join("project.config.json"),
            r#"{"designResolution":{"width":1280,"height":720},"scaleMode":"fixedauto"}"#,
        )
        .unwrap();
        fs::write(
            root.join("assets/materials/M.mat"),
            r#"{"$type":"material","name":"M","materialType":"physical","map":"assets/textures/a.png"}"#,
        )
        .unwrap();
        fs::create_dir_all(root.join("assets/textures")).unwrap();
        fs::write(root.join("assets/textures/a.png"), [1u8, 2, 3, 4]).unwrap();
        fs::write(
            root.join("assets/Main.scene"),
            r#"{"type":"scene","root":{"type":"node","childIds":[],"children":[{"type":"meshNode","source":"primitive","material":"assets/materials/M.mat"}]}}"#,
        )
        .unwrap();

        let runtime_files = |entry: &str| {
            HashMap::from([
                ("index.html".to_string(), format!("<html><title>t</title><body>{entry}</body></html>")),
                ("player.mjs".to_string(), "// player".to_string()),
            ])
        };
        let scenes = vec!["assets/Main.scene".to_string()];

        for &(single_page, gzip) in &[(false, false), (false, true), (true, false), (true, true)] {
            let entry = if single_page { "{{BUILD_DATA}}" } else { "" };
            let result = build_export_impl(
                root.display().to_string(),
                "web".into(),
                scenes.clone(),
                "assets/Main.scene".into(),
                "T".into(),
                false,
                single_page,
                gzip,
                false,
                runtime_files(entry),
            )
            .unwrap_or_else(|e| panic!("single_page={single_page} gzip={gzip} 构建失败: {e}"));

            let out = root.join("build/web");
            assert!(out.join("player.mjs").is_file());
            if single_page {
                let html = fs::read_to_string(out.join("index.html")).unwrap();
                assert!(html.contains("__TVE_BUILD_DATA"), "单页入口页应内联数据");
                assert!(html.contains("scenes/Main.json"), "内联数据应包含场景条目");
                assert!(!out.join("scenes").exists(), "单页模式不落盘场景文件");
                assert!(!out.join("config.json").exists(), "单页模式不落盘 config.json");
            } else {
                assert!(out.join("config.json").is_file());
                if gzip {
                    let pak = fs::read(out.join("assets.gzip")).unwrap();
                    assert_eq!(&pak[..2], &[0x1f, 0x8b]);
                    assert!(!out.join("assets").exists(), "gzip 模式资产在归档中");
                    assert!(!out.join("scenes").exists(), "gzip 模式场景在归档中");
                } else {
                    assert!(out.join("scenes/Main.json").is_file());
                    assert!(out.join("assets/materials/M.mat").is_file());
                }
                let cfg: serde_json::Value =
                    serde_json::from_str(&fs::read_to_string(out.join("config.json")).unwrap()).unwrap();
                assert_eq!(cfg["scenes"][0]["file"], "scenes/Main.json");
            }
            assert!(result.ok);
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// 发布模式：资产 uid 重命名（.meta uuid 优先/哈希回退）、场景与材质引用重写、
    /// JSON 紧凑化；未发布模式保持原名。
    #[test]
    fn build_export_release_renames_and_rewrites() {
        let base = std::env::temp_dir().join(format!("tve-build-rel-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("proj");
        fs::create_dir_all(root.join("assets/materials")).unwrap();
        fs::create_dir_all(root.join("assets/textures")).unwrap();

        // 材质有 .meta（uuid 重命名）；贴图无 .meta（路径哈希回退）
        fs::write(
            root.join("assets/materials/M.mat"),
            r#"{
  "$type": "material",
  "map": "assets/textures/a.png",
  "normalMap": "assets/textures/a.png"
}"#,
        )
        .unwrap();
        fs::write(root.join("assets/materials/M.mat.meta"), r#"{"uuid":"11111111-2222-3333-4444-555555555555"}"#).unwrap();
        fs::write(root.join("assets/textures/a.png"), [9u8; 8]).unwrap();
        let scene = r#"{
  "type": "scene",
  "root": {
    "type": "node",
    "children": [
      { "type": "meshNode", "source": "primitive", "material": "assets/materials/M.mat" }
    ]
  }
}"#;
        fs::write(root.join("assets/Main.scene"), scene).unwrap();

        let run = |release: bool| {
            build_export_impl(
                root.display().to_string(),
                "web".into(),
                vec!["assets/Main.scene".into()],
                "assets/Main.scene".into(),
                "T".into(),
                false,
                false,
                false,
                release,
                HashMap::from([
                    ("index.html".to_string(), "<html></html>".to_string()),
                    ("player.mjs".to_string(), "// player entry\nimport { A } from \"./libs/helper.mjs\";\nconsole.log(A);\n".to_string()),
                    (
                        "libs/helper.mjs".to_string(),
                        "// helper comment\nexport const A = 1;\n".to_string(),
                    ),
                    (
                        "libs/three.module.min.js".to_string(),
                        "/*already minified*/export const T = 1;".to_string(),
                    ),
                ]),
            )
            .unwrap()
        };

        // 未发布：原名 + 保留缩进
        run(false);
        let out = root.join("build/web");
        assert!(out.join("assets/materials/M.mat").is_file());
        let scene_text = fs::read_to_string(out.join("scenes/Main.json")).unwrap();
        assert!(scene_text.contains("assets/materials/M.mat"));
        assert!(scene_text.contains('\n'), "未发布保留原格式");

        // 发布：uuid 文件名 + 引用重写 + JSON 紧凑
        let result = run(true);
        assert!(result.release);
        let out = root.join("build/web");
        assert!(!out.join("assets/materials/M.mat").exists(), "原名文件应已重命名");
        let mat_rel = "assets/materials/11111111-2222-3333-4444-555555555555.mat";
        assert!(out.join(&mat_rel).is_file(), "uuid 文件名（.meta uuid）");
        let scene_text = fs::read_to_string(out.join("scenes/Main.json")).unwrap();
        assert!(scene_text.contains(mat_rel), "场景材质引用已重写");
        assert!(!scene_text.contains('\n'), "场景 JSON 已紧凑化");
        let mat_text = fs::read_to_string(out.join(mat_rel)).unwrap();
        assert!(!mat_text.contains("assets/textures/a.png"), "贴图引用已重写");
        let fallback = fallback_uid("assets/textures/a.png");
        assert!(out.join(format!("assets/textures/{fallback}.png")).is_file(), "无 .meta 走路径哈希 uid");
        assert!(mat_text.contains(&fallback), "材质贴图引用重写为哈希 uid");

        // 脚本压缩：player/libs 脚本去注释压缩；*.min.* 跳过
        let player_min = fs::read_to_string(out.join("player.mjs")).unwrap();
        assert!(!player_min.contains("//"), "player.mjs 注释已移除");
        let helper_min = fs::read_to_string(out.join("libs/helper.mjs")).unwrap();
        assert!(!helper_min.contains("// helper"), "libs 脚本注释已移除");
        assert!(!helper_min.contains(" = 1;"), "libs 脚本空白已压缩");
        let three_min = fs::read_to_string(out.join("libs/three.module.min.js")).unwrap();
        assert!(three_min.contains("/*already minified*/"), "*.min.* 不重复压缩");
        let _ = fs::remove_dir_all(&base);
    }
}
