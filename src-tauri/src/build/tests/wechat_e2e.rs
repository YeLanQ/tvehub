//! 微信小游戏渠道端到端：搭最小临时项目跑 wechat 管线，校验包结构、数据内联、
//! 用户脚本小写化、appid 继承链、屏幕方向与 v1 能力边界报错。

use std::collections::HashMap;
use std::fs;

use crate::build::{run_build, BuildJob, JobCtx};

/// 搭最小临时项目（场景 + 材质 + 贴图），返回项目根
fn setup_project(base: &std::path::Path) -> std::path::PathBuf {
    let root = base.join("proj");
    fs::create_dir_all(root.join("assets/materials")).unwrap();
    fs::create_dir_all(root.join("assets/textures")).unwrap();
    fs::write(
        root.join("project.config.json"),
        r#"{"designResolution":{"width":1280,"height":720}}"#,
    )
    .unwrap();
    fs::write(
        root.join("assets/materials/M.mat"),
        r#"{"$type":"material","name":"M","map":"assets/textures/a.png"}"#,
    )
    .unwrap();
    fs::write(root.join("assets/textures/a.png"), [1u8, 2, 3, 4]).unwrap();
    fs::write(
        root.join("assets/Main.scene"),
        r#"{"type":"scene","root":{"type":"node","children":[{"type":"meshNode","material":"assets/materials/M.mat"}]}}"#,
    )
    .unwrap();
    root
}

/// 微信渠道前端传入的运行时文件（模拟 wechat-runtime-files 清单 + CJS 用户脚本）
fn wechat_files() -> HashMap<String, String> {
    HashMap::from([
        ("code.js".to_string(), "// tve wechat bundle\n".to_string()),
        (
            "engine/core/tve.js".to_string(),
            "module.exports = require(\"../../code.js\").__tveFacade;\n".to_string(),
        ),
        // 用户脚本：混合大小写文件名（包内应小写化）
        (
            "src/Main.js".to_string(),
            "const tve = require(\"../../engine/core/tve.js\");\n".to_string(),
        ),
        (
            "src/Util.js".to_string(),
            "module.exports = 1;\n".to_string(),
        ),
        (
            "script-graph.json".to_string(),
            r#"{"nodes":[]}"#.to_string(),
        ),
    ])
}

fn wechat_job(root: &std::path::Path, files: HashMap<String, String>) -> BuildJob {
    BuildJob {
        root: root.display().to_string(),
        channel: "wechat".into(),
        scenes: vec!["assets/Main.scene".to_string()],
        main_scene: "assets/Main.scene".to_string(),
        title: String::new(),
        debug: true,
        single_page: false,
        gzip: false,
        release: false,
        cdn: false,
        gzip_base: String::new(),
        cdn_base: String::new(),
        files,
        out_dir: None,
        wechat_appid: None,
        wechat_orientation: None,
    }
}

