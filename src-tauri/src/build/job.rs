//! 构建任务数据：IPC 参数收敛为 BuildJob，取消/进度回调收拢为 JobCtx，
//! 公共预检后的就绪上下文为 Prepared；结果自描述（BuildResult/PackedScene）。

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;

/// 构建任务参数：`build_export` 命令参数原样收敛（字段与前端 api.buildExport
/// 一一对应，不改变 IPC 契约）
pub struct BuildJob {
    pub root: String,
    pub channel: String,
    /// 选中的构建场景（项目相对路径）
    pub scenes: Vec<String>,
    /// 主场景（必须在 scenes 内）
    pub main_scene: String,
    /// 页面标题（产物清单已移除，保留字段与前端配置对齐）
    pub title: String,
    /// 调试模式：保留运行日志转发
    pub debug: bool,
    /// 产物形态：true = 单页（数据内联 index.html）/ false = 多文件
    pub single_page: bool,
    /// 资产 gzip 归档（多文件写 assets.gzip；单页 base64 内联）
    pub gzip: bool,
    /// 发布模式：资源 uid 重命名 + 引用重写 + JSON 压缩
    pub release: bool,
    /// CDN 模式：three.js 运行时不内嵌，从 Three CDN 地址在线加载
    pub cdn: bool,
    /// gzip 资源地址（assets.gzip 归档远程基址；空 = 本地读取）
    pub gzip_base: String,
    /// Three CDN 地址（three.js 远程基址，CDN 模式下生效；空 = 内嵌 three.js）
    pub cdn_base: String,
    /// 前端 fetch 传入的网页运行时文本（index.html/player.mjs/engine/**，
    /// 属 WebView 打包资源，编辑器离线可用）
    pub files: HashMap<String, String>,
    /// 产物落盘目录（项目相对路径；缺省 build/<渠道>/）
    pub out_dir: Option<String>,
    /// 微信小游戏 AppID（可选；缺省走「上次产物继承 > touristappid」链）
    pub wechat_appid: Option<String>,
    /// 微信小游戏屏幕方向（"portrait" / "landscape"；缺省 portrait）
    pub wechat_orientation: Option<String>,
    /// 微信小游戏分包：文件化二进制资产移出主包（主包 4MB 限制的解法）
    pub wechat_subpackages: Option<bool>,
    /// 单个分包体积上限（MB；管线 resolve 阶段归一化钳到 1..=4，缺省 2）
    pub wechat_subpackage_size: Option<f64>,
    /// 微信真机诊断弹窗（audio-diag 的 __tveDiagOn storage 显式开关；勾选时
    /// game.js 启动即写开关，不勾则启动即清键——勾选框恒为权威态，设备
    /// storage 残留自愈）
    pub wechat_diag: Option<bool>,
}

/// 任务运行期上下文：取消检查与进度上报（命令层注入，单元测试传默认值）
pub struct JobCtx<'a> {
    pub is_cancelled: Option<&'a dyn Fn() -> bool>,
    pub report_progress: Option<&'a dyn Fn(f64, &str)>,
}

impl Default for JobCtx<'_> {
    fn default() -> Self {
        Self {
            is_cancelled: None,
            report_progress: None,
        }
    }
}

impl JobCtx<'_> {
    /// 任务是否已被取消
    pub fn cancelled(&self) -> bool {
        self.is_cancelled.map_or(false, |f| f())
    }

    /// 广播进度（0.0–1.0；未注入回调时静默跳过）
    pub fn progress(&self, progress: f64, message: &str) {
        if let Some(report) = self.report_progress {
            report(progress, message);
        }
    }
}

/// 公共预检的就绪上下文：校验/兜底结果 + 渠道强类型参数，渠道管线直接消费
pub struct Prepared {
    pub job: BuildJob,
    pub root_path: PathBuf,
    /// 产物输出目录（已解析默认值与覆盖目录）
    pub out: PathBuf,
    /// 兜底后的主场景（项目相对路径）
    pub main_scene: String,
    /// 渠道参数（管线 resolve 已归一；与管线的配对由工厂保证）
    pub channel: super::options::ResolvedChannel,
}

/// 产物内单场景条目（前端结果展示用）
#[derive(Serialize, Clone, Debug)]
pub struct PackedScene {
    /// 场景显示名（去扩展名的文件名，重名自动加序号；?scene= 参数用它）
    pub name: String,
    /// 项目内相对路径（.scene 文件）
    pub rel: String,
    /// 产物内相对文件（scenes/<name>.json）
    pub file: String,
}

/// 构建结果（自描述；前端结果展示用）
#[derive(Serialize, Debug)]
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
