//! 产物 config 组装：项目配置（设计分辨率/缩放模式/渲染合成等，player 舞台
//! 直接消费）+ 构建入口信息（mainScene/scenes/debug/scriptGraph/gzipBase）。

use std::collections::HashMap;

use super::job::PackedScene;

/// 由项目配置 + 打包场景推导产物 config（单页内联与多文件落盘共用）
pub(super) fn product_config(
    project_cfg: serde_json::Value,
    packed: &[PackedScene],
    main_name: &str,
    debug: bool,
    files: &HashMap<String, String>,
    gzip_base: &str,
) -> serde_json::Map<String, serde_json::Value> {
    let mut cfg = match project_cfg {
        serde_json::Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    cfg.insert(
        "mainScene".to_string(),
        serde_json::Value::String(main_name.to_string()),
    );
    cfg.insert(
        "scenes".to_string(),
        serde_json::Value::Array(
            packed
                .iter()
                .map(|s| serde_json::json!({ "name": s.name, "file": s.file }))
                .collect(),
        ),
    );
    cfg.insert("debug".to_string(), serde_json::Value::Bool(debug));
    // 场景图注入：前端在 files 中放入 script-graph.json 时，config 标记启用
    // （player 检测到 cfg.scriptGraph 即装配图行为解释器）
    if files.contains_key("script-graph.json") {
        cfg.insert(
            "scriptGraph".to_string(),
            serde_json::Value::String("./script-graph.json".to_string()),
        );
    }
    // gzip 资源地址（gzip 归档远程基址；空 = 本地 assets.gzip）
    if !gzip_base.is_empty() {
        cfg.insert(
            "gzipBase".to_string(),
            serde_json::Value::String(gzip_base.to_string()),
        );
    }
    cfg
}
