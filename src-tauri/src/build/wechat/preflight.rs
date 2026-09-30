//! 微信渠道 v1 能力边界预检：物理仅 rapier；Draco/Basis 压缩资产不支持。
//! 前置到场景收集之前快速失败，报错文案直接指引用户在项目设置里调整。

use std::fs;
use std::path::Path;

/// 读取项目配置并校验 v1 支持范围（配置缺失/解析失败按未启用处理）
pub(super) fn preflight_project(root: &Path) -> Result<(), String> {
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
