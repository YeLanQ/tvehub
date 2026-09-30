//! 共享阶段 · 场景收集：逐场景并行读盘 + 收集引用资产（复用 preview::
//! collect_scene_assets），合并去重 + 场景名去重。web / wechat 渠道共用的
//! 收集主干；渠道差异只在合并去向（web 并入运行时 files / wechat 独立资产表）。

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use super::classify::scene_entry_name;
use super::job::PackedScene;

/// 单场景并行收集结果
pub(super) struct SceneInput {
    /// 场景项目相对路径
    pub rel: String,
    /// 场景 JSON 文本
    pub text: String,
    /// 场景引用的文本资产（材质 .mat 等）
    pub text_assets: HashMap<String, String>,
    /// 场景引用的二进制资产（贴图/模型/音频）
    pub binaries: HashMap<String, Vec<u8>>,
    /// 缺失资产清单
    pub missing: Vec<String>,
}

/// 逐场景并行读盘 + 收集引用资产（rayon；场景相互独立）
pub(super) fn collect_scene_inputs(
    root: &Path,
    scenes: &[String],
) -> Result<Vec<SceneInput>, String> {
    use rayon::prelude::*;
    scenes
        .par_iter()
        .map(|rel| {
            let text = crate::project::resolve_in_root(root, rel)
                .and_then(|path| fs::read_to_string(&path).map_err(|e| e.to_string()))
                .map_err(|e| format!("读取场景失败 '{rel}': {e}"))?;
            let mut text_assets: HashMap<String, String> = HashMap::new();
            let mut binaries: HashMap<String, Vec<u8>> = HashMap::new();
            let missing = crate::preview::collect_scene_assets(root, &text, &mut text_assets, &mut binaries);
            Ok::<_, String>(SceneInput {
                rel: rel.clone(),
                text,
                text_assets,
                binaries,
                missing,
            })
        })
        .collect()
}

/// 合并去重后的全量收集结果
pub(super) struct CollectedScenes {
    pub packed: Vec<PackedScene>,
    /// 产物内场景键（scenes/<名>.json）→ 场景 JSON 文本
    pub scene_texts: Vec<(String, String)>,
    /// 场景引用的文本资产（跨场景去重，保留首次）
    pub text_assets: HashMap<String, String>,
    /// 场景引用的二进制资产（跨场景去重，保留首次）
    pub binaries: HashMap<String, Vec<u8>>,
    /// 缺失资产清单（跨场景累计）
    pub missing: Vec<String>,
}

/// 合并去重（or_insert 保留首次，跨场景共用资产只读一次）+ 场景名去重
/// （串行累积 used_names，重名自动加序号）
pub(super) fn merge_scene_inputs(inputs: Vec<SceneInput>) -> CollectedScenes {
    let mut packed: Vec<PackedScene> = Vec::new();
    let mut used_names: Vec<String> = Vec::new();
    let mut scene_texts: Vec<(String, String)> = Vec::new();
    let mut text_assets: HashMap<String, String> = HashMap::new();
    let mut binaries: HashMap<String, Vec<u8>> = HashMap::new();
    let mut missing: Vec<String> = Vec::new();

    for input in &inputs {
        for (k, v) in &input.text_assets {
            text_assets.entry(k.clone()).or_insert_with(|| v.clone());
        }
        for (k, v) in &input.binaries {
            binaries.entry(k.clone()).or_insert_with(|| v.clone());
        }
        missing.extend(input.missing.iter().cloned());
    }
    for input in inputs {
        let name = scene_entry_name(&input.rel, &mut used_names);
        scene_texts.push((format!("scenes/{name}.json"), input.text));
        packed.push(PackedScene {
            name,
            rel: input.rel,
            file: String::new(),
        });
    }
    for (i, (file, _)) in scene_texts.iter().enumerate() {
        packed[i].file = file.clone();
    }
    CollectedScenes {
        packed,
        scene_texts,
        text_assets,
        binaries,
        missing,
    }
}
