//! 跨渠道一致性 e2e：同一项目同场景同参数，分别以 web（多文件）与 wechat 构建，
//! 断言导出内容内核（content.rs）产物的跨渠道一致性——场景清单、缺失清单、
//! 模型 bin 转换、资产键集合、资产内容（解码后字节）、release 生效形态、
//! assets_packed 口径，全部逐项一致。

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

use crate::build::{run_build, BuildJob, JobCtx};

fn setup_project(base: &Path) -> std::path::PathBuf {
    let root = base.join("proj");
    fs::create_dir_all(root.join("assets/materials")).unwrap();
    fs::create_dir_all(root.join("assets/textures")).unwrap();
    fs::create_dir_all(root.join("assets/models")).unwrap();
    fs::create_dir_all(root.join("assets/logic")).unwrap();
    fs::write(
        root.join("project.config.json"),
        r#"{"designResolution":{"width":1280,"height":720}}"#,
    )
    .unwrap();

    // 材质（.meta uuid 重命名）+ 贴图（哈希回退）+ glb 模型（release 二进制化）
    // + 逻辑资产（settings.asset 引用）
    fs::write(
        root.join("assets/materials/M.mat"),
        r#"{"$type":"material","map":"assets/textures/a.png"}"#,
    )
    .unwrap();
    fs::write(
        root.join("assets/materials/M.mat.meta"),
        r#"{"uuid":"11111111-2222-3333-4444-555555555555"}"#,
    )
    .unwrap();
    fs::write(root.join("assets/textures/a.png"), [9u8; 8]).unwrap();
    fs::write(root.join("assets/models/cube.glb"), b"glTFfake-glb-bytes").unwrap();
    fs::write(root.join("assets/logic/Patrol.fsm"), r#"{"states":[{"id":"s1"}]}"#).unwrap();
    fs::write(root.join("assets/logic/Tree.bt"), r#"{"tree":{"type":"sequence"}}"#).unwrap();

    fs::write(
        root.join("assets/Main.scene"),
        r#"{"type":"scene","root":{"type":"node","children":[{"type":"meshNode","source":"primitive","material":"assets/materials/M.mat"},{"type":"meshNode","source":"model","model":"assets/models/cube.glb"},{"type":"fsmRunnerNode","settings":{"asset":"assets/logic/Patrol.fsm","autoStart":true}},{"type":"btRunnerNode","settings":{"asset":"assets/logic/Tree.bt","autoStart":false}}]}}"#,
    )
    .unwrap();
    root
}

/// 各渠道前端传入的运行时文件（web = ESM 多文件；wechat = 预构建 bundle + CJS 脚本）
fn runtime_files(channel: &str) -> HashMap<String, String> {
    if channel == "web" {
        return HashMap::from([
            ("index.html".to_string(), "<html></html>".to_string()),
            ("player.mjs".to_string(), "// player\nimport { A } from \"./engine/helper.mjs\";\nconsole.log(A);\n".to_string()),
            ("engine/helper.mjs".to_string(), "// helper\nexport const A = 1;\n".to_string()),
            ("src/main.js".to_string(), "// entry script\nconsole.log(\"hi\");\n".to_string()),
        ]);
    }
    HashMap::from([
        ("code.js".to_string(), "// tve wechat bundle\n".to_string()),
        (
            "engine/core/tve.js".to_string(),
            "module.exports = require(\"../../code.js\").__tveFacade;\n".to_string(),
        ),
        ("src/main.js".to_string(), "// entry script\nconsole.log(\"hi\");\n".to_string()),
    ])
}

fn job(root: &Path, channel: &str, release: bool) -> BuildJob {
    BuildJob {
        root: root.display().to_string(),
        channel: channel.into(),
        scenes: vec!["assets/Main.scene".into()],
        main_scene: "assets/Main.scene".into(),
        title: String::new(),
        debug: true,
        single_page: false,
        gzip: false,
        release,
        cdn: false,
        gzip_base: String::new(),
        cdn_base: String::new(),
        files: runtime_files(channel),
        out_dir: None,
        wechat_appid: None,
        wechat_orientation: None,
    }
}

/// 解析 wechat 包 data.js（module.exports = {...}）为 JSON
fn parse_data_js(text: &str) -> serde_json::Value {
    let body = text
        .trim()
        .strip_prefix("module.exports = ")
        .expect("data.js 必须以 module.exports 开头")
        .trim()
        .trim_end_matches(';');
    serde_json::from_str(body).expect("data.js 必须是合法 JSON 字面量")
}

/// 递归收集目录下 scenes/ 与 assets/ 前缀的产物键（正斜杠相对路径）
fn collect_content_keys(root: &Path, dir: &Path, out: &mut BTreeSet<String>) {
    let entries: Vec<_> = match fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
        Err(e) => panic!("遍历产物目录失败 {:?}: {}", dir, e),
    };
    for p in entries {
        let rel = p
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if p.is_dir() {
            collect_content_keys(root, &p, out);
        } else if rel.starts_with("scenes/") || rel.starts_with("assets/") {
            out.insert(rel);
        }
    }
}


#[test]
fn export_content_consistent_across_channels() {
    let base = std::env::temp_dir().join(format!("tve-consistency-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let root = setup_project(&base);

    for release in [false, true] {
        let web = run_build(job(&root, "web", release), &JobCtx::default())
            .unwrap_or_else(|e| panic!("web(release={release}) 构建失败: {e}"));
        let wx = run_build(job(&root, "wechat", release), &JobCtx::default())
            .unwrap_or_else(|e| panic!("wechat(release={release}) 构建失败: {e}"));

        // 场景清单逐项一致
        assert_eq!(web.scenes.len(), wx.scenes.len(), "场景数一致(release={release})");
        for (a, b) in web.scenes.iter().zip(&wx.scenes) {
            assert_eq!((a.name.as_str(), a.rel.as_str(), a.file.as_str()), (b.name.as_str(), b.rel.as_str(), b.file.as_str()));
        }
        // 缺失/模型转换/口径一致
        assert_eq!(web.missing, wx.missing, "缺失清单一致(release={release})");
        assert_eq!(web.bin_converted, wx.bin_converted, "模型 bin 转换一致(release={release})");
        assert_eq!(
            web.assets_packed, wx.assets_packed,
            "assets_packed 同公式同值(release={release})"
        );

        // 资产键集合一致：web 落盘 scenes/+assets/ == wechat data.js assets 键集
        let web_out = root.join("build/web");
        let wx_out = root.join("build/wechat");
        let mut web_keys = BTreeSet::new();
        collect_content_keys(&web_out, &web_out, &mut web_keys);
        let data = parse_data_js(&fs::read_to_string(wx_out.join("data.js")).unwrap());
        // 资产键集 = data.assets 内联键（场景/小文本）∪ data.assetFiles 文件化键
        // （二进制资产文件化后不再 base64 内联）
        let mut wx_keys: BTreeSet<String> = data["assets"]
            .as_object()
            .expect("data.assets 必须是对象")
            .keys()
            .cloned()
            .collect();
        for key in data["assetFiles"]
            .as_object()
            .expect("data.assetFiles 必须是对象")
            .keys()
        {
            wx_keys.insert(key.clone());
        }
        println!("[dbg] temp={:?} web_out={:?} exists={} web_keys={:?} wx_keys={:?}", std::env::temp_dir(), web_out, web_out.is_dir(), web_keys, wx_keys);
        assert_eq!(web_keys, wx_keys, "资产键集合一致(release={release}) web={web_keys:?} wx={wx_keys:?}");

        // 内容一致：逐键字节级等价（文本资产走 assets 内联；二进制走 assetFiles
        // 指向的 assets/ 包内文件）
        for key in &web_keys {
            let web_bytes = fs::read(web_out.join(key)).unwrap();
            let wx_bytes = match data["assets"][key.as_str()].as_str() {
                Some(b64) => BASE64.decode(b64).unwrap_or_else(|e| panic!("资产 {key} base64 解码失败: {e}")),
                None => {
                    let file = data["assetFiles"][key.as_str()]
                        .as_str()
                        .unwrap_or_else(|| panic!("资产 {key} 既不在 assets 也不在 assetFiles"));
                    fs::read(wx_out.join(file))
                        .unwrap_or_else(|e| panic!("文件化资产 {key}（{file}）读取失败: {e}"))
                }
            };
            assert_eq!(web_bytes, wx_bytes, "资产内容不一致(release={release}): {key}");
        }

        // release 生效形态一致：场景文本跨渠道等价 + 两态对照可辨识
        let web_scene = fs::read_to_string(web_out.join("scenes/Main.json")).unwrap();
        let wx_scene = String::from_utf8(
            BASE64
                .decode(data["assets"]["scenes/Main.json"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(web_scene, wx_scene, "场景内容跨渠道一致(release={release})");
        if release {
            assert!(
                !web_scene.contains("assets/materials/M.mat"),
                "release 后材质引用应重命名"
            );
            assert!(web_scene.contains(".mat"), "重命名后仍保留 .mat 扩展");
        } else {
            assert!(web_scene.contains("assets/materials/M.mat"), "未发布保留原名");
        }

        // config 一致：debug 开关同源
        assert_eq!(data["config"]["debug"], serde_json::Value::Bool(true));

        // release 一致性：用户脚本两渠道同源压缩
        let web_js = fs::read_to_string(web_out.join("src/main.js")).unwrap();
        let wx_js = fs::read_to_string(wx_out.join("src/main.js")).unwrap();
        if release {
            assert!(!web_js.contains("// entry script"), "web release 用户脚本已压缩");
            assert!(!wx_js.contains("// entry script"), "wechat release 用户脚本同源压缩");
        } else {
            assert!(web_js.contains("// entry script") && wx_js.contains("// entry script"));
        }
    }

    let _ = fs::remove_dir_all(&base);
}
