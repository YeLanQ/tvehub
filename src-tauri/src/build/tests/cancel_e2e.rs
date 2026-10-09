//! 取消路径：JobCtx 注入取消检查，验证 run_build 的取消检查点真正生效
//! （既有 e2e 全部走 JobCtx::default()——永不取消，取消路径此前零覆盖）。

use std::cell::Cell;
use std::collections::HashMap;
use std::fs;

use crate::build::{run_build, BuildJob, JobCtx};

/// 搭最小临时项目（同 e2e.rs 夹具的缩减版：一场景 + 一材质 + 入口运行时）
fn scaffold_project(tag: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("tve-build-cancel-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("assets/materials")).unwrap();
    fs::write(
        root.join("assets/materials/M.mat"),
        r#"{"$type":"material","name":"M"}"#,
    )
    .unwrap();
    fs::write(
        root.join("assets/Main.scene"),
        r#"{"type":"scene","root":{"type":"node","childIds":[],"children":[{"type":"meshNode","source":"primitive","material":"assets/materials/M.mat"}]}}"#,
    )
    .unwrap();
    root
}

fn web_job(root: &std::path::Path) -> BuildJob {
    BuildJob {
        root: root.display().to_string(),
        channel: "web".into(),
        scenes: vec!["assets/Main.scene".to_string()],
        main_scene: "assets/Main.scene".into(),
        title: "T".into(),
        debug: false,
        single_page: false,
        gzip: false,
        release: false,
        cdn: false,
        gzip_base: String::new(),
        cdn_base: String::new(),
        files: HashMap::from([
            ("index.html".to_string(), "<html><body></body></html>".to_string()),
            ("player.mjs".to_string(), "// player\n".to_string()),
        ]),
        out_dir: None,
        wechat_appid: None,
        wechat_orientation: None,
        wechat_subpackages: None,
        wechat_subpackage_size: None,
        wechat_diag: None,
    }
}

/// 构建开始前已取消：公共预检处立即失败
#[test]
fn cancel_before_build_fails_fast() {
    let root = scaffold_project("early");
    let cancelled = Cell::new(true);
    let cancel_check = || cancelled.get();
    let ctx = JobCtx {
        is_cancelled: Some(&cancel_check),
        report_progress: None,
    };
    let err = run_build(web_job(&root), &ctx).expect_err("已取消的构建必须失败");
    assert_eq!(err, "任务已取消");
    assert!(!root.join("build/web").exists(), "取消后不落任何产物");
    let _ = fs::remove_dir_all(&root);
}

/// 收集阶段后取消：进度回调把 0.15（COLLECT）锚点之后的任务标记为取消，
/// 管线在组装前的检查点拦截——验证检查点位于收集与写盘之间真实生效
#[test]
fn cancel_after_collect_aborts_before_write() {
    let root = scaffold_project("mid");
    let cancelled = Cell::new(false);
    let cancel_check = || cancelled.get();
    let progress = |p: f64, _m: &str| {
        if p >= 0.15 {
            cancelled.set(true);
        }
    };
    let ctx = JobCtx {
        is_cancelled: Some(&cancel_check),
        report_progress: Some(&progress),
    };
    let err = run_build(web_job(&root), &ctx).expect_err("收集中途取消必须失败");
    assert_eq!(err, "任务已取消");
    assert!(!root.join("build/web").exists(), "取消后不落任何产物");
    let _ = fs::remove_dir_all(&root);
}
