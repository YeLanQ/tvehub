//! 导出内容内核（渠道无关的「导出内容」生产者）：并行场景收集 + 引用资产合并
//! 去重 + 发布模式处理（uid 重命名/引用重写/模型 bin 化）内聚为一个入口。
//! web / wechat 渠道都只消费 ContentManifest 做包装——场景集合、资产集合、
//! 缺失清单、release 生效由内核结构保证跨渠道一致（tests/consistency_e2e.rs 守护）。

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use super::classify::scene_entry_name;
use crate::build::job::PackedScene;
use super::release::apply_release;

/// 单场景并行收集结果
struct SceneInput {
    /// 场景项目相对路径
    rel: String,
    /// 场景 JSON 文本
    text: String,
    /// 场景引用的文本资产（材质 .mat 等）
    text_assets: HashMap<String, String>,
    /// 场景引用的二进制资产（贴图/模型/音频）
    binaries: HashMap<String, Vec<u8>>,
    /// 缺失资产清单
    missing: Vec<String>,
}

/// 逐场景并行读盘 + 收集引用资产（rayon；场景相互独立）
fn collect_scene_inputs(root: &Path, scenes: &[String]) -> Result<Vec<SceneInput>, String> {
    use rayon::prelude::*;
    scenes
        .par_iter()
        .map(|rel| {
            let text = crate::project::resolve_in_root(root, rel)
                .and_then(|path| fs::read_to_string(&path).map_err(|e| e.to_string()))
                .map_err(|e| format!("读取场景失败 '{rel}': {e}"))?;
            let mut text_assets: HashMap<String, String> = HashMap::new();
            let mut binaries: HashMap<String, Vec<u8>> = HashMap::new();
            let missing = crate::scene_pack::collect_scene_assets(root, &text, &mut text_assets, &mut binaries);
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

/// 导出内容清单：渠道包装阶段的唯一内容来源（两渠道同源同构）
pub(in crate::build) struct ContentManifest {
    /// 场景清单（name/rel/file；重名自动加序号）
    pub packed: Vec<PackedScene>,
    /// 产物内场景键（scenes/<名>.json）→ 场景 JSON 文本
    pub scene_texts: Vec<(String, String)>,
    /// 场景引用的文本资产（跨场景去重，保留首次；release 后为重命名+重写后形态）
    pub text_assets: HashMap<String, String>,
    /// 场景引用的二进制资产（同上）
    pub binaries: HashMap<String, Vec<u8>>,
    /// 缺失资产清单（跨场景累计）
    pub missing: Vec<String>,
    /// release 生效产物：被二进制化的模型（项目相对路径）
    pub bin_converted: Vec<String>,
    /// 资产总数（口径：场景 + 文本资产 + 二进制；BuildResult.assets_packed 两渠道同公式）
    pub assets_packed: usize,
}

/// 构建导出内容：收集 + 合并去重（or_insert 保留首次）+ 场景名去重（串行累积，
/// 重名自动加序号）+ release 处理（uid 重命名只作用于资产键——运行时键经
/// is_runtime_code 过滤天然排除，渠道传入与否不影响结果）
pub(in crate::build) fn build_content(
    root: &Path,
    scenes: &[String],
    release: bool,
) -> Result<ContentManifest, String> {
    let inputs = collect_scene_inputs(root, scenes)?;

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

    let mut bin_converted: Vec<String> = Vec::new();
    if release {
        apply_release(
            root,
            &mut text_assets,
            &mut binaries,
            &mut scene_texts,
            &mut bin_converted,
        );
    }

    let assets_packed = packed.len() + text_assets.len() + binaries.len();
    Ok(ContentManifest {
        packed,
        scene_texts,
        text_assets,
        binaries,
        missing,
        bin_converted,
        assets_packed,
    })
}
