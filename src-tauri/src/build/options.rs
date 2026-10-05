//! 渠道选项分型：BuildJob 的扁平字段是前端 IPC 契约的镜像（与 api.buildExport
//! 一一对应，不改 IPC）；渠道专属字段在管线的 resolve 阶段一次性解析归一为
//! 强类型参数（ResolvedChannel），通用编排层从此不感知任何渠道专属字段——
//! 消灭「web 渠道被迫透传 wechat_* 字段、微信管线硬编码 false」的混型状态。

/// web 渠道产物参数（地址已归一化）
pub struct WebParams {
    /// 产物形态：true = 单页（数据内联 index.html）/ false = 多文件
    pub single_page: bool,
    /// 资产 gzip 归档（多文件写 assets.gzip；单页 base64 内联）
    pub gzip: bool,
    /// CDN 模式实际生效（cdn 开启且 Three 地址非空）
    pub cdn_active: bool,
    /// 归一化后的 gzip 归档远程基址（空 = 本地读取）
    pub gzip_base: String,
    /// 归一化后的 Three CDN 基址（空 = 内嵌 three.js）
    pub three_base: String,
}

/// 微信小游戏渠道参数（orientation 已归一化为 portrait/landscape）
pub struct WechatParams {
    /// AppID（None = 走「上次产物继承 > touristappid」链，见 pack::resolve_appid）
    pub appid: Option<String>,
    /// 屏幕方向（"portrait" / "landscape"，缺省 portrait）
    pub orientation: String,
}

/// 公共预检后交付渠道管线的渠道参数。渠道与参数的配对由工厂保证
/// （channel_pipeline 只把 WebParams 交给 WebPipeline），错配即程序性缺陷。
pub enum ResolvedChannel {
    Web(WebParams),
    Wechat(WechatParams),
}

impl ResolvedChannel {
    /// web 渠道参数（渠道错配 = 工厂配对被破坏，立即暴露）
    pub fn web(&self) -> &WebParams {
        match self {
            Self::Web(w) => w,
            _ => panic!("web 管线收到非 web 渠道参数（工厂配对被破坏）"),
        }
    }

    /// 微信渠道参数（同上）
    pub fn wechat(&self) -> &WechatParams {
        match self {
            Self::Wechat(w) => w,
            _ => panic!("微信管线收到非微信渠道参数（工厂配对被破坏）"),
        }
    }
}
