//! 微信小游戏渠道产物管线：本质是把 H5（多文件构建）产物转换为微信小游戏包。
//!
//! 架构（与 web 渠道完全独立，不改动 web.rs）：
//! - 运行时代码 = 仓库构建期预打的单文件 CJS bundle（code.js，含微信适配层 +
//!   player + engine + three）+ tve 门面（engine/core/tve.js），经前端 IPC 传入；
//! - 数据全内联：场景/资产 → data.js（config + assets{rel: base64}），运行期零
//!   文件系统参与——「自定义后缀不进包 / 路径大小写」两类问题类别整体消失；
//! - 用户脚本（src/**.js，前端已按 CommonJS 编译）小写文件名进包（开发者工具
//!   包内注册表小写归一），经 tve.js 门面 require 引擎 API；
//! - 工程文件（game.js/game.json/project.config.json）由本管线生成。

use std::collections::HashMap;
use std::fs;

use super::classify::scene_entry_name;
use super::config::product_config;
use super::job::{BuildResult, JobCtx, PackedScene, Prepared};
use super::release::apply_release;
use super::wechat_pack::{
    data_js, game_js, game_json, project_config_json, project_private_config_json, readme,
    resolve_appid,
};
use super::ChannelPipeline;

/// 预构建微信运行时文件键（前端按 wechat-runtime-files 清单传入；rapier 按项目
/// 物理配置附带）
fn is_wechat_runtime_key(rel: &str) -> bool {
    rel == "code.js"
        || rel == "engine/core/tve.js"
        || rel.starts_with("engine/runtime/physics-engines/")
}

/// 微信渠道：H5 构建产物 → 微信小游戏包（数据全内联，零文件系统）
pub struct WechatPipeline;

