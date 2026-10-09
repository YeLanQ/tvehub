//! Tauri 命令 `build_export`：注册任务管理器（取消/进度/多项目隔离），IPC
//! 参数收敛为 BuildJob 后交给 run_build（阻塞段入 spawn_blocking）。

use std::collections::HashMap;

use super::job::{BuildJob, BuildResult, JobCtx};
use super::run_build;

/// 构建导出：打包选中场景 + 引用资产 + 网页运行时到 `<项目>/build/<渠道>/`。
/// files 为前端 fetch 传入的网页运行时文本（index.html/player.mjs/engine/**，
/// 属 WebView 打包资源，编辑器离线可用）；场景与资产由 Rust 直读磁盘。
#[tauri::command]
pub async fn build_export(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::task::TaskManager>,
    root: String,
    channel: String,
    scenes: Vec<String>,
    main_scene: String,
    title: String,
    debug: bool,
    single_page: bool,
    gzip: bool,
    release: bool,
    cdn: bool,
    gzip_base: String,
    cdn_base: String,
    files: HashMap<String, String>,
    out_dir: Option<String>,
    // 微信小游戏渠道专属：AppID（空 = 继承上次产物 > touristappid）、屏幕方向、
    // 分包开关与单个分包体积上限（MB）、真机诊断弹窗开关
    wechat_appid: Option<String>,
    wechat_orientation: Option<String>,
    wechat_subpackages: Option<bool>,
    wechat_subpackage_size: Option<f64>,
    wechat_diag: Option<bool>,
) -> Result<BuildResult, String> {
    // 注册到任务管理器：支持取消 + 进度广播 + 多项目隔离
    let handle = state.register(&app, "export", Some(&root), crate::task::Priority::Normal);
    let cancel_id = handle.id.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let cancel_check = || handle.is_cancelled();
        let ctx = JobCtx {
            is_cancelled: Some(&cancel_check),
            report_progress: Some(&|p, m| handle.report_progress(p, m)),
        };
        let result = run_build(
            BuildJob {
                root,
                channel,
                scenes,
                main_scene,
                title,
                debug,
                single_page,
                gzip,
                release,
                cdn,
                gzip_base,
                cdn_base,
                files,
                out_dir,
                wechat_appid,
                wechat_orientation,
                wechat_subpackages,
                wechat_subpackage_size,
                wechat_diag,
            },
            &ctx,
        );
        // 完成/失败事件统一经 TaskHandle 广播（与 task:progress 同一封装）
        match &result {
            Ok(r) => handle.report_completed(true, &format!("导出完成: {}", r.output_dir)),
            Err(e) => handle.report_completed(false, e),
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?;

    state.deregister(&cancel_id);
    result
}
