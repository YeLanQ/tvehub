//! 微信小游戏渠道产物管线（工厂桥接的渠道实现之一）：本质是把 H5（多文件构建）
//! 产物转换为微信小游戏包。
//!
//! 架构（与 web 渠道完全独立，渠道结构对称）：
//! - 运行时代码 = 仓库构建期预打的单文件 CJS bundle（code.js，含微信适配层 +
//!   player + engine + three）+ tve 门面（engine/core/tve.js），经前端 IPC 传入；
//!   物理引擎随包 = 胶水 .js（文本）+ .wasm（base64 过 IPC，解码按字节写盘——
//!   基础库 WXWebAssembly 只认代码包内 .wasm 文件路径）；
//! - 资产文件化（2.0）：场景/小文本资产 base64 内联进 data.js，二进制资产
//!   （贴图/模型/音频）按 assets/<uid><safe-ext> 原始字节落盘，data.js 带
//!   assetFiles 清单（rel → 文件路径），桥接层查内联表 miss 时经端点
//!   readPackageFile 读包内文件——33% base64 税从资产上移除；
//! - 数据全内联：场景/资产 → data.js（config + assets{rel: base64}），运行期零
//!   文件系统参与——「自定义后缀不进包 / 路径大小写」两类问题类别整体消失；
//! - 用户脚本（src/**.js，前端已按 CommonJS 编译）小写文件名进包（开发者工具
//!   包内注册表小写归一），经 tve.js 门面 require 引擎 API；
//! - 工程文件（game.js/game.json/project.config.json）由 pack 子模块生成。
//!
//! 子模块：pack（包文件生成）、preflight（能力边界预检）；场景收集走内容内核
//! kernel::content，产物 config 组装走共享步骤 steps::config。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use base64::Engine as _;

use crate::build::finalize::{
    finish_result, main_scene_name, read_project_config, write_products, ResultDraft,
};
use crate::build::job::{BuildJob, BuildResult, JobCtx, Prepared};
use crate::build::kernel::content::build_content;
use crate::build::kernel::release::minify_js_source;
use crate::build::options::{ResolvedChannel, WechatParams};
use crate::build::pipeline::{progress, ChannelPipeline};
use crate::build::steps::config::product_config;

mod pack;
mod preflight;
use self::pack::{
    asset_file_name, data_js, game_js, game_json, project_config_json, project_private_config_json,
    readme, resolve_appid,
};
use self::preflight::preflight_project;

/// 微信渠道：H5 构建产物 → 微信小游戏包（数据全内联，零文件系统）
pub struct WechatPipeline;

