//! 微信渠道能力边界预检：Basis 纹理压缩不支持。
//! 前置到场景收集之前快速失败，报错文案直接指引用户在项目设置里调整。
//! （物理后端不设限：rapier/jolt/ammo 引擎 CJS 产物按项目后端随包，真机 wasm
//! 由桥接层 WebAssembly 垫片经 WXWebAssembly 实例化。Draco 压缩已支持：主线程
//! 内联解码，纯 JS 解码器随包——draco-inline.ts / wechat/draco.mjs。）

use std::fs;
use std::path::Path;

/// 读取项目配置并校验支持范围（配置缺失/解析失败按未启用处理）
pub(super) fn preflight_project(root: &Path) -> Result<(), String> {
    let cfg: serde_json::Value = fs::read_to_string(root.join("project.config.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::Value::Null);
    let resources = cfg.get("resources");
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
