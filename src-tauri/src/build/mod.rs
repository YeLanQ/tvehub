//! 构建导出（重任务工厂化）：前端收集运行时文本 → Rust 按渠道装配产物管线 →
//! 写入 `<项目>/build/<渠道>/` → 返回自描述结果。
//!
//! 结构（工厂模式）：
//! - command：Tauri 命令 build_export——注册任务管理器（取消/进度），
//!   收敛 IPC 参数为 BuildJob 后交给 run_build；
//! - run_build：公共预检（渠道工厂取管线 → 场景/项目目录校验 → 地址归一化
//!   → 输出目录解析）+ 调度 ChannelPipeline::build；
//! - ChannelPipeline + channel_pipeline：渠道工厂——web 渠道由 web 模块
//!   实现；新增渠道（如 wechat 微信小游戏）注册实现即可，命令层与前端配置不动；
//! - 各阶段小模块：classify（文件分类）、urls（远程地址/three CDN）、
//!   specifiers（模块说明符重写）、archive（gzip 归档/单页内联）、
//!   refs + release（发布模式）、config（产物 config）、
//!   single_page / multi_file（两种产物形态组装）。
//!
//! web 渠道行为（自 build.rs 单体时代保留）：
//! - 打包选中场景及其引用资产（.mat 材质/贴图/模型）与网页运行时（player +
//!   engine 引擎模块，由前端 fetch 传入）；多场景写 scenes/<场景名>.json，
//!   入口由 config.json 的 mainScene 决定（player 支持 ?scene=<场景名> 切换）；
//! - 产物形态：多文件（场景/资产按相对路径落盘）或单页（全部内联进 index.html
//!   的 window.__TVE_BUILD_DATA，产物无 assets/、scenes/ 目录，也没有
//!   player.mjs/engine 文件——只有一个单页 HTML）；
//! - Gzip 压缩：场景与资产打进单个 gzip 归档（多文件写 assets.gzip；单页
//!   base64 内联），运行时用浏览器原生 DecompressionStream 解压并经 fetch
//!   拦截供资产（无需服务器配合）；
//! - Gzip 资源地址 / Three CDN 地址：非空时归档或 three.js 运行时从远程拉取
//!   （three 相对 import 直接重写为 CDN 绝对 URL，import map 拦截不了相对说明符）；
//! - 复用 preview.rs 的资产收集（collect_scene_assets）与文件写入
//!   （write_export_dir），资源二进制全部由 Rust 直读磁盘，不以 base64 穿过 IPC。

mod archive;
mod classify;
mod command;
mod config;
mod job;
mod multi_file;
mod refs;
mod release;
mod single_page;
mod specifiers;
mod urls;
mod web;

// 命令与数据从模块根再导出：lib.rs 的命令注册表保持 build::build_export 的读法
// （glob 带出 tauri 命令宏生成的隐藏符号，与 lanshare 同一做法）
pub use command::*;
pub use job::{BuildJob, BuildResult, JobCtx};

use std::path::{Path, PathBuf};

use urls::normalize_base_url;

/// 渠道产物管线：一种构建渠道一个实现（web 渠道见 web 模块）。
/// 公共预检完成后由 run_build 调度；实现只关心渠道自身的产物组装。
pub trait ChannelPipeline: Send + Sync {
    /// 执行构建：目录/场景/地址/输出目录均已就绪
    fn build(&self, prepared: &job::Prepared, ctx: &JobCtx) -> Result<BuildResult, String>;
}

/// 渠道工厂：按渠道 id 装配产物管线。未注册渠道在此明确报"暂未支持"
/// （wechat 为前端 UI 占位渠道；实现后在此注册即可）
pub fn channel_pipeline(channel: &str) -> Result<Box<dyn ChannelPipeline>, String> {
    match channel {
        "web" => Ok(Box::new(web::WebPipeline)),
        other => Err(format!("构建渠道 '{other}' 暂未支持")),
    }
}

/// 构建入口：公共预检 + 渠道管线调度（同步，便于单元测试直接驱动完整流程）
pub fn run_build(job: BuildJob, ctx: &JobCtx) -> Result<BuildResult, String> {
    let _ = &job.title; // 产物清单已移除；保留字段与前端配置对齐
    let pipeline = channel_pipeline(&job.channel)?;
    if job.scenes.is_empty() {
        return Err("至少选择一个构建场景".to_string());
    }
    let root_path = PathBuf::from(&job.root);
    if !root_path.is_dir() {
        return Err(format!("项目目录不存在: '{}'", root_path.display()));
    }
    if ctx.cancelled() {
        return Err("任务已取消".into());
    }
    ctx.progress(0.05, &format!("准备导出 {} 个场景", job.scenes.len()));
    // 两个地址相互独立、各自归一化（去空白与结尾 '/'，无协议补 https://）：
    // - gzip_base：gzip 归档远程基址（非空时写入 config 供运行时远程拉取）；
    // - three_base：Three CDN 基址，仅在 CDN 模式开启时生效（three.js 不内嵌）；
    // 留空均回退当前行为（归档本地读取 / three 内嵌）。拼接相对路径时经
    // join_cdn_url 去重已带的前缀（如地址以 /engine、/assets.gzip 结尾不重复拼）
    let gzip_base = normalize_base_url(&job.gzip_base);
    let three_base = normalize_base_url(&job.cdn_base);
    let cdn_active = job.cdn && !three_base.is_empty();
    // 主场景必须在选中列表内（前端默认首个选中项；这里兜底）
    let main_scene = if job.scenes.iter().any(|s| s == &job.main_scene) {
        job.main_scene.clone()
    } else {
        job.scenes[0].clone()
    };
    // 输出目录：默认 build/<channel>；调用方可覆盖（如局域网共享打到 .tmp/share）。
    // 覆盖目录必须是项目根内的相对路径（拒绝绝对路径与 .. 越界）
    let out = match job.out_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(rel) => {
            if Path::new(rel).is_absolute() || rel.split(['/', '\\']).any(|s| s == "..") {
                return Err(format!("非法导出目录: {rel}"));
            }
            root_path.join(rel)
        }
        None => root_path.join("build").join(&job.channel),
    };
    if !job.files.contains_key("index.html") {
        return Err("网页运行时缺少 index.html".to_string());
    }
    let prepared = job::Prepared {
        job,
        root_path,
        out,
        gzip_base,
        three_base,
        cdn_active,
        main_scene,
    };
    pipeline.build(&prepared, ctx)
}

#[cfg(test)]
mod tests;
