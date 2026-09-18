//! 构建导出：前端收集运行时文本 → Rust 执行打包 → 产物写入
//! `<项目>/build/<渠道>/` → 返回自描述结果）：
//! - `build_export`：把选中的场景及其引用资产（.mat 材质/贴图/模型）与网页运行时
//!   （player + engine 引擎模块，由前端 fetch 传入）打包为可部署的静态网页产物；
//!   多场景时写入 scenes/<场景名>.json，入口由 config.json 的 mainScene 决定
//!   （player 支持 ?scene=<场景名> 查询参数切换）；
//! - 产物形态：多文件（场景/资产按相对路径落盘）或单页（场景/资产/运行时代码全部
//!   内联进 index.html 的 `window.__TVE_BUILD_DATA`，产物无 assets/、scenes/ 目录，
//!   也没有 player.mjs/engine 文件——只有一个单页 HTML）；
//! - Gzip 压缩：场景与资产打进单个 gzip 归档（多文件写 assets.gzip；单页 base64 内联），
//!   运行时用浏览器原生 DecompressionStream 解压并经 fetch 拦截供资产（无需服务器配合）；
//! - Gzip 资源地址：非空时多文件模式的 gzip 归档由运行时从 <地址>/assets.gzip 拉取
//!   （产物内仍生成归档，供上传 CDN；地址写入 config 的 gzipBase），留空按本地读取；
//! - Three CDN 地址：CDN 模式启用且地址非空时，three.js 运行时不内嵌进产物，
//!   代码里指向 three 的相对 import 直接重写为 CDN 绝对 URL（import map 拦截不了
//!   相对说明符，必须改写模块文本；多文件与单页同一套机制），留空仍内嵌；
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

/// CDN 模式不内嵌的 three.js 运行时文件（位于 engine/core/；其余引擎模块仍
/// 内嵌，经 import map 把代码里解析到同源 three 的说明符映射到资源地址下的
/// 同名文件）
const THREE_RUNTIME_FILES: [&str; 3] = [
    "engine/core/three.core.min.js",
    "engine/core/three.module.min.js",
    "engine/core/three.webgpu.min.js",
];

/// three.js 远程文件 URL：剥离产物内 engine/core/ 目录前缀后拼到基地址下——基地址就是
/// 直接包含 three.module.min.js / three.core.min.js / three.webgpu.min.js 的目录，官方
/// CDN 的版本目录（如 cdnjs / unpkg / jsdelivr 的 three.js/<版本>）与运行时内嵌文件
/// 同名同版本，可直接使用；自建 CDN 把产物 engine/core/ 里三个文件传到某目录后填该目录即可
fn three_cdn_url(base: &str, rel: &str) -> String {
    let file = rel.strip_prefix("engine/core/").unwrap_or(rel);
    join_cdn_url(base, file)
}

/// 远程地址归一化：去首尾空白与结尾 '/'；无协议时补 https://
/// （无协议地址会被浏览器按页面相对路径解析，与站点自身地址冲突）
fn normalize_base_url(raw: &str) -> String {
    let mut s = raw.trim().trim_end_matches('/').to_string();
    if !s.is_empty() && !s.contains("://") && !s.starts_with("//") {
        s = format!("https://{s}");
    }
    s
}

/// 基地址拼接相对路径，自动去重前缀：地址已以相对路径的首段（目录或文件名，
/// 如 /engine、/assets.gzip）结尾时不再重复拼接，避免 engine/engine、…/assets.gzip/assets.gzip
fn join_cdn_url(base: &str, rel: &str) -> String {
    let first = rel.split('/').next().unwrap_or("");
    let trimmed = base.strip_suffix(&format!("/{first}")).unwrap_or(base);
    format!("{trimmed}/{rel}")
}

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
    /// CDN 模式：three.js 运行时不内嵌，从资源地址在线加载
    pub cdn: bool,
    /// 发布模式转为 LQENBIN1 .bin 的模型（项目相对路径）
    pub bin_converted: Vec<String>,
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

/// 网页运行时代码文件（多文件按文件落盘；单页全部内联进 HTML，不进归档/内联数据
/// 的场景/资产部分）；入口页 index.html 与多模板附加页 index-<模板目录>.html 都算运行时代码。
/// src/ 前缀 = 编辑器编译后的用户脚本模块（src/**.js，前端随 files 传入；
/// 相对 import 由 rewrite_module_imports 重写，与 engine 模块同一套加载机制）
fn is_runtime_code(rel: &str) -> bool {
    rel == "player.mjs"
        || (rel.starts_with("engine/") && !is_runtime_support_data(rel))
        || rel.starts_with("src/")
        || is_entry_page(rel)
}

