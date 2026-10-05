//! 渠道公共收尾：项目配置读取、主场景显示名解析、产物写盘与 BuildResult 组装。
//! web/wechat 编排层唯一的落盘与结果出口——两渠道不再各写一份
//! （历史上发生过「只改一头」的漂移，如 release 压缩曾仅 web 生效）。

use std::collections::HashMap;
use std::path::Path;

use super::job::{BuildResult, JobCtx, PackedScene, Prepared};
use super::pipeline::progress;

/// 读取项目配置 project.config.json。缺失或解析失败降级为 Value::Null：
/// 产物 config 与 player 对缺字段全有默认值，与编辑器内预览行为一致
/// （有意降级而非吞错——配置损坏的项目仍可构建，字段走默认）。
pub(super) fn read_project_config(root: &Path) -> serde_json::Value {
    std::fs::read_to_string(root.join("project.config.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// 主场景显示名（config.scenes 按名引用、?scene= 参数用它；找不到时为空）
pub(super) fn main_scene_name(packed: &[PackedScene], main_scene: &str) -> String {
    packed
        .iter()
        .find(|s| s.rel == main_scene)
        .map(|s| s.name.clone())
        .unwrap_or_default()
}

/// 产物写盘统一收口：写盘前取消检查 → 写入进度锚点 → 原子换入落盘
pub(super) fn write_products(
    prepared: &Prepared,
    files: HashMap<String, String>,
    binaries: &HashMap<String, Vec<u8>>,
    ctx: &JobCtx,
) -> Result<(), String> {
    if ctx.cancelled() {
        return Err("任务已取消".into());
    }
    ctx.progress(progress::WRITE, "写入产物");
    crate::scene_pack::write_export_dir(&prepared.out, files, binaries)
        .map_err(|e| format!("写入构建产物失败: {e}"))
}

/// BuildResult 组装草稿：渠道只填形态字段与统计，公共字段由收尾层从
/// Prepared 补齐（ok/channel/output_dir/main_scene/release）
pub(super) struct ResultDraft {
    pub packed: Vec<PackedScene>,
    /// 主场景显示名
    pub main_name: String,
    /// release 生效产物：被二进制化的模型
    pub bin_converted: Vec<String>,
    /// 资产总数（口径两渠道一致：场景+文本+二进制；web 单页/gzip 有代码条目修正）
    pub assets_packed: usize,
    pub missing: Vec<String>,
    /// 渠道产物形态三态（微信全 false）
    pub single_page: bool,
    pub gzip: bool,
    pub cdn: bool,
    pub message: String,
}

/// 组装最终 BuildResult
pub(super) fn finish_result(prepared: &Prepared, draft: ResultDraft) -> BuildResult {
    BuildResult {
        ok: true,
        channel: prepared.job.channel.clone(),
        output_dir: prepared.out.display().to_string(),
        main_scene: prepared.main_scene.clone(),
        main_scene_name: draft.main_name,
        scenes: draft.packed,
        single_page: draft.single_page,
        gzip: draft.gzip,
        release: prepared.job.release,
        cdn: draft.cdn,
        bin_converted: draft.bin_converted,
        assets_packed: draft.assets_packed,
        missing: draft.missing,
        message: draft.message,
    }
}

#[cfg(test)]
mod tests {
    use super::{main_scene_name, read_project_config};
    use crate::build::job::PackedScene;

    #[test]
    fn main_scene_name_finds_packed_scene() {
        let packed = vec![PackedScene {
            name: "Main".into(),
            rel: "assets/Main.scene".into(),
            file: String::new(),
        }];
        assert_eq!(main_scene_name(&packed, "assets/Main.scene"), "Main");
        assert_eq!(main_scene_name(&packed, "assets/Missing.scene"), "", "未选中场景显示名为空");
    }

    #[test]
    fn project_config_missing_or_broken_degrades_to_null() {
        let dir = std::env::temp_dir().join(format!("tve-fin-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(read_project_config(&dir).is_null(), "缺失配置降级 Null");
        std::fs::write(dir.join("project.config.json"), "{broken").unwrap();
        assert!(read_project_config(&dir).is_null(), "损坏配置降级 Null");
        std::fs::write(dir.join("project.config.json"), r#"{"debug":true}"#).unwrap();
        assert_eq!(read_project_config(&dir)["debug"], serde_json::Value::Bool(true));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