#[test]
fn wechat_export_end_to_end() {
    let base = std::env::temp_dir().join(format!("tve-wechat-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let root = setup_project(&base);

    let result = run_build(wechat_job(&root, wechat_files()), &JobCtx::default())
        .unwrap_or_else(|e| panic!("微信渠道构建失败: {e}"));
    assert!(result.ok);
    assert_eq!(result.channel, "wechat");

    let out = root.join("build/wechat");
    // 工程文件四件套 + 运行时 + 用户脚本
    for rel in [
        "game.js",
        "game.json",
        "project.config.json",
        "project.private.config.json",
        "README.txt",
        "code.js",
        "engine/core/tve.js",
        "src/main.js",
        "src/util.js",
        "data.js",
    ] {
        assert!(out.join(rel).is_file(), "缺少包文件 {rel}");
    }
    // 包内不应有 web 渠道形态的产物
    assert!(!out.join("index.html").exists(), "微信包不应有 index.html");
    assert!(!out.join("player.mjs").exists(), "微信包不应有 player.mjs（预构建进 code.js）");
    assert!(!out.join("scenes").exists(), "场景内联进 data.js，不落盘");
    assert!(!out.join("assets").exists(), "资产内联进 data.js，不落盘");

    // game.js 入口仅 require code.js；game.json 屏幕方向缺省 portrait
    let game_js = fs::read_to_string(out.join("game.js")).unwrap();
    assert!(game_js.contains("require(\"./code.js\")"), "入口应只装载 bundle");
    let game_json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(out.join("game.json")).unwrap()).unwrap();
    assert_eq!(game_json["deviceOrientation"], "portrait");

    // project.config.json：游客 appid + compileType game + condition 槽位
    let pcfg: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(out.join("project.config.json")).unwrap()).unwrap();
    assert_eq!(pcfg["compileType"], "game");
    assert_eq!(pcfg["appid"], "touristappid");
    assert!(pcfg["condition"]["game"].is_object(), "condition 必须带小游戏槽位");
    let private: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(out.join("project.private.config.json")).unwrap()).unwrap();
    assert_eq!(private["condition"], serde_json::json!({}), "私有配置 condition 必须为空");

    // data.js：config（含 scriptGraph 标记）+ 资产表（场景/.mat/.png base64）
    let data = fs::read_to_string(out.join("data.js")).unwrap();
    assert!(data.starts_with("module.exports = "), "data.js 必须是 CJS 模块");
    assert!(data.contains("\"scriptGraph\":\"./script-graph.json\""), "图文件存在时 config 应标记 scriptGraph");
    assert!(data.contains("\"scenes/Main.json\""), "场景应进内联资产表");
    assert!(data.contains("\"assets/materials/M.mat\""), "文本材质应进内联资产表");
    assert!(data.contains("\"assets/textures/a.png\""), "二进制贴图应进内联资产表");
    // base64 校验：png 内容 [1,2,3,4] → AQIDBA==
    assert!(data.contains("AQIDBA=="), "二进制资产应 base64 内联");

    // 用户脚本文件名小写化（键折叠，内容不动）；NTFS 大小写不敏感，exists() 会
    // 假阳性，改为列目录断言实际写入名
    let src_names: Vec<String> = fs::read_dir(out.join("src"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        src_names,
        vec!["main.js".to_string(), "util.js".to_string()],
        "包内用户脚本文件名应统一小写"
    );

    // 屏幕方向 landscape
    let job = BuildJob {
        wechat_orientation: Some("landscape".into()),
        ..wechat_job(&root, wechat_files())
    };
    run_build(job, &JobCtx::default()).unwrap();
    let game_json2: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(out.join("game.json")).unwrap()).unwrap();
    assert_eq!(game_json2["deviceOrientation"], "landscape");

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn wechat_appid_inheritance_chain() {
    let base = std::env::temp_dir().join(format!("tve-wechat-appid-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let root = setup_project(&base);
    let out = root.join("build/wechat");

    // 1) 无上次产物、无显式填写 → touristappid（上一测试已覆盖）；此处直接造上次产物
    fs::create_dir_all(&out).unwrap();
    fs::write(
        out.join("project.config.json"),
        r#"{"appid":"wx_previous_001","compileType":"game"}"#,
    )
    .unwrap();
    run_build(wechat_job(&root, wechat_files()), &JobCtx::default()).unwrap();
    let pcfg: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(out.join("project.config.json")).unwrap()).unwrap();
    assert_eq!(pcfg["appid"], "wx_previous_001", "appid 应继承上次产物");

    // 2) 显式填写优先于继承
    let job = BuildJob {
        wechat_appid: Some("wx_explicit_002".into()),
        ..wechat_job(&root, wechat_files())
    };
    run_build(job, &JobCtx::default()).unwrap();
    let pcfg: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(out.join("project.config.json")).unwrap()).unwrap();
    assert_eq!(pcfg["appid"], "wx_explicit_002", "显式 AppID 应最优先");

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn wechat_channel_guards() {
    let base = std::env::temp_dir().join(format!("tve-wechat-guard-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let root = setup_project(&base);
    // BuildResult 未实现 Debug：失败断言统一走 expect_err 风格的 match
    fn expect_err(result: Result<crate::build::BuildResult, String>) -> String {
        match result {
            Err(e) => e,
            Ok(_) => panic!("构建应当失败"),
        }
    }

    // 缺 code.js → 明确报错
    let mut files = wechat_files();
    files.remove("code.js");
    let err = expect_err(run_build(wechat_job(&root, files), &JobCtx::default()));
    assert!(err.contains("code.js"), "缺 bundle 应报 code.js 缺失: {err}");

    // 非预期运行时文件（web 形态混入）→ 明确报错
    let mut files = wechat_files();
    files.insert("index.html".to_string(), "<html></html>".to_string());
    let err = expect_err(run_build(wechat_job(&root, files), &JobCtx::default()));
    assert!(err.contains("index.html"), "web 形态文件混入应报错: {err}");

    // jolt 物理后端 → v1 不支持
    fs::write(
        root.join("project.config.json"),
        r#"{"physics":{"physicsEnabled":true,"backend":"jolt"}}"#,
    )
    .unwrap();
    let err = expect_err(run_build(wechat_job(&root, wechat_files()), &JobCtx::default()));
    assert!(err.contains("rapier"), "jolt 后端应报仅支持 rapier: {err}");

    // Draco 压缩启用 → v1 不支持
    fs::write(
        root.join("project.config.json"),
        r#"{"resources":{"dracoCompression":true}}"#,
    )
    .unwrap();
    let err = expect_err(run_build(wechat_job(&root, wechat_files()), &JobCtx::default()));
    assert!(err.contains("Draco"), "Draco 启用应报不支持: {err}");

    let _ = fs::remove_dir_all(&base);
}