/// 运行时支撑数据（Draco JS 解码器等按文件名被加载器 fetch 的 engine/ 下非模块
/// 文件）：不算运行时代码（单页/gzip 模式进资产表经 fetch 拦截供数据，而非内联成
/// blob 模块——解码器无 export、内联后无法按文件名取回），也不参与发布模式 uid
/// 改名（DRACOLoader 按固定文件名 decoderPath + "draco_decoder.js" 拉取）。
fn is_runtime_support_data(rel: &str) -> bool {
    rel.starts_with("engine/runtime/loaders/draco/")
        || rel.starts_with("engine/runtime/loaders/basis/")
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

/// uid 新相对路径：保留目录，替换扩展名（发布模式模型统一 .bin）
fn uid_rel_ext(rel: &str, uid: &str, ext: &str) -> String {
    let dir = match rel.rfind('/') {
        Some(i) => &rel[..=i],
        None => "",
    };
    if ext.is_empty() {
        return format!("{dir}{uid}");
    }
    format!("{dir}{uid}.{ext}")
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

/// 递归重写 JSON 里 meshNode 的 material/model、skyboxNode 的 cubeMap、组件 animationClip 的 clip、
/// 音源的 audio.source、粒子系统的 particles.texture、UI Widget（图片/按钮）的 image 资产引用
fn rewrite_scene_refs(v: &mut serde_json::Value, renames: &HashMap<String, String>) {
    match v {
        serde_json::Value::Array(items) => {
            for i in items {
                rewrite_scene_refs(i, renames);
            }
        }
        serde_json::Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                if (k == "material" || k == "model" || k == "cubeMap" || k == "clip") && val.is_string() {
                    if let Some(new) = renames.get(val.as_str().unwrap_or("")) {
                        *val = serde_json::Value::String(new.clone());
                    }
                } else if k == "audio" {
                    // 音源节点：audio.source 为音频资产引用（其余播放参数不含路径）
                    if let Some(src) = val.get_mut("source") {
                        if src.is_string() {
                            if let Some(new) = renames.get(src.as_str().unwrap_or("")) {
                                *src = serde_json::Value::String(new.clone());
                            }
                        }
                    }
                } else if k == "particles" {
                    // 粒子系统节点：particles.texture 为图片资产引用（其余发射参数不含路径）
                    if let Some(tex) = val.get_mut("texture") {
                        if tex.is_string() {
                            if let Some(new) = renames.get(tex.as_str().unwrap_or("")) {
                                *tex = serde_json::Value::String(new.clone());
                            }
                        }
                    }
                } else if k == "image" && val.is_string() {
                    // UI Widget（uiImageNode/uiButtonNode）：image 为图片资产引用
                    if let Some(new) = renames.get(val.as_str().unwrap_or("")) {
                        *val = serde_json::Value::String(new.clone());
                    }
                } else if k == "materialSettings" {
                    // 地形节点：materialSettings.splatmap + layers[].albedoMap/normalMap
                    if let Some(ms) = val.as_object_mut() {
                        if let Some(new) = ms.get("splatmap").and_then(|v| v.as_str()).and_then(|s| renames.get(s)) {
                            *ms.get_mut("splatmap").unwrap() = serde_json::Value::String(new.clone());
                        }
                        if let Some(layers) = ms.get_mut("layers").and_then(|v| v.as_array_mut()) {
                            for l in layers.iter_mut() {
                                if let Some(lo) = l.as_object_mut() {
                                    for field in ["albedoMap", "normalMap"] {
                                        if let Some(new) = lo.get(field).and_then(|v| v.as_str()).and_then(|s| renames.get(s)) {
                                            *lo.get_mut(field).unwrap() = serde_json::Value::String(new.clone());
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else {
                    rewrite_scene_refs(val, renames);
                }
            }
        }
        _ => {}
    }
}

/// 重写 .texcube JSON 里贴图引用（equirect 的 map / faces 各面）；parse 成功则同时紧凑化
fn rewrite_texcube_text(text: &str, renames: &HashMap<String, String>) -> String {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(text) else {
        return text.to_string();
    };
    let Some(obj) = v.as_object_mut() else {
        return text.to_string();
    };
    let rewrite = |val: &mut serde_json::Value| {
        if val.is_string() {
            if let Some(new) = renames.get(val.as_str().unwrap_or("")) {
                *val = serde_json::Value::String(new.clone());
            }
        }
    };
    if let Some(map) = obj.get_mut("map") {
        rewrite(map);
    }
    if let Some(faces) = obj.get_mut("faces").and_then(|f| f.as_object_mut()) {
        for (_, val) in faces.iter_mut() {
            rewrite(val);
        }
    }
    v.to_string()
}

/// 重写 .mat JSON 里贴图字段引用；parse 成功则同时紧凑化（发布模式 JSON 压缩）。
/// cubeMap 为天空盒材质的 TextureCube 引用，shader 为材质挂的着色器资产引用，
/// props 内着色器 Properties 的贴图参数值（字符串）一并重写，三者随重命名表同步。
fn rewrite_mat_text(text: &str, renames: &HashMap<String, String>) -> String {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(text) else {
        return text.to_string();
    };
    if let serde_json::Value::Object(map) = &mut v {
        for (k, val) in map.iter_mut() {
            if (crate::preview::TEXTURE_FIELDS.contains(&k.as_str()) || k == "cubeMap" || k == "shader")
                && val.is_string()
            {
                if let Some(new) = renames.get(val.as_str().unwrap_or("")) {
                    *val = serde_json::Value::String(new.clone());
                }
            }
            // 着色器参数：字符串值即贴图引用（颜色为数字、向量为数组，不受影响）
            if k == "props" {
                if let serde_json::Value::Object(props) = val {
                    for (_, pv) in props.iter_mut() {
                        if let Some(old) = pv.as_str() {
                            if let Some(new) = renames.get(old) {
                                *pv = serde_json::Value::String(new.clone());
                            }
                        }
                    }
                }
            }
        }
    }
    v.to_string()
}

/// 发布模式处理：模型二进制化（LQENBIN1）+ 资产 uid 重命名（.meta uuid 优先，否则
/// 路径哈希）+ 重写场景与材质引用 + 场景/材质 JSON 紧凑化。返回重命名表。
/// 场景 JSON 文件名保持不变（config.scenes 按名引用，是产物公开入口）。
fn apply_release(
    root_path: &Path,
    files: &mut HashMap<String, String>,
    binaries: &mut HashMap<String, Vec<u8>>,
    scene_texts: &mut [(String, String)],
    bin_converted: &mut Vec<String>,
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

    // 模型二进制化（LQENBIN1）：glb/gltf/obj → <uid>.bin；被内联的外部兄弟文件
    // （.gltf 的 .bin/贴图）从产物剔除（未被他处引用时）
    let mut inlined_sibs: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut model_bins: HashMap<String, Vec<u8>> = HashMap::new(); // 旧 rel → LQENBIN1 字节
    let mut model_rels: Vec<String> = binaries
        .keys()
        .filter(|k| is_model_ext(k))
        .cloned()
        .collect();
    model_rels.sort();
    for rel in &model_rels {
        if let Some((bin, inlined)) = crate::model_bin::convert_model_to_bin(rel, binaries) {
            model_bins.insert(rel.clone(), bin);
            for s in inlined {
                inlined_sibs.insert(s);
            }
        }
    }

    // 重命名表（运行时代码与入口页除外；被内联兄弟不打包；模型目标扩展名 .bin）
    // script-graph.json 按 config.scriptGraph 固定路径引用，不参与 uid 重命名
    let asset_rels: Vec<String> = files
        .keys()
        .chain(binaries.keys())
        .filter(|rel| {
            !is_runtime_code(rel)
                && !is_runtime_support_data(rel)
                && !inlined_sibs.contains(*rel)
                && rel.as_str() != "script-graph.json"
        })
        .cloned()
        .collect();
    for rel in asset_rels {
        let target_ext = if model_bins.contains_key(&rel) {
            "bin".to_string()
        } else {
            rel_ext(&rel)
        };
        let new_rel = uid_rel_ext(&rel, &uid_for(&rel), &target_ext);
        renames.insert(rel, new_rel);
    }
    bin_converted.extend(model_bins.keys().cloned());

    // 被内联兄弟：若未被他处材质文本引用则移除（不进产物）
    for s in &inlined_sibs {
        let mat_refs_it = files.values().any(|t| t.contains(s));
        if !mat_refs_it {
            binaries.remove(s);
            files.remove(s);
        }
    }

    // 键重命名 + 模型字节替换为 LQENBIN1
    for (old, new) in &renames {
        if let Some(v) = files.remove(old) {
            files.insert(new.clone(), v);
        }
        if let Some(v) = binaries.remove(old) {
            let v = model_bins.get(old).cloned().unwrap_or(v);
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
        } else if rel.ends_with(".texcube") {
            *text = rewrite_texcube_text(text, &renames);
        }
    }

    renames
}

fn is_model_ext(rel: &str) -> bool {
    matches!(
        rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str(),
        "glb" | "gltf" | "obj"
    )
}

fn rel_ext(rel: &str) -> String {
    let file = rel.rsplit('/').next().unwrap_or(rel);
    match file.rfind('.') {
        Some(_) => file.rsplit('.').next().unwrap_or("").to_ascii_lowercase(),
        None => String::new(),
    }
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

/// 单页模式的内联数据脚本：注入 index.html，运行时经 window.__TVE_BUILD_DATA 读取。
/// 非 gzip 时 code 为运行时代码文本表（player.mjs + engine/**，已重写说明符），
/// gzip 时代码并入 entries 归档。序列化后把 '<' 转义为 \u003c，
/// 防止代码文本里的 `</script>` 提前终止内联脚本标签（\u 转义解码后语义不变）
fn inline_data_script(
    config: serde_json::Map<String, serde_json::Value>,
    entries: &[(String, Vec<u8>)],
    gzip: bool,
    code: Option<&HashMap<String, String>>,
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
        if let Some(code) = code {
            let map: serde_json::Map<String, serde_json::Value> = code
                .iter()
                .map(|(rel, text)| (rel.clone(), serde_json::Value::String(text.clone())))
                .collect();
            data.insert("code".to_string(), serde_json::Value::Object(map));
        }
    }
    let json = serde_json::Value::Object(data).to_string().replace('<', "\\u003c");
    Ok(format!(
        "<script>window.__TVE_BUILD_DATA = {json};</script>"
    ))
}

/// 单页引导脚本：从内联数据取运行时代码（非 gzip 的 code 字段，或 gzip 归档里的
/// player.mjs/engine/** 条目），为每个模块生成 Blob URL 并注入 import map
/// （tve:<相对路径> → blob:），最后动态 import 入口 player.mjs。
/// 必须放在内联数据脚本之后、且页面没有任何模块脚本加载之前执行
const SINGLE_PAGE_BOOTSTRAP: &str = r#"<script>
(function () {
  var data = window.__TVE_BUILD_DATA;
  if (!data) return;
  var entry = "player.mjs";
  function fail(msg) {
    console.error(msg);
    var el = document.getElementById("error");
    if (el) {
      el.textContent = "单页运行时加载失败: " + msg;
      el.classList.add("visible");
    }
  }
  function boot(code) {
    if (!Object.prototype.hasOwnProperty.call(code, entry))
      return fail("缺少入口模块 " + entry);
    var imports = {};
    for (var rel in code)
      imports["tve:" + rel] = URL.createObjectURL(
        new Blob([code[rel]], { type: "text/javascript" })
      );
    var map = document.createElement("script");
    map.type = "importmap";
    map.textContent = JSON.stringify({ imports: imports });
    document.head.appendChild(map);
    import("tve:" + entry).catch(function (e) {
      fail(e && e.message ? e.message : String(e));
    });
  }
  try {
    if (data.code) {
      boot(data.code);
    } else if (data.pak) {
      var bin = atob(data.pak), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      new Response(
        new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))
      )
        .arrayBuffer()
        .then(function (buf) {
          var view = new DataView(buf), off = 0, dec = new TextDecoder();
          var count = view.getUint32(off, true); off += 4;
          var code = {};
          while (count-- > 0) {
            var pl = view.getUint32(off, true); off += 4;
            var path = dec.decode(new Uint8Array(buf, off, pl)); off += pl;
            var dl = view.getUint32(off, true); off += 4;
            if (
              path === entry ||
              path.lastIndexOf("engine/", 0) === 0 ||
              path.lastIndexOf("src/", 0) === 0
            )
              code[path] = dec.decode(new Uint8Array(buf, off, dl));
            off += dl;
          }
          boot(code);
        })
        .catch(function (e) { fail(String(e)); });
    }
  } catch (e) { fail(String(e)); }
})();
</script>"#;

/// 构建导出：打包选中场景 + 引用资产 + 网页运行时到 `<项目>/build/web/`。
/// files 为前端 fetch 传入的网页运行时文本（index.html/player.mjs/engine/**，
/// 属 WebView 打包资源，编辑器离线可用）；场景与资产由 Rust 直读磁盘。
#[tauri::command]
pub async fn build_export(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::task::TaskManager>,
    root: String,
    channel: String,
    scenes: Vec<String>,
    main_scene: String,
    title: String,
    debug: bool,
    single_page: bool,
    gzip: bool,
    release: bool,
    cdn: bool,
    gzip_base: String,
    cdn_base: String,
    files: HashMap<String, String>,
) -> Result<BuildResult, String> {
    // 注册到任务管理器：支持取消 + 进度广播 + 多项目隔离
    let handle = state.register(&app, "export", Some(&root), crate::task::Priority::Normal);
    let cancel_id = handle.id.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let cancel_check = || handle.is_cancelled();
        let result = build_export_impl(
            root,
            channel,
            scenes,
            main_scene,
            title,
            debug,
            single_page,
            gzip,
            release,
            cdn,
            gzip_base,
            cdn_base,
            files,
            Some(&cancel_check),
            Some(&|p, m| handle.report_progress(p, m)),
        );
        // 完成/失败事件统一经 TaskHandle 广播（与 task:progress 同一封装）
        match &result {
            Ok(r) => handle.report_completed(true, &format!("导出完成: {}", r.output_dir)),
            Err(e) => handle.report_completed(false, e),
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?;

    state.deregister(&cancel_id);
    result
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

/// 单页内联模块的裸说明符前缀：相对 import 重写为 `tve:<产物内路径>`，
/// 由引导脚本注入的 import map 映射到 Blob URL
const INLINE_MODULE_PREFIX: &str = "tve:";

/// 多文件产物附带的零依赖静态服务器脚本（node server.mjs [端口]）。
/// 引导用户走 HTTP 而非 file://（fetch/Worker 在 file:// 下受限）。
const SERVER_MJS: &str = r#"import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2]) || 8080;
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const MIME = {
  ".html":"text/html;charset=utf-8",".js":"text/javascript",".mjs":"text/javascript",
  ".css":"text/css",".json":"application/json",".png":"image/png",".jpg":"image/jpeg",
  ".jpeg":"image/jpeg",".webp":"image/webp",".gif":"image/gif",".svg":"image/svg+xml",
  ".glb":"model/gltf-binary",".gltf":"model/gltf+json",".wasm":"application/wasm",
  ".bin":"application/octet-stream",".mp3":"audio/mpeg",".wav":"audio/wav",
  ".ogg":"audio/ogg",".shader":"text/plain",".mat":"application/json",".anim":"application/json",
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let p = decodeURIComponent(url.pathname);
    if (p === "/") p = "/index.html";
    const safe = normalize(join(ROOT, p));
    if (!safe.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
    const s = await stat(safe).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404); res.end("Not Found"); return; }
    const data = await readFile(safe);
    const mime = MIME[extname(safe).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Content-Length": data.length });
    res.end(data);
  } catch (e) { res.writeHead(500); res.end(String(e?.message ?? e)); }
});
server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`静态服务器已启动: ${url}\n按 Ctrl+C 停止`);
  import("node:child_process").then(({ exec }) => {
    const cmd = process.platform === "win32" ? `start ${url}` : process.platform === "darwin" ? `open ${url}` : `xdg-open ${url}`;
    exec(cmd);
  });
});
"#;

fn is_js_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

/// 解析相对说明符（./a、../a）为产物内相对路径；带 ?query/#hash 后缀原样保留。
/// 返回 (产物内相对路径, 后缀)。
fn resolve_relative_spec(dir: &str, spec: &str) -> Option<(String, String)> {
    if !spec.starts_with("./") && !spec.starts_with("../") {
        return None;
    }
    let (path, suffix) = match spec.find(['?', '#']) {
        Some(i) => (&spec[..i], spec[i..].to_string()),
        None => (spec, String::new()),
    };
    let mut segs: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    for part in path.split('/') {
        match part {
            "." | "" => {}
            ".." => {
                segs.pop();
            }
            p => segs.push(p),
        }
    }
    Some((segs.join("/"), suffix))
}

/// 单行引号字符串读取：返回 (字符串内容, 结束引号后的字节偏移)；
/// 起始偏移须指向引号，支持反斜杠转义
fn read_quoted(text: &str, start: usize) -> Option<(&str, usize)> {
    let b = text.as_bytes();
    let quote = *b.get(start)?;
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    let mut k = start + 1;
    while k < b.len() {
        if b[k] == b'\\' {
            k += 2;
            continue;
        }
        if b[k] == quote {
            return Some((&text[start + 1..k], k + 1));
        }
        k += 1;
    }
    None
}

/// 重写一段模块文本：import/export from 的相对说明符与 import("./x") 动态导入，
/// 解析（相对本模块目录）到 remap 表内的产物相对路径时替换为其映射的说明符
/// （单页内联模块 → `tve:<路径>` 裸说明符；CDN 模式的 three → 绝对 URL），
/// 其余原样保留
fn rewrite_specifier_text(
    text: &str,
    dir: &str,
    remap: &HashMap<String, String>,
) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len() + 32);
    let mut i = 0;
    while i < b.len() {
        // 关键字起点（词边界）：import / from
        let kw = if is_js_word(b[i]) && (i == 0 || !is_js_word(b[i - 1])) {
            if text[i..].starts_with("import") && (i + 6 >= b.len() || !is_js_word(b[i + 6])) {
                Some((i, 6, true))
            } else if text[i..].starts_with("from") && (i + 4 >= b.len() || !is_js_word(b[i + 4])) {
                Some((i, 4, false))
            } else {
                None
            }
        } else {
            None
        };
        let Some((kw_at, kw_len, is_import)) = kw else {
            let ch = text[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        };

        // 关键字后跳过空白，定位字符串字面量（静态 from/import 后直接字符串；
        // 动态 import 后还有一层括号）
        let mut j = kw_at + kw_len;
        let skip_ws = |j: &mut usize, b: &[u8]| {
            while *j < b.len() && (b[*j] as char).is_ascii_whitespace() {
                *j += 1;
            }
        };
        skip_ws(&mut j, b);
        if is_import && j < b.len() && b[j] == b'(' {
            j += 1;
            skip_ws(&mut j, b);
        }
        if let Some((spec, after)) = read_quoted(text, j) {
            if let Some((rel, suffix)) = resolve_relative_spec(dir, spec) {
                if let Some(to) = remap.get(&rel) {
                    out.push_str(&text[i..j]);
                    out.push_str(&text[j..=j]);
                    out.push_str(to);
                    out.push_str(&suffix);
                    out.push(text.as_bytes()[j] as char);
                    i = after;
                    continue;
                }
            }
        }

        // 未命中：整段关键字原样复制，从关键字后继续扫描
        out.push_str(&text[i..j.min(b.len())]);
        i = j;
    }
    out
}

/// 单页模式：把运行时代码里的相对 import/export 说明符重写为 `tve:<相对路径>`
/// 裸说明符（运行时由引导脚本的 import map 映射到 Blob URL 加载）；
/// extra_remap 为代码表之外的补充映射（CDN 模式的 three 运行时 → 绝对 URL，
/// blob 模块无法解析相对 import，须一并改写）
fn rewrite_module_imports(
    code: &mut HashMap<String, String>,
    extra_remap: &HashMap<String, String>,
) {
    let mut remap: HashMap<String, String> = code
        .keys()
        .map(|rel| (rel.clone(), format!("{INLINE_MODULE_PREFIX}{rel}")))
        .collect();
    for (k, v) in extra_remap {
        remap.insert(k.clone(), v.clone());
    }
    let rels: Vec<String> = code.keys().cloned().collect();
    for rel in rels {
        let dir = match rel.rfind('/') {
            Some(i) => &rel[..=i],
            None => "",
        };
        let text = code.get_mut(&rel).unwrap();
        *text = rewrite_specifier_text(text, dir, &remap);
    }
}

/// Three CDN 说明符映射表：产物内 three 相对路径 → CDN 绝对 URL（两种产物形态共用）
fn three_cdn_remap(three_base: &str) -> HashMap<String, String> {
    THREE_RUNTIME_FILES
        .iter()
        .map(|rel| (rel.to_string(), three_cdn_url(three_base, rel)))
        .collect()
}

/// 移除入口页里引用 player.mjs 的 <script> 标签（单页模式代码已内联，原标签会 404）
fn strip_player_script_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(start) = rest.find("<script") {
        let tail = &rest[start..];
        let Some(end) = tail.find("</script") else {
            break;
        };
        let seg_end = start + end + "</script".len();
        if !tail[..end].contains("player.mjs") {
            result.push_str(&rest[..seg_end]);
        }
        rest = &rest[seg_end..];
    }
    result.push_str(rest);
    result
}

