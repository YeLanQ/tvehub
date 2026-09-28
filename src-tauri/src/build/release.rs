//! 发布模式：模型二进制化（LQENBIN1）+ 资产 uid 重命名（.meta uuid 优先，否则
//! 路径哈希）+ 引用重写 + 场景/材质 JSON 紧凑化；运行时脚本压缩入口。

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use super::classify::{is_model_ext, is_runtime_code, is_runtime_support_data, rel_ext};
use super::refs::{rewrite_mat_text, rewrite_scene_refs, rewrite_texcube_text};

/// fnv1a64 → 16 位十六进制（无 .meta 资产的确定性 uid，路径稳定）
pub(super) fn fallback_uid(rel: &str) -> String {
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

/// 发布模式处理：模型二进制化（LQENBIN1）+ 资产 uid 重命名（.meta uuid 优先，否则
/// 路径哈希）+ 重写场景与材质引用 + 场景/材质 JSON 紧凑化。返回重命名表。
/// 场景 JSON 文件名保持不变（config.scenes 按名引用，是产物公开入口）。
pub(super) fn apply_release(
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

/// 发布模式 JS 压缩：保守压缩（去注释 + 空白折叠，语义不变；见 js_minify 模块）
pub(super) fn minify_js_source(text: &str) -> String {
    crate::js_minify::minify_js(text)
}