impl ChannelPipeline for WechatPipeline {
    fn build(&self, p: &Prepared, ctx: &JobCtx) -> Result<BuildResult, String> {
        let job = &p.job;

        // 项目配置预检（v1 能力边界，前置到收集之前快速失败）
        preflight_project(p.root_path.as_path())?;

        // —— 前端传入文件的分流：微信运行时 / 用户脚本 / 其余（仅允许 script-graph.json）——
        let mut runtime_files: HashMap<String, String> = HashMap::new();
        let mut user_scripts: HashMap<String, String> = HashMap::new();
        let mut extra: HashMap<String, String> = HashMap::new();
        for (rel, text) in &job.files {
            if is_wechat_runtime_key(rel) {
                runtime_files.insert(rel.clone(), text.clone());
            } else if rel.starts_with("src/") && rel.ends_with(".js") {
                // 开发者工具包内注册表小写归一：包内脚本文件名统一小写
                let lowered = rel.to_lowercase();
                if user_scripts.insert(lowered.clone(), text.clone()).is_some() {
                    return Err(format!("用户脚本文件名小写化后冲突: {rel}"));
                }
            } else if rel == "script-graph.json" {
                extra.insert(rel.clone(), text.clone());
            } else {
                return Err(format!(
                    "微信渠道收到非预期的运行时文件 '{rel}'（前端清单与管线预期不一致，请反馈）"
                ));
            }
        }
        if !runtime_files.contains_key("code.js") {
            return Err(
                "微信运行时缺少预构建 code.js（编辑器微信运行时未生成，请重启编辑器或重新构建运行时）"
                    .to_string(),
            );
        }

        // —— 场景收集（与 web 渠道同一套 preview 收集；微信不改动 web.rs）——
        if ctx.cancelled() {
            return Err("任务已取消".into());
        }
        ctx.progress(0.15, "收集场景与资产");
        let mut packed: Vec<PackedScene> = Vec::new();
        let mut used_names: Vec<String> = Vec::new();
        let mut missing: Vec<String> = Vec::new();
        let mut scene_texts: Vec<(String, String)> = Vec::new();
        let mut text_assets: HashMap<String, String> = HashMap::new();
        let mut binaries: HashMap<String, Vec<u8>> = HashMap::new();

        use rayon::prelude::*;
        let scene_results: Vec<(
            String,
            String,
            HashMap<String, String>,
            HashMap<String, Vec<u8>>,
            Vec<String>,
        )> = job
            .scenes
            .par_iter()
            .map(|rel| {
                let text = crate::project::resolve_in_root(&p.root_path, rel)
                    .and_then(|path| fs::read_to_string(&path).map_err(|e| e.to_string()))
                    .map_err(|e| format!("读取场景失败 '{rel}': {e}"))?;
                let mut sf: HashMap<String, String> = HashMap::new();
                let mut sb: HashMap<String, Vec<u8>> = HashMap::new();
                let sm = crate::preview::collect_scene_assets(&p.root_path, &text, &mut sf, &mut sb);
                Ok::<_, String>((rel.clone(), text, sf, sb, sm))
            })
            .collect::<Result<Vec<_>, String>>()?;
        for (_, _, sf, sb, sm) in &scene_results {
            for (k, v) in sf {
                text_assets.entry(k.clone()).or_insert_with(|| v.clone());
            }
            for (k, v) in sb {
                binaries.entry(k.clone()).or_insert_with(|| v.clone());
            }
            missing.extend(sm.iter().cloned());
        }
        for (rel, text, _, _, _) in scene_results {
            let name = scene_entry_name(&rel, &mut used_names);
            scene_texts.push((format!("scenes/{name}.json"), text));
            packed.push(PackedScene { name, rel, file: String::new() });
        }
        for (i, (file, _)) in scene_texts.iter().enumerate() {
            packed[i].file = file.clone();
        }

        // 发布模式：uid 重命名 + 引用重写（作用于场景/资产数据面，脚本与运行时不参与）
        let mut bin_converted: Vec<String> = Vec::new();
        if job.release {
            apply_release(
                &p.root_path,
                &mut text_assets,
                &mut binaries,
                &mut scene_texts,
                &mut bin_converted,
            );
        }
        ctx.progress(0.45, "组装内联数据");

        // 产物 config：项目配置 + 构建入口（mainScene/scenes/debug/scriptGraph）
        let project_cfg: serde_json::Value = fs::read_to_string(p.root_path.join("project.config.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(serde_json::Value::Null);
        let main_name = packed
            .iter()
            .find(|s| s.rel == p.main_scene)
            .map(|s| s.name.clone())
            .unwrap_or_default();
        // script-graph 检测沿用 config.rs 语义（files 键存在即标记）；微信无 gzip 基址
        let mut cfg_input = extra.clone();
        for (rel, text) in &text_assets {
            cfg_input.entry(rel.clone()).or_insert_with(|| text.clone());
        }
        let cfg = product_config(project_cfg, &packed, &main_name, job.debug, &cfg_input, "");

        // data.js：场景 + 文本资产 + 二进制资产（base64）全内联
        let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
        for (rel, text) in &scene_texts {
            entries.push((rel.clone(), text.clone().into_bytes()));
        }
        for (rel, text) in &text_assets {
            entries.push((rel.clone(), text.clone().into_bytes()));
        }
        for (rel, bytes) in &binaries {
            entries.push((rel.clone(), bytes.clone()));
        }
        for (rel, text) in &extra {
            entries.push((rel.clone(), text.clone().into_bytes()));
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));

        // —— 包组装 ——
        let orientation = job
            .wechat_orientation
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        let orientation = if orientation == "landscape" { "landscape" } else { "portrait" };
        let project_name = p
            .root_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "tve-game".to_string());
        let appid = resolve_appid(job.wechat_appid.as_deref(), &p.out);

        let mut package: HashMap<String, String> = HashMap::new();
        for (rel, text) in runtime_files {
            package.insert(rel, text);
        }
        for (rel, text) in user_scripts {
            package.insert(rel, text);
        }
        package.insert("game.js".to_string(), game_js());
        package.insert("data.js".to_string(), data_js(cfg, &entries)?);
        package.insert("game.json".to_string(), game_json(orientation));
        package.insert(
            "project.config.json".to_string(),
            project_config_json(&project_name, &appid),
        );
        package.insert(
            "project.private.config.json".to_string(),
            project_private_config_json(&project_name),
        );
        package.insert("README.txt".to_string(), readme(&appid, orientation));
        // 包体积不做构建期限制：由微信开发者工具在预览/上传发布时按其规则判定

        let total_kb = package.values().map(|t| t.len()).sum::<usize>() / 1024;
        ctx.progress(0.9, "写入产物");
        crate::preview::write_export_dir(&p.out, package, &HashMap::new())
            .map_err(|e| format!("写入构建产物失败: {e}"))?;

        let mut message = format!(
            "构建完成（appid: {appid}，方向: {orientation}；数据全内联，主包 {total_kb}KB）"
        );
        if !missing.is_empty() {
            message.push_str(&format!("（{} 项缺失资产被跳过）", missing.len()));
        }
        Ok(BuildResult {
            ok: true,
            channel: job.channel.clone(),
            output_dir: p.out.display().to_string(),
            main_scene: p.main_scene.clone(),
            main_scene_name: main_name,
            scenes: packed,
            single_page: false,
            gzip: false,
            release: job.release,
            cdn: false,
            bin_converted,
            assets_packed: entries.len(),
            missing,
            message,
        })
    }
}

/// v1 能力边界预检：物理仅 rapier；Draco/Basis 压缩资产不支持
fn preflight_project(root: &std::path::Path) -> Result<(), String> {
    let cfg: serde_json::Value = fs::read_to_string(root.join("project.config.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::Value::Null);
    let physics = cfg.get("physics");
    let enabled = physics
        .and_then(|p| p.get("physicsEnabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if enabled {
        let backend = physics
            .and_then(|p| p.get("backend"))
            .and_then(|v| v.as_str())
            .unwrap_or("rapier");
        if backend != "rapier" {
            return Err(format!(
                "微信小游戏渠道 v1 仅支持 rapier 物理后端，当前项目为 '{backend}'——请在项目设置切换后重试"
            ));
        }
    }
    let resources = cfg.get("resources");
    if resources
        .and_then(|r| r.get("dracoCompression"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Err(
            "微信小游戏渠道 v1 暂不支持 Draco 压缩资产（依赖 Worker）——请在项目设置关闭「Draco 压缩」后重试".to_string(),
        );
    }
    if resources
        .and_then(|r| r.get("textureCompression"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Err(
            "微信小游戏渠道 v1 暂不支持 Basis 纹理压缩（依赖 Worker）——请在项目设置关闭「纹理压缩」后重试".to_string(),
        );
    }
    Ok(())
}