/// 运行时脚本里指向 three 的相对 import 重写为 CDN 绝对 URL（import map 拦截不了
/// 相对说明符，必须改写模块文本）。覆盖 player.mjs 与 engine/ 下全部 .js/.mjs
/// （loaders 的 ../../three、runtime 模块的 ../core/three、player 的 ../engine/core/three 统一经
/// 目录相对解析命中映射）；入口页与非脚本文件不动
fn rewrite_runtime_three_imports(files: &mut HashMap<String, String>, remap: &HashMap<String, String>) {
    let rels: Vec<String> = files
        .keys()
        .filter(|rel| {
            is_runtime_code(rel)
                && !is_entry_page(rel)
                && (rel.ends_with(".js") || rel.ends_with(".mjs"))
        })
        .cloned()
        .collect();
    for rel in rels {
        let dir = match rel.rfind('/') {
            Some(i) => &rel[..=i],
            None => "",
        };
        let text = files.get_mut(&rel).unwrap();
        *text = rewrite_specifier_text(text, dir, remap);
    }
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
    cdn: bool,
    gzip_base: String,
    three_base: String,
    files: HashMap<String, String>,
    is_cancelled: Option<&dyn Fn() -> bool>,
    report_progress: Option<&dyn Fn(f64, &str)>,
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
    if let Some(check) = is_cancelled {
        if check() {
            return Err("任务已取消".into());
        }
    }
    if let Some(rp) = report_progress {
        rp(0.05, &format!("准备导出 {} 个场景", scenes.len()));
    }
    // 两个地址相互独立、各自归一化（去空白与结尾 '/'，无协议补 https://）：
    // - gzip_base：gzip 归档远程基址（非空时写入 config 供运行时远程拉取）；
    // - three_base：Three CDN 基址，仅在 CDN 模式开启时生效（three.js 不内嵌）；
    // 留空均回退当前行为（归档本地读取 / three 内嵌）。拼接相对路径时经
    // join_cdn_url 去重已带的前缀（如地址以 /engine、/assets.gzip 结尾不重复拼）
    let gzip_base = normalize_base_url(&gzip_base);
    let three_base = normalize_base_url(&three_base);
    let cdn_active = cdn && !three_base.is_empty();

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
    // CDN 模式：three.js 运行时不内嵌，代码里指向 three 的相对 import 在产物
    // 组装阶段统一重写为 CDN 绝对 URL；其余 engine/ 模块仍内嵌
    if cdn_active {
        for rel in THREE_RUNTIME_FILES {
            files.remove(rel);
        }
    }
    let mut binaries: HashMap<String, Vec<u8>> = HashMap::new();

    // 逐场景：并行读盘 + 收集引用资产 → 合并去重（跨场景共用同一资产只读一次）
    let mut packed: Vec<PackedScene> = Vec::new();
    let mut used_names: Vec<String> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let mut scene_texts: Vec<(String, String)> = Vec::new();

    use rayon::prelude::*;
    let scene_results: Vec<(String, String, HashMap<String, String>, HashMap<String, Vec<u8>>, Vec<String>)> = scenes
        .par_iter()
        .map(|rel| {
            let text = crate::project::resolve_in_root(&root_path, rel)
                .and_then(|p| fs::read_to_string(&p).map_err(|e| e.to_string()))
                .map_err(|e| format!("读取场景失败 '{rel}': {e}"))?;
            let mut sf: HashMap<String, String> = HashMap::new();
            let mut sb: HashMap<String, Vec<u8>> = HashMap::new();
            let sm = crate::preview::collect_scene_assets(&root_path, &text, &mut sf, &mut sb);
            Ok::<_, String>((rel.clone(), text, sf, sb, sm))
        })
        .collect::<Result<Vec<_>, String>>()?;

    // 合并各场景独立收集结果到全局 map（去重：已存在不覆盖，保留首次读入）
    for (_, _, sf, sb, sm) in &scene_results {
        for (k, v) in sf {
            files.entry(k.clone()).or_insert_with(|| v.clone());
        }
        for (k, v) in sb {
            binaries.entry(k.clone()).or_insert_with(|| v.clone());
        }
        missing.extend(sm.iter().cloned());
    }
    // 场景名去重需串行累积 used_names
    for (rel, text, _, _, _) in scene_results {
        let name = scene_entry_name(&rel, &mut used_names);
        scene_texts.push((format!("scenes/{name}.json"), text));
        packed.push(PackedScene {
            name,
            rel,
            file: String::new(),
        });
    }
    for (i, (file, _)) in scene_texts.iter().enumerate() {
        packed[i].file = file.clone();
    }

    if let Some(check) = is_cancelled {
        if check() {
            return Err("任务已取消".into());
        }
    }
    if let Some(rp) = report_progress {
        rp(0.3, "场景资产收集完成");
    }

    // 发布模式：模型二进制化（LQENBIN1）+ 资源 uid 重命名 + 场景/材质引用重写 + JSON 压缩
    let mut bin_converted: Vec<String> = Vec::new();
    if release {
        apply_release(
            &root_path,
            &mut files,
            &mut binaries,
            &mut scene_texts,
            &mut bin_converted,
        );
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
    // 场景图注入：前端在 files 中放入 script-graph.json 时，config 标记启用
    // （player 检测到 cfg.scriptGraph 即装配图行为解释器）
    if files.contains_key("script-graph.json") {
        cfg.insert(
            "scriptGraph".to_string(),
            serde_json::Value::String("./script-graph.json".to_string()),
        );
    }
    // gzip 资源地址（gzip 归档远程基址；空 = 本地 assets.gzip）
    if !gzip_base.is_empty() {
        cfg.insert("gzipBase".to_string(), serde_json::Value::String(gzip_base));
    }

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

    // 发布模式：压缩运行时脚本（player / engine 模块 / 加载器；已压缩的 *.min.* 跳过）
    // CPU 密集，用 rayon 并行压缩各文件
    if release {
        use rayon::prelude::*;
        files.par_iter_mut().for_each(|(rel, text)| {
            if is_minifiable_script(rel) {
                *text = minify_js_source(text);
            }
        });
    }

    if let Some(rp) = report_progress {
        rp(0.6, "产物组装中");
    }
    // 产物组装
    let mut code_n = 0usize;
    if single_page {
        // 单页：运行时代码（player.mjs + engine/**）全部内联进入口页——重写相对 import
        // 说明符为 tve: 裸说明符；非 gzip 放数据 code 字段，gzip 并入归档；运行时由
        // 引导脚本生成 Blob URL + import map 动态加载 player.mjs。产物仅剩 HTML。
        let mut pages: HashMap<String, String> = HashMap::new();
        let mut code: HashMap<String, String> = HashMap::new();
        for (rel, text) in files.drain() {
            if is_entry_page(&rel) {
                pages.insert(rel, text);
            } else {
                code.insert(rel, text);
            }
        }
        // 说明符重写：代码表内 → tve: 裸说明符（blob 模块解析不了相对 import）；
        // CDN 模式下 three 不在代码表，其相对说明符直接重写为 CDN 绝对 URL
        let cdn_remap = three_cdn_remap(&three_base);
        let empty_remap: HashMap<String, String> = HashMap::new();
        rewrite_module_imports(&mut code, if cdn_active { &cdn_remap } else { &empty_remap });
        code_n = code.len();
        let script = if gzip {
            for (rel, text) in &code {
                entries.push((rel.clone(), text.clone().into_bytes()));
            }
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            inline_data_script(cfg, &entries, true, None)?
        } else {
            inline_data_script(cfg, &entries, false, Some(&code))?
        };
        // 数据脚本 + 引导脚本注入全部入口页（模板可用 {{BUILD_DATA}} 占位指定注入
        // 位置，无占位符时回退注入 </body> 前；config 不落盘）
        let inject = format!("{script}\n{SINGLE_PAGE_BOOTSTRAP}");
        for html in pages.values_mut() {
            let clean = strip_player_script_tags(html);
            *html = if clean.contains("{{BUILD_DATA}}") {
                clean.replacen("{{BUILD_DATA}}", &inject, 1)
            } else if clean.contains("</body>") {
                clean.replacen("</body>", &format!("{inject}\n</body>"), 1)
            } else {
                format!("{clean}\n{inject}")
            };
        }
        files = pages;
    } else {
        files.insert(
            "config.json".to_string(),
            serde_json::Value::Object(cfg).to_string(),
        );
        // 多文件模式附带零依赖静态服务器（node server.mjs [端口]），
        // 引导用户走 HTTP 而非 file://（fetch/Worker 在 file:// 下受限）
        files.insert("server.mjs".to_string(), SERVER_MJS.to_string());
        files.insert(
            "README.txt".to_string(),
            "网页预览产物\n\n运行方式（推荐）：\n  node server.mjs        # 启动本地 HTTP 服务器（默认 8080 端口）\n  node server.mjs 3000   # 指定端口\n\n然后浏览器访问 http://localhost:8080\n\n注意：请勿直接双击 index.html 打开（file:// 协议下\nfetch/Worker 受限，物理和动画将回退主线程，性能下降）。\n".to_string(),
        );
        if gzip {
            // 多文件 gzip：场景/资产在 assets.gzip 归档中，运行时经 fetch 拦截读取
            let pak = build_archive_bytes(&entries)?;
            binaries.insert("assets.gzip".to_string(), pak);
        }
        // Three CDN 模式：把运行时脚本里解析到同源 three 的相对 import 直接重写为
        // CDN 绝对 URL（three 内部对 three.core 的相对 import 随远端模块自身 URL 解析）
        if cdn_active {
            rewrite_runtime_three_imports(&mut files, &three_cdn_remap(&three_base));
        }
    }

    if let Some(rp) = report_progress {
        rp(0.9, "写入产物");
    }
    // 清空重建输出目录并写入全部产物
    crate::preview::write_export_dir(&out, files, &binaries)
        .map_err(|e| format!("写入构建产物失败: {e}"))?;

    let assets_packed = if single_page || gzip {
        // 单页 + gzip 时归档里含运行时代码条目，不计入资产数
        entries.len() - if single_page && gzip { code_n } else { 0 }
    } else {
        binaries.len() + packed.len()
    };
    let output_dir = out.display().to_string();
    let missing_n = missing.len();
    let bin_n = bin_converted.len();
    let mut message = String::from("构建完成");
    if bin_n > 0 {
        message.push_str(&format!("，模型→.bin {bin_n} 个"));
    }
    if missing_n > 0 {
        message.push_str(&format!("（{} 项缺失资产被跳过）", missing_n));
    }
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
        cdn: cdn_active,
        bin_converted,
        assets_packed,
        missing: missing.clone(),
        message,
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
        assert!(is_runtime_code("engine/core/three.module.min.js"));
        assert!(is_runtime_code("src/main.js"), "用户脚本编译产物按运行时代码处理");
        assert!(!is_runtime_code("assets/materials/Default.mat"));
        assert!(!is_runtime_code("scenes/Main.json"));
        assert!(!is_runtime_code("config.json"));
        assert!(!is_runtime_code("index.json"));
    }

    /// 端到端：搭一个最小临时项目（场景 + 材质 + 依赖 engine 的运行时），跑
    /// 单页/多文件 × gzip 全部形态，校验产物内容：
    /// - 单页：产物只剩入口 HTML，运行时代码全部内联（code 字段或 gzip 归档），
    ///   相对 import 重写为 tve: 裸说明符，模板里的 player.mjs 脚本标签被剥离；
    /// - 多文件：场景/资产按相对路径落盘（gzip 时写 assets.gzip）。
    #[test]
    fn build_export_end_to_end_all_modes() {
        let base = std::env::temp_dir().join(format!("tve-build-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("proj");
        fs::create_dir_all(root.join("assets/materials")).unwrap();
        fs::create_dir_all(root.join("assets/textures")).unwrap();
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
        fs::write(root.join("assets/textures/a.png"), [1u8, 2, 3, 4]).unwrap();
        fs::write(
            root.join("assets/Main.scene"),
            r#"{"type":"scene","root":{"type":"node","childIds":[],"children":[{"type":"meshNode","source":"primitive","material":"assets/materials/M.mat"}]}}"#,
        )
        .unwrap();

        let runtime_files = |entry: &str| {
            HashMap::from([
                (
                    "index.html".to_string(),
                    format!(
                        "<html><title>t</title><body>{entry}<script type=\"module\" src=\"./player.mjs\"></script></body></html>"
                    ),
                ),
                ("player.mjs".to_string(), "// player\nimport { b } from \"./engine/b.mjs\";\nconsole.log(b);\n".to_string()),
                ("engine/b.mjs".to_string(), "export const b = 2;\n".to_string()),
                ("engine/core/tve.mjs".to_string(), "export const engine = {};\n".to_string()),
                // 用户脚本编译产物（src/**.js）：编辑器编译时把 "tve" 裸导入
                // 重写为相对 engine/core/tve.mjs 的路径，此处模拟该形态
                (
                    "src/main.js".to_string(),
                    "import { engine } from \"../engine/core/tve.mjs\";\nengine.log(\"hi\");\n".to_string(),
                ),
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
                false,
                String::new(),
                String::new(),
                runtime_files(entry),
                None,
                None,
            )
            .unwrap_or_else(|e| panic!("single_page={single_page} gzip={gzip} 构建失败: {e}"));

            let out = root.join("build/web");
            if single_page {
                // 单页：产物只剩一个入口 HTML
                let written: Vec<String> = fs::read_dir(&out)
                    .unwrap()
                    .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect();
                assert_eq!(written, vec!["index.html".to_string()], "单页产物只有 index.html");
                let html = fs::read_to_string(out.join("index.html")).unwrap();
                assert!(html.contains("__TVE_BUILD_DATA"), "单页入口页应内联数据");
                assert!(html.contains("importmap"), "单页入口页应带 Blob/importmap 引导脚本");
                assert!(html.contains("import(\"tve:\" + entry)"), "引导脚本应动态 import 入口模块");
                assert!(!html.contains("src=\"./player.mjs\""), "模板里的 player.mjs 脚本标签应被剥离");
                assert!(!out.join("scenes").exists(), "单页模式不落盘场景文件");
                assert!(!out.join("config.json").exists(), "单页模式不落盘 config.json");
                if gzip {
                    // 代码在 gzip 归档（base64）里，正文不出现代码原文
                    assert!(!html.contains("export const b = 2"), "gzip 单页代码应进归档而非明文");
                    assert!(!html.contains("tve:engine/runtime/b.mjs"), "gzip 单页重写后的代码在归档里");
                    // 引导脚本从归档提取代码时应包含用户脚本（src/ 前缀）
                    assert!(
                        html.contains("path.lastIndexOf(\"src/\", 0) === 0"),
                        "gzip 单页引导脚本应把 src/ 用户脚本提取进代码表"
                    );
                } else {
                    assert!(html.contains("export const b = 2"), "非 gzip 单页代码应以文本内联");
                    assert!(html.contains("tve:engine/b.mjs"), "运行时代码相对 import 应重写为 tve: 说明符");
                    assert!(
                        html.contains("\"src/main.js\""),
                        "用户脚本应进入内联代码表（引导脚本据此构建 import map）"
                    );
                    assert!(
                        html.contains("tve:engine/core/tve.mjs"),
                        "用户脚本的 tve 导入应重写为 tve:engine/core/tve.mjs"
                    );
                }
            } else {
                assert!(out.join("player.mjs").is_file(), "多文件运行时代码按文件落盘");
                assert!(out.join("engine/b.mjs").is_file());
                assert!(out.join("src/main.js").is_file(), "用户脚本按文件落盘");
                assert!(out.join("config.json").is_file());
                let html = fs::read_to_string(out.join("index.html")).unwrap();
                assert!(html.contains("src=\"./player.mjs\""), "多文件保留模板脚本标签");
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

    /// 单页说明符重写：相对路径解析（./ ../）、引号/空白变体、未知目标不重写
    #[test]
    fn single_page_rewrites_module_imports() {
        use super::{rewrite_module_imports, rewrite_specifier_text};
        let remap = HashMap::from([
            ("player.mjs".to_string(), "tve:player.mjs".to_string()),
            ("engine/utils.mjs".to_string(), "tve:engine/utils.mjs".to_string()),
            (
                "engine/loaders/GLTFLoader.js".to_string(),
                "tve:engine/loaders/GLTFLoader.js".to_string(),
            ),
        ]);
        // 相对解析：engine/model.mjs 目录下的 ./x 与 ../x
        assert_eq!(
            rewrite_specifier_text(
                "import { a } from \"./utils.mjs\";\nimport * as G from './loaders/GLTFLoader.js';\nimport(\"./utils.mjs\")\n",
                "engine/",
                &remap
            ),
            "import { a } from \"tve:engine/utils.mjs\";\nimport * as G from 'tve:engine/loaders/GLTFLoader.js';\nimport(\"tve:engine/utils.mjs\")\n"
        );
        // ../ 上溯：engine/ 下的 ../loaders 解析到根目录（不在映射表，不重写）
        assert_eq!(
            rewrite_specifier_text("import '../loaders/GLTFLoader.js';", "engine/", &remap),
            "import '../loaders/GLTFLoader.js';"
        );
        // 压缩形态：from"./x" 无空白
        assert_eq!(
            rewrite_specifier_text("import{a}from\"./utils.mjs\";", "engine/", &remap),
            "import{a}from\"tve:engine/utils.mjs\";"
        );
        // 未知目标 / 裸说明符 / import.meta / 词内匹配不重写
        assert_eq!(
            rewrite_specifier_text(
                "import \"./missing.mjs\";\nimport * as T from \"three\";\nlet x = import.meta.url;\nperformance.from(\"./utils.mjs\");\n",
                "engine/",
                &remap
            ),
            "import \"./missing.mjs\";\nimport * as T from \"three\";\nlet x = import.meta.url;\nperformance.from(\"./utils.mjs\");\n"
        );
        // 端到端：player 相对 import 重写为 tve:；extra_remap（CDN three）直接替换为 URL
        let mut code = HashMap::from([
            (
                "player.mjs".to_string(),
                "import { b } from \"./engine/utils.mjs\";\nimport * as T from \"./engine/core/three.module.min.js\";\n".to_string(),
            ),
            ("engine/utils.mjs".to_string(), "export const b = 1;\n".to_string()),
        ]);
        let extra = HashMap::from([(
            "engine/core/three.module.min.js".to_string(),
            "https://c.com/three.js/0.185.1/three.module.min.js".to_string(),
        )]);
        rewrite_module_imports(&mut code, &extra);
        assert!(code["player.mjs"].contains("\"tve:engine/utils.mjs\""));
        assert!(
            code["player.mjs"]
                .contains("\"https://c.com/three.js/0.185.1/three.module.min.js\""),
            "three 相对 import 直接重写为 CDN 绝对 URL"
        );
    }

    /// 发布模式：资产 uid 重命名（.meta uuid 优先/哈希回退）、场景与材质引用重写、
    /// JSON 紧凑化、模型二进制化（LQENBIN1，.gltf 外部兄弟内联剔除）。
    #[test]
    fn build_export_release_renames_and_rewrites() {
        let base = std::env::temp_dir().join(format!("tve-build-rel-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("proj");
        fs::create_dir_all(root.join("assets/materials")).unwrap();
        fs::create_dir_all(root.join("assets/textures")).unwrap();
        fs::create_dir_all(root.join("assets/models")).unwrap();

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

        // 模型：glb（kind1 包装）/ gltf（外部 .bin+贴图内联）/ obj（kind0 网格）
        fs::write(root.join("assets/models/cube.glb"), b"glTFfake-glb-bytes").unwrap();
        fs::write(
            root.join("assets/models/tree.gltf"),
            r#"{"asset":{"version":"2.0"},"buffers":[{"uri":"tree.bin","byteLength":4}],"bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":4}],"images":[{"uri":"tree.png"}]}"#,
        ).unwrap();
        fs::write(root.join("assets/models/tree.gltf.meta"), r#"{"uuid":"99999999-8888-7777-6666-555555555555"}"#).unwrap();
        fs::write(root.join("assets/models/tree.bin"), [1u8, 2, 3, 4]).unwrap();
        fs::write(root.join("assets/models/tree.png"), [7u8; 4]).unwrap();
        fs::write(root.join("assets/models/rock.obj"), "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n").unwrap();
        // 粒子系统节点引用的贴图（不经材质，直接在 particles.texture 上）
        fs::write(root.join("assets/textures/spark.png"), [5u8; 6]).unwrap();

        let scene = r#"{
  "type": "scene",
  "root": {
    "type": "node",
    "children": [
      { "type": "meshNode", "source": "primitive", "material": "assets/materials/M.mat" },
      { "type": "meshNode", "source": "model", "model": "assets/models/tree.gltf", "material": "assets/materials/M.mat" },
      { "type": "meshNode", "source": "model", "model": "assets/models/cube.glb" },
      { "type": "meshNode", "source": "model", "model": "assets/models/rock.obj" },
      { "type": "particleSystemNode", "particles": { "emissionRate": 20, "texture": "assets/textures/spark.png" } }
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
                false,
                String::new(),
                String::new(),
                HashMap::from([
                    ("index.html".to_string(), "<html></html>".to_string()),
                    ("player.mjs".to_string(), "// player entry\nimport { A } from \"./engine/helper.mjs\";\nconsole.log(A);\n".to_string()),
                    (
                        "engine/helper.mjs".to_string(),
                        "// helper comment\nexport const A = 1;\n".to_string(),
                    ),
                    (
                        "engine/core/three.module.min.js".to_string(),
                        "/*already minified*/export const T = 1;".to_string(),
                    ),
                ]),
                None,
                None,
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
        assert!(out.join("assets/textures/spark.png").is_file(), "粒子贴图随导出拷贝");
        assert!(scene_text.contains("assets/textures/spark.png"), "未发布粒子贴图引用保持原名");

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
        // 粒子贴图：文件重命名 + particles.texture 引用重写
        let spark_uid = fallback_uid("assets/textures/spark.png");
        assert!(!out.join("assets/textures/spark.png").exists(), "粒子贴图原名不保留");
        assert!(out.join(format!("assets/textures/{spark_uid}.png")).is_file(), "粒子贴图重命名为哈希 uid");
        assert!(scene_text.contains(&format!("assets/textures/{spark_uid}.png")), "particles.texture 引用已重写");
        assert!(!scene_text.contains("spark.png"), "场景内不残留粒子贴图原名");

        // 脚本压缩：player/engine 脚本去注释压缩；*.min.* 跳过
        let player_min = fs::read_to_string(out.join("player.mjs")).unwrap();
        assert!(!player_min.contains("//"), "player.mjs 注释已移除");
        let helper_min = fs::read_to_string(out.join("engine/helper.mjs")).unwrap();
        assert!(!helper_min.contains("// helper"), "engine 脚本注释已移除");
        assert!(!helper_min.contains(" = 1;"), "engine 脚本空白已压缩");
        let three_min = fs::read_to_string(out.join("engine/core/three.module.min.js")).unwrap();
        assert!(three_min.contains("/*already minified*/"), "*.min.* 不重复压缩");

        // 模型二进制化：glb → kind1；gltf → 自包含 glb → kind1（兄弟文件剔除）；obj → kind0
        assert!(!out.join("assets/models/cube.glb").exists(), "glb 原名不保留");
        assert!(!out.join("assets/models/tree.gltf").exists());
        assert!(!out.join("assets/models/rock.obj").exists());
        assert!(!out.join("assets/models/tree.bin").exists(), "gltf 外部 .bin 已内联剔除");
        assert!(!out.join("assets/models/tree.png").exists(), "gltf 外部贴图已内联剔除");
        let cube_bin = fs::read(out.join("assets/models/").join(format!("{}.bin", fallback_uid("assets/models/cube.glb")))).unwrap();
        assert_eq!(&cube_bin[0..8], b"LQENBIN1");
        assert_eq!(u32::from_le_bytes(cube_bin[8..12].try_into().unwrap()), 1, "glb → kind1");
        assert_eq!(&cube_bin[16..20], b"glTF", "kind1 payload 为原始 GLB");
        let tree_bin = fs::read(out.join("assets/models/99999999-8888-7777-6666-555555555555.bin")).unwrap();
        assert_eq!(&tree_bin[0..8], b"LQENBIN1");
        assert_eq!(u32::from_le_bytes(tree_bin[8..12].try_into().unwrap()), 1, "gltf → 自包含 glb → kind1");
        assert_eq!(&tree_bin[16..20], b"glTF");
        // 内嵌 .bin 数据（[1,2,3,4]）出现在自包含 GLB 的 BIN chunk 中
        assert!(tree_bin.windows(4).any(|w| w == [1, 2, 3, 4]));
        let rock_bin = fs::read(out.join("assets/models/").join(format!("{}.bin", fallback_uid("assets/models/rock.obj")))).unwrap();
        assert_eq!(u32::from_le_bytes(rock_bin[8..12].try_into().unwrap()), 0, "obj → kind0 网格");
        assert_eq!(u32::from_le_bytes(rock_bin[24..28].try_into().unwrap()), 1, "1 个三角面");
        // 场景引用重写为 .bin 路径
        assert!(scene_text.contains(&format!("assets/models/{}.bin", fallback_uid("assets/models/cube.glb"))));
        assert!(scene_text.contains("assets/models/99999999-8888-7777-6666-555555555555.bin"));
        assert!(!scene_text.contains("tree.gltf") && !scene_text.contains("rock.obj"));
        assert_eq!(result.bin_converted.len(), 3, "三个模型均转换");
        let _ = fs::remove_dir_all(&base);
    }

    /// CDN 模式与 gzip 资源地址相互独立：
    /// - Three CDN 地址（CDN 模式开启且非空）：three.js 不内嵌——多文件从产物剔除并在
    ///   入口页注入 import map，单页不内联代码且经 cdnImports 映射到 CDN 地址；
    /// - gzip 资源地址（非空，与 CDN 模式无关）：写入 config 的 gzipBase 供运行时
    ///   远程拉取归档，three 是否内嵌不受影响；
    /// - 地址留空各自回退当前行为（three 内嵌 / 归档本地读取）。
    #[test]
    fn build_export_cdn_mode() {
        let base = std::env::temp_dir().join(format!("tve-build-cdn-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("proj");
        fs::create_dir_all(root.join("assets/textures")).unwrap();
        fs::write(root.join("assets/textures/a.png"), [1u8, 2, 3, 4]).unwrap();
        fs::write(
            root.join("assets/Main.scene"),
            r#"{"type":"scene","root":{"type":"node","children":[]}}"#,
        )
        .unwrap();

        let runtime_files = |single: bool| {
            let entry = if single { "{{BUILD_DATA}}" } else { "" };
            HashMap::from([
                (
                    "index.html".to_string(),
                    format!("<html><head></head><body>{entry}<script type=\"module\" src=\"./player.mjs\"></script></body></html>"),
                ),
                ("player.mjs".to_string(), "import * as T from \"./engine/core/three.module.min.js\";\nimport { b } from \"./engine/b.mjs\";\nconsole.log(T, b);\n".to_string()),
                ("engine/b.mjs".to_string(), "import * as T from \"./core/three.module.min.js\";
export const b = T ? 2 : 0;
".to_string()),
                ("engine/core/three.module.min.js".to_string(), "THREEMODULE_FAKE".to_string()),
                ("engine/core/three.core.min.js".to_string(), "THREECORE_FAKE".to_string()),
            ])
        };
        let three_cdn = "https://cdn.example.com/tve";
        let gzip_cdn = "https://res.example.com/pkg";
        let run = |single: bool, gzip: bool, cdn: bool, gzip_base: &str, three_base: &str| {
            build_export_impl(
                root.display().to_string(),
                "web".into(),
                vec!["assets/Main.scene".into()],
                "assets/Main.scene".into(),
                "T".into(),
                false,
                single,
                gzip,
                false,
                cdn,
                gzip_base.into(),
                three_base.into(),
                runtime_files(single),
                None,
                None,
            )
            .unwrap()
        };

        // 多文件 + Three CDN：three 文件不落盘，运行时脚本里指向 three 的相对
        // import 直接重写为 CDN 绝对 URL（import map 拦截不了相对说明符）；
        // 未填 gzip 资源地址时 config 不带 gzipBase
        let result = run(false, false, true, "", three_cdn);
        let out = root.join("build/web");
        assert!(result.cdn);
        assert!(!out.join("engine/core/three.module.min.js").exists(), "three.module 不内嵌");
        assert!(!out.join("engine/core/three.core.min.js").exists(), "three.core 不内嵌");
        assert!(out.join("engine/b.mjs").is_file(), "其余 engine 模块仍内嵌");
        let player = fs::read_to_string(out.join("player.mjs")).unwrap();
        assert!(
            player.contains(&format!("\"{three_cdn}/three.module.min.js\"")),
            "player 的 three import 重写为 CDN URL"
        );
        let helper = fs::read_to_string(out.join("engine/b.mjs")).unwrap();
        assert!(
            helper.contains(&format!("\"{three_cdn}/three.module.min.js\"")),
            "engine 模块的 three import 重写为 CDN URL"
        );
        let html = fs::read_to_string(out.join("index.html")).unwrap();
        assert!(!html.contains("importmap"), "不再注入 import map");
        let cfg: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(out.join("config.json")).unwrap()).unwrap();
        assert!(cfg.get("gzipBase").is_none(), "未填 gzip 地址时不写 gzipBase");
        assert!(!html.contains("THREEMODULE_FAKE"));

        // 多文件 + gzip + gzip 资源地址（CDN 开关关）：归档仍生成（供上传 CDN），
        // three 照常内嵌，仅 config 带 gzipBase 供运行时远程拉取
        let result = run(false, true, false, gzip_cdn, "");
        let out = root.join("build/web");
        assert!(!result.cdn);
        assert!(out.join("engine/core/three.module.min.js").is_file(), "CDN 关闭时 three 内嵌");
        assert!(out.join("assets.gzip").is_file());
        let player = fs::read_to_string(out.join("player.mjs")).unwrap();
        assert!(
            player.contains("\"./engine/core/three.module.min.js\""),
            "CDN 关闭时说明符保持相对路径"
        );
        let cfg: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(out.join("config.json")).unwrap()).unwrap();
        assert_eq!(cfg["gzipBase"], gzip_cdn);

        // 单页 + Three CDN（gzip 两种形态）：three 不内联，代码内模块说明符重写为
        // tve:，指向 three 的说明符直接重写为 CDN 绝对 URL（不再需要 cdnImports）
        for gzip in [false, true] {
            let result = run(true, gzip, true, "", three_cdn);
            assert!(result.cdn);
            let html = fs::read_to_string(root.join("build/web/index.html")).unwrap();
            assert!(!html.contains("cdnImports"), "不再内联 cdnImports 映射表");
            assert!(!html.contains("THREEMODULE_FAKE"), "three 源码不内联");
            if !gzip {
                assert!(html.contains("tve:engine/b.mjs"), "其余模块仍内联并重写说明符");
                // 代码内联为 JSON 字符串，URL 前的引号被转义为 \"，只断言 URL 本身
                assert!(
                    html.contains(&format!("{three_cdn}/three.module.min.js")),
                    "three import 直接重写为 CDN URL"
                );
            }
        }

        // 前缀剥离与协议补全：产物 engine/core/ 前缀被剥离，不与基地址结尾目录
        // 重复拼接；无协议地址自动补 https://（否则被按页面相对路径解析）；
        // gzip 地址以 /assets.gzip 结尾时 config 原样保留（运行时拼接去重）
        let result = run(false, false, true, "", "cdn.example.com/tve/libs");
        assert!(result.cdn);
        let player = fs::read_to_string(root.join("build/web/player.mjs")).unwrap();
        assert!(
            player.contains("https://cdn.example.com/tve/libs/three.module.min.js"),
            "无协议地址补 https:// 且产物前缀剥离后不重复拼接"
        );
        let _ = run(false, true, false, "https://res.example.com/pkg/assets.gzip", "");
        let cfg: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(root.join("build/web/config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(cfg["gzipBase"], "https://res.example.com/pkg/assets.gzip");

        // 官方 CDN 版本目录（无 engine/ 前缀）：URL 直接指向目录下的构建文件，
        // 不追加产物内的 engine/ 目录前缀（cdnjs 0.185.1 与内嵌运行时同名同版本）
        let three_official = "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.185.1";
        let _ = run(false, false, true, "", three_official);
        let player = fs::read_to_string(root.join("build/web/player.mjs")).unwrap();
        assert!(
            player.contains(&format!("\"{three_official}/three.module.min.js\"")),
            "官方 CDN 版本目录直接拼接文件名"
        );
        assert!(
            !player.contains(&format!("\"{three_official}/engine/")),
            "映射 URL 不追加产物内 engine/ 前缀"
        );

        // Three CDN 地址留空：CDN 模式不生效，回退标准构建（three 内嵌）
        let result = run(false, false, true, "", "   ");
        assert!(!result.cdn);
        assert!(root.join("build/web/engine/core/three.module.min.js").is_file());
        let _ = fs::remove_dir_all(&base);
    }

    /// 远程地址归一化与前缀去重拼接（three 剥离产物内 engine/core/ 前缀后拼接）
    #[test]
    fn cdn_url_join_and_normalize() {
        use super::{join_cdn_url, normalize_base_url, three_cdn_url};
        assert_eq!(normalize_base_url("  https://x.com/a/ "), "https://x.com/a");
        assert_eq!(normalize_base_url("x.com/a/"), "https://x.com/a");
        assert_eq!(normalize_base_url("//x.com/a"), "//x.com/a");
        assert_eq!(normalize_base_url("  "), "");
        assert_eq!(
            join_cdn_url("https://x.com/tve", "engine/core/three.module.min.js"),
            "https://x.com/tve/engine/core/three.module.min.js"
        );
        assert_eq!(
            join_cdn_url("https://x.com/tve/libs", "engine/core/three.module.min.js"),
            "https://x.com/tve/libs/engine/core/three.module.min.js"
        );
        assert_eq!(
            join_cdn_url("https://x.com/pkg", "assets.gzip"),
            "https://x.com/pkg/assets.gzip"
        );
        assert_eq!(
            join_cdn_url("https://x.com/pkg/assets.gzip", "assets.gzip"),
            "https://x.com/pkg/assets.gzip"
        );
        // three：剥离 engine/core/ 前缀拼到基地址（官方 CDN 版本目录与自建目录统一规则）
        assert_eq!(
            three_cdn_url("https://c.com/three.js/0.185.1", "engine/core/three.module.min.js"),
            "https://c.com/three.js/0.185.1/three.module.min.js"
        );
        assert_eq!(
            three_cdn_url("https://x.com/tve/libs", "engine/core/three.module.min.js"),
            "https://x.com/tve/libs/three.module.min.js"
        );
    }
}