impl ChannelPipeline for WechatPipeline {
    fn id(&self) -> &'static str {
        "wechat"
    }

    fn resolve(&self, job: &BuildJob) -> ResolvedChannel {
        // 方向归一化：trim + 小写，仅 landscape/portrait 两值（缺省 portrait）
        let orientation = job
            .wechat_orientation
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        ResolvedChannel::Wechat(WechatParams {
            appid: job.wechat_appid.clone(),
            orientation: if orientation == "landscape" { "landscape" } else { "portrait" }.to_string(),
        })
    }

    fn preflight(&self, job: &BuildJob) -> Result<(), String> {
        // 项目配置预检（v1 能力边界，构建期最早点快速失败）
        preflight_project(Path::new(&job.root))
    }

    fn build(&self, p: &Prepared, ctx: &JobCtx) -> Result<BuildResult, String> {
        let wechat = p.channel.wechat();
        let job = &p.job;

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
        ctx.progress(progress::COLLECT, "收集场景与资产");
        let content = build_content(&p.root_path, &job.scenes, job.release)?;

        // release 一致性：用户脚本与 web 渠道同一压缩器同源压缩（此前仅 web 压缩）
        if job.release {
            if ctx.cancelled() {
                return Err("任务已取消".into());
            }
            for text in user_scripts.values_mut() {
                *text = minify_js_source(text);
            }
        }
        ctx.progress(progress::ASSEMBLE, "组装内联数据");

        // 产物 config：项目配置 + 构建入口（mainScene/scenes/debug/scriptGraph）
        let project_cfg = read_project_config(&p.root_path);
        let main_name = main_scene_name(&content.packed, &p.main_scene);
        // script-graph 检测沿用 config.rs 语义（files 键存在即标记）；微信无 gzip 基址
        let mut cfg_input = extra.clone();
        for (rel, text) in &content.text_assets {
            cfg_input.entry(rel.clone()).or_insert_with(|| text.clone());
        }
        let cfg = product_config(project_cfg, &content.packed, &main_name, job.debug, &cfg_input, "");

        // data.js：场景 + 文本资产 + script-graph（base64 内联，体量小、热路径零
        // FS 读）；二进制资产文件化落盘（assets/<uid><safe-ext> 原始字节），data.js 只
        // 带「rel → 文件路径」清单——33% base64 税从资产上移除
        let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
        for (rel, text) in &content.scene_texts {
            entries.push((rel.clone(), text.clone().into_bytes()));
        }
        for (rel, text) in &content.text_assets {
            entries.push((rel.clone(), text.clone().into_bytes()));
        }
        for (rel, text) in &extra {
            entries.push((rel.clone(), text.clone().into_bytes()));
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        let mut used_names: HashSet<String> = HashSet::new();
        let mut asset_files: Vec<(String, String)> = content
            .binaries
            .keys()
            .map(|rel| (rel.clone(), asset_file_name(rel, &mut used_names)))
            .collect();
        asset_files.sort_by(|a, b| a.0.cmp(&b.0));

        // —— 包组装 ——
        let orientation = wechat.orientation.as_str();
        let project_name = p
            .root_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "tve-game".to_string());
        let appid = resolve_appid(wechat.appid.as_deref(), &p.out);

        let mut package: HashMap<String, String> = HashMap::new();
        let mut binaries: HashMap<String, Vec<u8>> = HashMap::new();
        for (rel, text) in runtime_files {
            // .wasm 运行时文件（物理引擎）经前端 base64 传入：文本 IPC 通道会
            // UTF-8 损坏二进制，此处解码进 binaries 按字节写盘
            if rel.ends_with(".wasm") {
                if ctx.cancelled() {
                    return Err("任务已取消".into());
                }
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
        // 文件化资产：构建期原始字节直接落盘（不走 IPC，无编码税）
        for (rel, file) in &asset_files {
            if let Some(bytes) = content.binaries.get(rel) {
                binaries.insert(file.clone(), bytes.clone());
            }
        }
        package.insert("game.js".to_string(), game_js());
        package.insert("data.js".to_string(), data_js(cfg, &entries, &asset_files)?);
        package.insert("game.json".to_string(), game_json(orientation)?);
        package.insert(
            "project.config.json".to_string(),
            project_config_json(&project_name, &appid)?,
        );
        package.insert(
            "project.private.config.json".to_string(),
            project_private_config_json(&project_name)?,
        );
        package.insert("README.txt".to_string(), readme(&appid, orientation));
        // 包体积不做构建期限制：由微信开发者工具在预览/上传发布时按其规则判定

        let total_kb = (package.values().map(|t| t.len()).sum::<usize>()
            + binaries.values().map(|b| b.len()).sum::<usize>())
            / 1024;
        // 写盘（公共收尾：取消检查 + 写入锚点 + 原子换入）
        write_products(p, package, &binaries, ctx)?;

        let mut message = format!(
            "构建完成（appid: {appid}，方向: {orientation}；数据全内联，主包 {total_kb}KB）"
        );
        if !content.missing.is_empty() {
            message.push_str(&format!("（{} 项缺失资产被跳过）", content.missing.len()));
        }
        Ok(finish_result(
            p,
            ResultDraft {
                packed: content.packed,
                main_name,
                bin_converted: content.bin_converted,
                assets_packed: content.assets_packed,
                missing: content.missing,
                single_page: false,
                gzip: false,
                cdn: false,
                message,
            },
        ))
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
