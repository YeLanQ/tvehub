//! 微信小游戏渠道产物管线（工厂桥接的渠道实现之一）：本质是把 H5（多文件构建）
//! 产物转换为微信小游戏包。
//!
//! 架构（与 web 渠道完全独立，渠道结构对称）：
//! - 运行时代码 = 仓库构建期预打的单文件 CJS bundle（code.js，含微信适配层 +
//!   player + engine + three）+ tve 门面（engine/core/tve.js），经前端 IPC 传入；
//!   物理引擎随包 = 胶水 .js（文本）+ .wasm（base64 过 IPC，解码按字节写盘——
//!   基础库 WXWebAssembly 只认代码包内 .wasm 文件路径）；
//! - 数据全内联：场景/资产 → data.js（config + assets{rel: base64}），运行期零
//!   文件系统参与——「自定义后缀不进包 / 路径大小写」两类问题类别整体消失；
//! - 用户脚本（src/**.js，前端已按 CommonJS 编译）小写文件名进包（开发者工具
//!   包内注册表小写归一），经 tve.js 门面 require 引擎 API；
//! - 工程文件（game.js/game.json/project.config.json）由 pack 子模块生成。
//!
//! 子模块：pack（包文件生成）、preflight（能力边界预检）；场景收集走共享
//! 阶段 scene_collect，渠道无关阶段在 build 根的扁平模块。

use std::collections::HashMap;
use std::fs;

use base64::Engine as _;

use super::config::product_config;
use super::content::build_content;
use super::job::{BuildResult, JobCtx, Prepared};
use super::release::minify_js_source;
use super::ChannelPipeline;

mod pack;
mod preflight;
use self::pack::{
    data_js, game_js, game_json, project_config_json, project_private_config_json, readme,
    resolve_appid,
};
use self::preflight::preflight_project;

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

        // —— 导出内容内核：场景收集 + 引用资产 + release（与 web 渠道同源同构，
        //    跨渠道一致性由 tests/consistency_e2e.rs 守护）——
        if ctx.cancelled() {
            return Err("任务已取消".into());
        }
        ctx.progress(0.15, "收集场景与资产");
        let content = build_content(&p.root_path, &job.scenes, job.release)?;

        // release 一致性：用户脚本与 web 渠道同一压缩器同源压缩（此前仅 web 压缩）
        if job.release {
            for text in user_scripts.values_mut() {
                *text = minify_js_source(text);
            }
        }
        ctx.progress(0.45, "组装内联数据");

        // 产物 config：项目配置 + 构建入口（mainScene/scenes/debug/scriptGraph）
        let project_cfg: serde_json::Value = fs::read_to_string(p.root_path.join("project.config.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(serde_json::Value::Null);
        let main_name = content
            .packed
            .iter()
            .find(|s| s.rel == p.main_scene)
            .map(|s| s.name.clone())
            .unwrap_or_default();
        // script-graph 检测沿用 config.rs 语义（files 键存在即标记）；微信无 gzip 基址
        let mut cfg_input = extra.clone();
        for (rel, text) in &content.text_assets {
            cfg_input.entry(rel.clone()).or_insert_with(|| text.clone());
        }
        let cfg = product_config(project_cfg, &content.packed, &main_name, job.debug, &cfg_input, "");

        // data.js：场景 + 文本资产 + 二进制资产（base64）全内联
        let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
        for (rel, text) in &content.scene_texts {
            entries.push((rel.clone(), text.clone().into_bytes()));
        }
        for (rel, text) in &content.text_assets {
            entries.push((rel.clone(), text.clone().into_bytes()));
        }
        for (rel, bytes) in &content.binaries {
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
        let mut binaries: HashMap<String, Vec<u8>> = HashMap::new();
        for (rel, text) in runtime_files {
            // .wasm 运行时文件（物理引擎）经前端 base64 传入：文本 IPC 通道会
            // UTF-8 损坏二进制，此处解码进 binaries 按字节写盘
            if rel.ends_with(".wasm") {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(text.as_bytes())
                    .map_err(|e| format!("微信运行时 wasm 文件 base64 解码失败 '{rel}': {e}"))?;
                binaries.insert(rel, bytes);
            } else {
                package.insert(rel, text);
            }
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

        let total_kb = (package.values().map(|t| t.len()).sum::<usize>()
            + binaries.values().map(|b| b.len()).sum::<usize>())
            / 1024;
        ctx.progress(0.9, "写入产物");
        crate::preview::write_export_dir(&p.out, package, &binaries)
            .map_err(|e| format!("写入构建产物失败: {e}"))?;

        let mut message = format!(
            "构建完成（appid: {appid}，方向: {orientation}；数据全内联，主包 {total_kb}KB）"
        );
        if !content.missing.is_empty() {
            message.push_str(&format!("（{} 项缺失资产被跳过）", content.missing.len()));
        }
        Ok(BuildResult {
            ok: true,
            channel: job.channel.clone(),
            output_dir: p.out.display().to_string(),
            main_scene: p.main_scene.clone(),
            main_scene_name: main_name,
            scenes: content.packed,
            single_page: false,
            gzip: false,
            release: job.release,
            cdn: false,
            bin_converted: content.bin_converted,
            assets_packed: content.assets_packed,
            missing: content.missing,
            message,
        })
    }
}

/// 预构建微信运行时文件键（前端按 wechat-runtime-files 清单传入；物理引擎按
/// 项目后端附带：engine/runtime/physics-engines/{rapier|jolt|ammo/**}.{js,wasm}；
/// meshopt 解码 wasm 为 bundle 内联依赖的随包资产：engine/runtime/loaders/）
fn is_wechat_runtime_key(rel: &str) -> bool {
    rel == "code.js"
        || rel == "engine/core/tve.js"
        || rel == "engine/runtime/loaders/meshopt_decoder.wasm"
        || rel.starts_with("engine/runtime/physics-engines/")
}
