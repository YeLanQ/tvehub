//! 产物远程地址：Base URL 归一化/拼接 与 three.js CDN 说明符映射（两种产物形态共用）。

use std::collections::HashMap;

/// CDN 模式不内嵌的 three.js 运行时文件（位于 engine/core/；其余引擎模块仍
/// 内嵌，经 import map 把代码里解析到同源 three 的说明符映射到资源地址下的
/// 同名文件）
pub(super) const THREE_RUNTIME_FILES: [&str; 3] = [
    "engine/core/three.core.min.js",
    "engine/core/three.module.min.js",
    "engine/core/three.webgpu.min.js",
];

/// three.js 远程文件 URL：剥离产物内 engine/core/ 目录前缀后拼到基地址下——基地址就是
/// 直接包含 three.module.min.js / three.core.min.js / three.webgpu.min.js 的目录，官方
/// CDN 的版本目录（如 cdnjs / unpkg / jsdelivr 的 three.js/<版本>）与运行时内嵌文件
/// 同名同版本，可直接使用；自建 CDN 把产物 engine/core/ 里三个文件传到某目录后填该目录即可
pub(super) fn three_cdn_url(base: &str, rel: &str) -> String {
    let file = rel.strip_prefix("engine/core/").unwrap_or(rel);
    join_cdn_url(base, file)
}

/// 远程地址归一化：去首尾空白与结尾 '/'；无协议时补 https://
/// （无协议地址会被浏览器按页面相对路径解析，与站点自身地址冲突）
pub(super) fn normalize_base_url(raw: &str) -> String {
    let mut s = raw.trim().trim_end_matches('/').to_string();
    if !s.is_empty() && !s.contains("://") && !s.starts_with("//") {
        s = format!("https://{s}");
    }
    s
}

/// 基地址拼接相对路径，自动去重前缀：地址已以相对路径的首段（目录或文件名，
/// 如 /engine、/assets.gzip）结尾时不再重复拼接，避免 engine/engine、…/assets.gzip/assets.gzip
pub(super) fn join_cdn_url(base: &str, rel: &str) -> String {
    let first = rel.split('/').next().unwrap_or("");
    let trimmed = base.strip_suffix(&format!("/{first}")).unwrap_or(base);
    format!("{trimmed}/{rel}")
}

/// Three CDN 说明符映射表：产物内 three 相对路径 → CDN 绝对 URL（两种产物形态共用）
pub(super) fn three_cdn_remap(three_base: &str) -> HashMap<String, String> {
    THREE_RUNTIME_FILES
        .iter()
        .map(|rel| (rel.to_string(), three_cdn_url(three_base, rel)))
        .collect()
}

#[cfg(test)]
mod tests {
    /// 远程地址归一化与前缀去重拼接（three 剥离产物内 engine/core/ 前缀后拼接）
    #[test]
    fn cdn_url_join_and_normalize() {
        use super::{join_cdn_url, normalize_base_url, three_cdn_url};
        assert_eq!(normalize_base_url("  https://x.com/a/ "), "https://x.com/a");
        assert_eq!(normalize_base_url("x.com/a/"), "https://x.com/a");
        assert_eq!(normalize_base_url("//x.com/a"), "//x.com/a");
        assert_eq!(normalize_base_url("  "), "");
        assert_eq!(
            join_cdn_url("https://x.com/tve", "engine/core/three.module.min.js"),
            "https://x.com/tve/engine/core/three.module.min.js"
        );
        assert_eq!(
            join_cdn_url("https://x.com/tve/libs", "engine/core/three.module.min.js"),
            "https://x.com/tve/libs/engine/core/three.module.min.js"
        );
        assert_eq!(
            join_cdn_url("https://x.com/pkg", "assets.gzip"),
            "https://x.com/pkg/assets.gzip"
        );
        assert_eq!(
            join_cdn_url("https://x.com/pkg/assets.gzip", "assets.gzip"),
            "https://x.com/pkg/assets.gzip"
        );
        // three：剥离 engine/core/ 前缀拼到基地址（官方 CDN 版本目录与自建目录统一规则）
        assert_eq!(
            three_cdn_url("https://c.com/three.js/0.185.1", "engine/core/three.module.min.js"),
            "https://c.com/three.js/0.185.1/three.module.min.js"
        );
        assert_eq!(
            three_cdn_url("https://x.com/tve/libs", "engine/core/three.module.min.js"),
            "https://x.com/tve/libs/three.module.min.js"
        );
    }
}

