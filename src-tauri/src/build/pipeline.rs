//! 渠道管线层：ChannelPipeline trait（渠道身份 + 选项解析 + 预检 + 构建）、
//! 渠道工厂与 run_build 公共编排。
//!
//! 分层契约：run_build 只做渠道无关的公共预检与调度；渠道差异（入口页形态、
//! 专属选项、能力边界）全部收敛在渠道实现内——通用层不出现任何渠道名字面量。

use std::path::{Path, PathBuf};

use super::job::{BuildJob, BuildResult, JobCtx, Prepared};
use super::options::ResolvedChannel;

/// 进度锚点（两渠道统一口径：准备 → 收集 → 组装 → 写入）
pub mod progress {
    pub const PREPARE: f64 = 0.05;
    pub const COLLECT: f64 = 0.15;
    pub const ASSEMBLE: f64 = 0.45;
    pub const WRITE: f64 = 0.9;
}

/// 渠道产物管线：一种构建渠道一个实现。run_build 完成公共预检后按
/// resolve（选项归一）→ preflight（渠道自查）→ build 的顺序调度；
/// 实现只关心渠道自身的产物组装。
pub trait ChannelPipeline: Send + Sync {
    /// 渠道 id（与前端 BUILD_CHANNELS / BuildJob.channel 同一口径）
    fn id(&self) -> &'static str;

    /// 渠道选项解析：扁平 IPC 字段 → 归一化渠道参数（解析无失败态）
    fn resolve(&self, job: &BuildJob) -> ResolvedChannel;

    /// 渠道自有预检（公共预检之后、构建之前；缺省通过）
    fn preflight(&self, job: &BuildJob) -> Result<(), String> {
        let _ = job;
        Ok(())
    }

    /// 执行构建：目录/场景/输出目录/渠道参数均已就绪
    fn build(&self, prepared: &Prepared, ctx: &JobCtx) -> Result<BuildResult, String>;
}

/// 渠道工厂：按渠道 id 装配产物管线。未注册渠道在此明确报"暂未支持"
pub fn channel_pipeline(channel: &str) -> Result<Box<dyn ChannelPipeline>, String> {
    match channel {
        "web" => Ok(Box::new(super::channels::web::WebPipeline)),
        "wechat" => Ok(Box::new(super::channels::wechat::WechatPipeline)),
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
    ctx.progress(
        progress::PREPARE,
        &format!("准备导出 {} 个场景", job.scenes.len()),
    );
    // 主场景必须在选中列表内（前端默认首个选中项；这里兜底）
    let main_scene = if job.scenes.iter().any(|s| s == &job.main_scene) {
        job.main_scene.clone()
    } else {
        job.scenes[0].clone()
    };
    let out = resolve_out_dir(&job, &root_path, pipeline.id())?;
    // 渠道自有预检（web：入口页在场；wechat：压缩能力边界；缺省通过）
    pipeline.preflight(&job)?;
    let prepared = Prepared {
        channel: pipeline.resolve(&job),
        job,
        root_path,
        out,
        main_scene,
    };
    pipeline.build(&prepared, ctx)
}

/// 输出目录解析：默认 build/<渠道>（渠道名取自管线 id——目录命名是渠道的
/// 属性）；调用方可覆盖（如局域网共享打到 .tmp/share）。
/// 覆盖目录必须是项目根内的相对路径（拒绝绝对路径与 .. 越界）
fn resolve_out_dir(job: &BuildJob, root_path: &Path, channel: &str) -> Result<PathBuf, String> {
    match job.out_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(rel) => {
            if Path::new(rel).is_absolute() || rel.split(['/', '\\']).any(|s| s == "..") {
                return Err(format!("非法导出目录: {rel}"));
            }
            Ok(root_path.join(rel))
        }
        None => Ok(root_path.join("build").join(channel)),
    }
}
