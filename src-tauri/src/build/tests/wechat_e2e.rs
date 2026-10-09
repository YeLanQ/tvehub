//! 微信小游戏渠道端到端：搭最小临时项目跑 wechat 管线，校验包结构、数据内联、
//! 用户脚本小写化、appid 继承链、屏幕方向、物理引擎随包与能力边界报错。

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
        // meshopt 解码 wasm（bundle 内联依赖的随包资产，base64 过 IPC）
        (
            "engine/runtime/loaders/meshopt_decoder.wasm".to_string(),
            "AGFzbQ==".to_string(),
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
        wechat_subpackages: None,
        wechat_subpackage_size: None,
        wechat_diag: None,
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
    // 资产文件化 2.0：assets/ 目录只允许 uid 文件名（16 位哈希 + 白名单扩展名，
    // 文件化命名见 pack::asset_file_name）；原始资产路径（如 textures/a.png）不得散落
    let uid_file = |name: &str| -> bool {
        let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
        let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
        stem.len() == 16 && stem.chars().all(|c| c.is_ascii_hexdigit())
            && ["png", "jpg", "gif", "webp", "mp3", "wav", "ogg", "m4a", "bin"].contains(&ext)
    };
    if out.join("assets").is_dir() {
        for entry in fs::read_dir(out.join("assets")).unwrap() {
            let entry = entry.unwrap();
            assert!(
                entry.file_type().unwrap().is_file() && uid_file(&entry.file_name().to_string_lossy()),
                "assets/ 下应只有 uid 文件名的文件化资产: {:?}",
                entry.file_name()
            );
        }
    }

    // game.js 入口仅 require code.js；game.json 屏幕方向缺省 portrait
    let game_js = fs::read_to_string(out.join("game.js")).unwrap();
    assert!(game_js.contains("require(\"./code.js\")"), "入口应只装载 bundle");
    // 真机诊断开关：缺省（不勾选）= 携带清键自愈语句（上一轮开启的设备 storage
    // 残留被清掉），且不写 "1"
    assert!(game_js.contains("delete __tveBox.__tveDiagOn"), "缺省导出应清诊断开关");
    assert!(!game_js.contains("__tveDiagOn = \"1\""), "缺省导出不应打开诊断");
    let game_json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(out.join("game.json")).unwrap()).unwrap();
    assert_eq!(game_json["deviceOrientation"], "portrait");
    // Worker 未随包 → game.json 不声明 workers 字段（声明而无目录会令工具编译失败）
    assert!(
        game_json.get("workers").is_none(),
        "未随包 worker 时 game.json 不应声明 workers 字段"
    );
    // 分包未启用（缺省）→ 不声明 subpackages，资产留主包 assets/
    assert!(
        game_json.get("subpackages").is_none(),
        "未启用分包时 game.json 不应声明 subpackages 字段"
    );

    // project.config.json：游客 appid + compileType game + condition 槽位
    let pcfg: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(out.join("project.config.json")).unwrap()).unwrap();
    assert_eq!(pcfg["compileType"], "game");
    assert_eq!(pcfg["appid"], "touristappid");
    assert!(pcfg["condition"]["game"].is_object(), "condition 必须带小游戏槽位");
    let private: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(out.join("project.private.config.json")).unwrap()).unwrap();
    assert_eq!(private["condition"], serde_json::json!({}), "私有配置 condition 必须为空");

    // data.js：config（含 scriptGraph 标记）+ 场景/文本资产 base64 内联 + 资产
    // 文件化清单（assetFiles：rel → 包内文件路径；二进制不交 base64 税）
    let data = fs::read_to_string(out.join("data.js")).unwrap();
    assert!(data.starts_with("module.exports = "), "data.js 必须是 CJS 模块");
    assert!(data.contains("\"scriptGraph\":\"./script-graph.json\""), "图文件存在时 config 应标记 scriptGraph");
    assert!(data.contains("\"scenes/Main.json\""), "场景应进内联资产表");
    assert!(data.contains("\"assets/materials/M.mat\""), "文本材质应进内联资产表");
    assert!(data.contains("\"assetFiles\""), "data.js 应携带资产文件化清单");
    // 二进制贴图文件化：清单映射 assets/<uid>.png，data.js 不再含其 base64（[1,2,3,4] → AQIDBA==）
    assert!(
        data.contains("\"assets/textures/a.png\":\"assets/"),
        "二进制贴图应出现在 assetFiles 清单"
    );
    assert!(!data.contains("AQIDBA=="), "二进制资产不应再 base64 内联（税已移除）");
    // 落盘文件为原始字节（[1,2,3,4]），扩展名白名单内保留 .png（assets/ 目录）
    let af_dir = out.join("assets");
    let af_names: Vec<String> = fs::read_dir(&af_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(af_names.len(), 1, "assets/ 文件化资产应只有一个");
    assert!(af_names[0].ends_with(".png"), "白名单扩展名应保留: {}", af_names[0]);
    let png_bytes = fs::read(af_dir.join(&af_names[0])).unwrap();
    assert_eq!(png_bytes, vec![1u8, 2, 3, 4], "文件化资产应为原始字节");

    // meshopt wasm 按 base64 解码为二进制写盘（"AGFzbQ==" = [0,97,115,109]）
    let meshopt = fs::read(out.join("engine/runtime/loaders/meshopt_decoder.wasm"))
        .unwrap_or_else(|e| panic!("meshopt wasm 应按二进制写盘: {e}"));
    assert_eq!(
        meshopt,
        vec![0u8, 0x61, 0x73, 0x6d],
        "meshopt wasm 应为 base64 解码后的原始字节"
    );

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
fn wechat_diag_switch_baked_into_entry() {
    let base = std::env::temp_dir().join(format!("tve-wechat-diag-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let root = setup_project(&base);

    // 勾选（无分包形态）
    let job = BuildJob {
        wechat_diag: Some(true),
        ..wechat_job(&root, wechat_files())
    };
    let result = run_build(job, &JobCtx::default())
        .unwrap_or_else(|e| panic!("诊断勾选构建失败: {e}"));
    assert!(result.ok);
    // 勾选 = game.js 启动即写开启开关（盒中盒同模式），且无清键语句
    let game_js = fs::read_to_string(root.join("build/wechat/game.js")).unwrap();
    assert!(game_js.contains("__tveDiagOn = \"1\""), "勾选诊断应写开启开关");
    assert!(!game_js.contains("delete __tveBox.__tveDiagOn"), "勾选诊断不应清键");

    // 勾选（分包形态）：诊断语句必须在分包预加载之前（此前分包形态漏插）
    let big = vec![7u8; 800 * 1024];
    for name in ["a.png", "b.png", "c.png"] {
        fs::write(root.join("assets/textures").join(name), &big).unwrap();
    }
    for (mat, tex) in [("N", "b"), ("O", "c")] {
        fs::write(
            root.join(format!("assets/materials/{mat}.mat")),
            format!(r#"{{"$type":"material","name":"{mat}","map":"assets/textures/{tex}.png"}}"#),
        )
        .unwrap();
    }
    fs::write(
        root.join("assets/Main.scene"),
        r#"{"type":"scene","root":{"type":"node","children":[{"type":"meshNode","material":"assets/materials/M.mat"},{"type":"meshNode","material":"assets/materials/N.mat"},{"type":"meshNode","material":"assets/materials/O.mat"}]}}"#,
    )
    .unwrap();
    let job = BuildJob {
        wechat_diag: Some(true),
        wechat_subpackages: Some(true),
        wechat_subpackage_size: Some(1.0),
        ..wechat_job(&root, wechat_files())
    };
    let result = run_build(job, &JobCtx::default())
        .unwrap_or_else(|e| panic!("诊断+分包构建失败: {e}"));
    assert!(result.ok);
    assert!(result.message.contains("分包"), "应确实走分包形态: {}", result.message);
    let game_js = fs::read_to_string(root.join("build/wechat/game.js")).unwrap();
    assert!(
        game_js.contains("__tveDiagOn = \"1\"") && game_js.contains("loadSubpackage"),
        "分包形态的入口同样要带诊断开关"
    );
    let diag_pos = game_js.find("__tveDiagOn").expect("诊断语句在入口内");
    let load_pos = game_js.find("loadSubpackage").expect("分包预加载在入口内");
    assert!(diag_pos < load_pos, "诊断开关先于分包预加载写入");

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

    // jolt 物理后端 → 构建通过，且后端引擎产物随包（物理后端不设限）
    fs::write(
        root.join("project.config.json"),
        r#"{"physics":{"physicsEnabled":true,"backend":"jolt"}}"#,
    )
    .unwrap();
    let mut files = wechat_files();
    files.insert(
        "engine/runtime/physics-engines/jolt.js".to_string(),
        "// jolt cjs 预转换产物\n".to_string(),
    );
    // .wasm 经 base64 传入（[0,97,115,109,1,0,0,0] = "\0asm\x01\0\0\0"），管线解码为二进制
    files.insert(
        "engine/runtime/physics-engines/jolt.wasm".to_string(),
        "AGFzbQEAAAA=".to_string(),
    );
    run_build(wechat_job(&root, files), &JobCtx::default())
        .unwrap_or_else(|e| panic!("jolt 后端构建应当通过: {e}"));
    let out2 = root.join("build/wechat");
    assert!(
        out2.join("engine/runtime/physics-engines/jolt.js").is_file(),
        "jolt 引擎产物应随包写入"
    );
    let wasm_bytes = fs::read(out2.join("engine/runtime/physics-engines/jolt.wasm"))
        .unwrap_or_else(|e| panic!("jolt wasm 应按二进制写盘: {e}"));
    assert_eq!(
        wasm_bytes,
        vec![0u8, 0x61, 0x73, 0x6d, 1, 0, 0, 0],
        "wasm 应为 base64 解码后的原始字节"
    );
    // 恢复无物理配置，供后续用例使用
    fs::write(root.join("project.config.json"), r#"{"designResolution":{"width":1280,"height":720}}"#).unwrap();

    // Draco 压缩启用 → 已支持（主线程 wasm 内联解码）：构建通过，wrapper + .wasm 随包
    fs::write(
        root.join("project.config.json"),
        r#"{"resources":{"dracoCompression":true}}"#,
    )
    .unwrap();
    let mut draco_files = wechat_files();
    draco_files.insert(
        "engine/runtime/loaders/draco/draco_wasm_wrapper.js".to_string(),
        "var DracoDecoderModule = function() { return Promise.resolve({}); };\nmodule.exports = DracoDecoderModule;\n".to_string(),
    );
    draco_files.insert(
        "engine/runtime/loaders/draco/draco_decoder.wasm".to_string(),
        "AGFzbQEAAAA=".to_string(), // base64("\0asm\1\0\0\0")
    );
    run_build(wechat_job(&root, draco_files), &JobCtx::default())
        .unwrap_or_else(|e| panic!("Draco 启用应构建通过（主线程 wasm 内联解码）: {e}"));
    assert!(
        root.join("build/wechat/engine/runtime/loaders/draco/draco_wasm_wrapper.js").is_file(),
        "Draco wasm 解码器胶水应随包写入"
    );
    assert_eq!(
        fs::read(root.join("build/wechat/engine/runtime/loaders/draco/draco_decoder.wasm")).unwrap(),
        vec![0u8, 0x61, 0x73, 0x6d, 1, 0, 0, 0],
        "Draco wasm 应为 base64 解码后的原始字节"
    );
    // 旧纯 JS 解码器键已下线：白名单不再收（前端清单与管线预期一致才放行）
    let mut legacy_files = wechat_files();
    legacy_files.insert(
        "engine/runtime/loaders/draco/draco_decoder.js".to_string(),
        "var DracoDecoderModule = (() => function() {})();\n".to_string(),
    );
    assert!(
        run_build(wechat_job(&root, legacy_files), &JobCtx::default()).is_err(),
        "旧 draco_decoder.js 键应被白名单拒绝（已切换 wasm 解码器）"
    );

    // Basis 纹理压缩 → 仍不支持（KTX2Loader 依赖 Worker）
    fs::write(
        root.join("project.config.json"),
        r#"{"resources":{"textureCompression":true}}"#,
    )
    .unwrap();
    let err = expect_err(run_build(wechat_job(&root, wechat_files()), &JobCtx::default()));
    assert!(err.contains("Basis"), "Basis 启用应报不支持: {err}");

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn wechat_release_levers() {
    // release/debug 差异面核实（用户可见口径：release 不应「什么都不做」）：
    // 杠杆 1 = 用户脚本压缩（code.js 等预构建产物与模式无关，仓库构建期已压缩）；
    // 杠杆 2 = data.js 的 config.debug 位。同项目双跑对比两处落盘结果。
    let base = std::env::temp_dir().join(format!("tve-wechat-rel-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let root = setup_project(&base);
    let out = root.join("build/wechat");

    // 带注释与空白的胖脚本（压缩杠杆的可观测量）
    let fat_script = "// 入口说明注释\n".to_string()
        + &"// 说明行\nconst speed = 10; \nconst jump  =  5;\n".repeat(40)
        + "module.exports = { speed, jump };\n";
    let mut files = wechat_files();
    files.insert("src/Main.js".to_string(), fat_script);

    // debug 构建
    run_build(wechat_job(&root, files.clone()), &JobCtx::default()).unwrap();
    let debug_script = fs::read_to_string(out.join("src/main.js")).unwrap();
    let debug_data = fs::read_to_string(out.join("data.js")).unwrap();
    let mut debug_files: Vec<(String, usize)> = fs::read_dir(&out)
        .unwrap()
        .map(|e| {
            let p = e.unwrap().path();
            let rel = p.file_name().unwrap().to_string_lossy().into_owned();
            (rel, fs::metadata(&p).unwrap().len() as usize)
        })
        .collect();
    debug_files.sort();

    // release 构建
    let job = BuildJob {
        debug: false,
        release: true,
        ..wechat_job(&root, files)
    };
    run_build(job, &JobCtx::default()).unwrap();
    let release_script = fs::read_to_string(out.join("src/main.js")).unwrap();
    let release_data = fs::read_to_string(out.join("data.js")).unwrap();
    let mut release_files: Vec<(String, usize)> = fs::read_dir(&out)
        .unwrap()
        .map(|e| {
            let p = e.unwrap().path();
            let rel = p.file_name().unwrap().to_string_lossy().into_owned();
            (rel, fs::metadata(&p).unwrap().len() as usize)
        })
        .collect();
    release_files.sort();
    for (name, dsize) in &debug_files {
        if let Some((_, rsize)) = release_files.iter().find(|(n, _)| n == name) {
            if dsize != rsize {
                eprintln!("[diff] {name}: debug {dsize} B → release {rsize} B");
            }
        }
    }

    // 杠杆 1：脚本被压缩（注释/空白消失，体积下降）
    assert!(
        release_script.len() < debug_script.len() && !release_script.contains("//"),
        "release 应压缩用户脚本（debug {} B → release {} B）",
        debug_script.len(),
        release_script.len()
    );
    // 杠杆 2：data.js 仅差 debug 位
    assert!(debug_data.contains("\"debug\":true"), "debug 构建 config 应带 debug:true");
    assert!(release_data.contains("\"debug\":false"), "release 构建 config 应带 debug:false");
    // 口径说明：包体总量不保证 release ≤ debug——release 的资产 uid 重命名以
    // 身份稳定为先（.meta uuid / 16 位路径哈希），短路径会被拉长（微型项目可
    // 反增几十字节）；体积收益主要来自模型二进制化与脚本压缩，在有真实资产
    // 的项目上体现。预构建运行时（code.js/引擎）与模式无关，debug/release 的
    // 包体 KB 级一致属预期。
    eprintln!(
        "[wechat_release_levers] 包体对比：debug {} B → release {} B（脚本 {} B → {} B）",
        debug_files.iter().map(|(_, s)| s).sum::<usize>(),
        release_files.iter().map(|(_, s)| s).sum::<usize>(),
        debug_script.len(),
        release_script.len()
    );

    let _ = fs::remove_dir_all(&base);
}

/// 物理 Worker bundle 随包：workers/tve.js 进包 + game.json 声明 workers 字段
/// （wx.createWorker 依赖声明；声明而无目录会令开发者工具编译失败，故按实际
/// 随包条件写入——见 pack::game_json）
#[test]
fn wechat_worker_bundle_in_package() {
    let base = std::env::temp_dir().join(format!("tve-wechat-worker-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let root = setup_project(&base);

    let mut files = wechat_files();
    files.insert(
        "workers/tve.js".to_string(),
        "// tve wechat physics worker bundle\n".to_string(),
    );
    run_build(wechat_job(&root, files), &JobCtx::default())
        .unwrap_or_else(|e| panic!("含 Worker bundle 的微信构建失败: {e}"));

    let out = root.join("build/wechat");
    assert!(out.join("workers/tve.js").is_file(), "worker bundle 应随包落盘");
    let game_json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(out.join("game.json")).unwrap()).unwrap();
    assert_eq!(game_json["workers"], "workers", "随包 worker 时 game.json 应声明 workers 字段");

    let _ = fs::remove_dir_all(&base);
}

/// 分包选项：文件化二进制资产按体积分入 pkg-N 分包——game.json 声明
/// subpackages、game.js 启动前预加载、data.js 清单带分包前缀、原始字节落盘
/// 分包目录；运行时文件与场景文本留主包。未启用时保持单包形态（在
/// wechat_export_end_to_end 内断言无 subpackages 字段与主包 assets/）。
#[test]
fn wechat_subpackage_split() {
    let base = std::env::temp_dir().join(format!("tve-wechat-subpkg-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let root = setup_project(&base);
    // 三张 800KB 贴图各挂一个材质、三个 meshNode 引用（1MB 分包上限下
    // 贪心装箱 → 一贴图一分包）
    let big = vec![7u8; 800 * 1024];
    for name in ["a.png", "b.png", "c.png"] {
        fs::write(root.join("assets/textures").join(name), &big).unwrap();
    }
    for (mat, tex) in [("N", "b"), ("O", "c")] {
        fs::write(
            root.join(format!("assets/materials/{mat}.mat")),
            format!(r#"{{"$type":"material","name":"{mat}","map":"assets/textures/{tex}.png"}}"#),
        )
        .unwrap();
    }
    fs::write(
        root.join("assets/Main.scene"),
        r#"{"type":"scene","root":{"type":"node","children":[{"type":"meshNode","material":"assets/materials/M.mat"},{"type":"meshNode","material":"assets/materials/N.mat"},{"type":"meshNode","material":"assets/materials/O.mat"}]}}"#,
    )
    .unwrap();

    let job = BuildJob {
        wechat_subpackages: Some(true),
        wechat_subpackage_size: Some(1.0),
        wechat_diag: None,
        ..wechat_job(&root, wechat_files())
    };
    let result = run_build(job, &JobCtx::default())
        .unwrap_or_else(|e| panic!("分包构建失败: {e}"));
    assert!(result.ok);
    assert!(result.message.contains("分包"), "结果消息应报告分包统计: {}", result.message);

    let out = root.join("build/wechat");
    // game.json：三个分包声明（root 与 name 同值）
    let game_json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(out.join("game.json")).unwrap()).unwrap();
    assert_eq!(
        game_json["subpackages"],
        serde_json::json!([
            { "root": "pkg-1", "name": "pkg-1" },
            { "root": "pkg-2", "name": "pkg-2" },
            { "root": "pkg-3", "name": "pkg-3" }
        ]),
        "三张 800KB 贴图在 1MB 上限下应分三个分包"
    );

    // game.js：启动前预加载全部分包（roots 字面量 + loadSubpackage + 进游戏）
    let game_js = fs::read_to_string(out.join("game.js")).unwrap();
    assert!(game_js.contains("[\"pkg-1\",\"pkg-2\",\"pkg-3\"]"), "入口应内嵌分包 root 清单");
    assert!(game_js.contains("loadSubpackage"), "入口应经 loadSubpackage 预加载分包");
    assert!(game_js.contains("require(\"./code.js\")"), "预加载完成后应进游戏");

    // data.js 清单带分包前缀；原始字节落盘分包目录；主包 assets/ 消失
    let data = fs::read_to_string(out.join("data.js")).unwrap();
    assert!(data.contains("\"assets/textures/a.png\":\"pkg-1/assets/"), "清单应带分包前缀");
    assert!(
        !data.contains("\"assets/textures/a.png\":\"assets/"),
        "启用分包后不应再有主包形态映射"
    );
    for pkg in ["pkg-1", "pkg-2", "pkg-3"] {
        // 分包根目录必须有 game.js（开发者工具静态校验，缺失报「未找到 root 对应
        // 的 /pkg-N/game.js」）
        assert!(out.join(pkg).join("game.js").is_file(), "{pkg} 应含入口 game.js 桩");
        let dir = out.join(pkg).join("assets");
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("{pkg}/assets 应存在: {e}"))
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 1, "{pkg} 应恰好一个文件化资产: {names:?}");
        assert_eq!(fs::read(dir.join(&names[0])).unwrap(), big, "分包资产应为原始字节");
    }
    assert!(!out.join("assets").exists(), "全部分包后主包不应再有 assets/ 目录");

    // 运行时文件留主包（分包只装文件化资产）
    assert!(
        out.join("engine/runtime/loaders/meshopt_decoder.wasm").is_file(),
        "运行时 wasm 应留主包"
    );
    assert!(out.join("code.js").is_file() && out.join("data.js").is_file());

    // 未启用（缺省 false）→ 单包形态回退：无 subpackages 声明，资产回主包 assets/
    run_build(wechat_job(&root, wechat_files()), &JobCtx::default()).unwrap();
    let game_json2: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(out.join("game.json")).unwrap()).unwrap();
    assert!(game_json2.get("subpackages").is_none(), "未启用分包不应声明 subpackages");
    assert!(out.join("assets").is_dir(), "未启用分包资产应回主包 assets/");

    let _ = fs::remove_dir_all(&base);
}

/// resolve 归一化：分包体积钳到 1..=4 MB、开关缺省 false
#[test]
fn wechat_resolve_normalizes_subpackage_options() {
    let base = std::env::temp_dir().join(format!("tve-wechat-resolve-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let root = setup_project(&base);
    use crate::build::channels::wechat::WechatPipeline;
    use crate::build::options::ResolvedChannel;
    use crate::build::pipeline::ChannelPipeline;

    let job = BuildJob {
        wechat_subpackages: Some(true),
        wechat_subpackage_size: Some(9.6),
        wechat_diag: None,
        ..wechat_job(&root, wechat_files())
    };
    match WechatPipeline.resolve(&job) {
        ResolvedChannel::Wechat(p) => {
            assert!(p.subpackages);
            assert_eq!(p.subpackage_size, 4, "分包体积应钳到上限 4 MB");
        }
        _ => panic!("微信管线 resolve 应返回微信参数"),
    }
    match WechatPipeline.resolve(&wechat_job(&root, wechat_files())) {
        ResolvedChannel::Wechat(p) => {
            assert!(!p.subpackages, "分包开关缺省 false");
            assert_eq!(p.subpackage_size, 2, "分包体积缺省 2 MB");
        }
        _ => panic!("微信管线 resolve 应返回微信参数"),
    }
    let _ = fs::remove_dir_all(&base);
}
