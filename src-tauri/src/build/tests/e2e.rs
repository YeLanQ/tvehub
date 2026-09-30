//! 端到端：搭最小临时项目，跑单页/多文件 × gzip 全部形态，校验产物内容。

use std::collections::HashMap;
use std::fs;

use crate::build::{run_build, BuildJob, JobCtx};

/// 端到端：搭一个最小临时项目（场景 + 材质 + 依赖 engine 的运行时），跑
/// 单页/多文件 × gzip 全部形态，校验产物内容：
/// - 单页：产物只剩入口 HTML，运行时代码全部内联（code 字段或 gzip 归档），
///   相对 import 重写为 tve: 裸说明符，模板里的 player.mjs 脚本标签被剥离；
/// - 多文件：场景/资产按相对路径落盘（gzip 时写 assets.gzip）。
#[test]
fn build_export_end_to_end_all_modes() {
    let base = std::env::temp_dir().join(format!("tve-build-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let root = base.join("proj");
    fs::create_dir_all(root.join("assets/materials")).unwrap();
    fs::create_dir_all(root.join("assets/textures")).unwrap();
    fs::write(
        root.join("project.config.json"),
        r#"{"designResolution":{"width":1280,"height":720},"scaleMode":"fixedauto"}"#,
    )
    .unwrap();
    fs::write(
        root.join("assets/materials/M.mat"),
        r#"{"$type":"material","name":"M","materialType":"physical","map":"assets/textures/a.png"}"#,
    )
    .unwrap();
    fs::write(root.join("assets/textures/a.png"), [1u8, 2, 3, 4]).unwrap();
    fs::write(
        root.join("assets/Main.scene"),
        r#"{"type":"scene","root":{"type":"node","childIds":[],"children":[{"type":"meshNode","source":"primitive","material":"assets/materials/M.mat"}]}}"#,
    )
    .unwrap();

    let runtime_files = |entry: &str| {
        HashMap::from([
            (
                "index.html".to_string(),
                format!(
                    "<html><title>t</title><body>{entry}<script type=\"module\" src=\"./player.mjs\"></script></body></html>"
                ),
            ),
            ("player.mjs".to_string(), "// player\nimport { b } from \"./engine/b.mjs\";\nconsole.log(b);\n".to_string()),
            ("engine/b.mjs".to_string(), "export const b = 2;\n".to_string()),
            ("engine/core/tve.mjs".to_string(), "export const engine = {};\n".to_string()),
            // 用户脚本编译产物（src/**.js）：编辑器编译时把 "tve" 裸导入
            // 重写为相对 engine/core/tve.mjs 的路径，此处模拟该形态
            (
                "src/main.js".to_string(),
                "import { engine } from \"../engine/core/tve.mjs\";\nengine.log(\"hi\");\n".to_string(),
            ),
        ])
    };
    let scenes = vec!["assets/Main.scene".to_string()];

    for &(single_page, gzip) in &[(false, false), (false, true), (true, false), (true, true)] {
        let entry = if single_page { "{{BUILD_DATA}}" } else { "" };
        let job = BuildJob {
            root: root.display().to_string(),
            channel: "web".into(),
            scenes: scenes.clone(),
            main_scene: "assets/Main.scene".into(),
            title: "T".into(),
            debug: false,
            single_page,
            gzip,
            release: false,
            cdn: false,
            gzip_base: String::new(),
            cdn_base: String::new(),
            files: runtime_files(entry),
            out_dir: None,
            wechat_appid: None,
            wechat_orientation: None,
        };
        let result = run_build(job, &JobCtx::default())
            .unwrap_or_else(|e| panic!("single_page={single_page} gzip={gzip} 构建失败: {e}"));

        let out = root.join("build/web");
        if single_page {
            // 单页：产物只剩一个入口 HTML
            let written: Vec<String> = fs::read_dir(&out)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            assert_eq!(written, vec!["index.html".to_string()], "单页产物只有 index.html");
            let html = fs::read_to_string(out.join("index.html")).unwrap();
            assert!(html.contains("__TVE_BUILD_DATA"), "单页入口页应内联数据");
            assert!(html.contains("importmap"), "单页入口页应带 Blob/importmap 引导脚本");
            assert!(html.contains("import(\"tve:\" + entry)"), "引导脚本应动态 import 入口模块");
            assert!(!html.contains("src=\"./player.mjs\""), "模板里的 player.mjs 脚本标签应被剥离");
            assert!(!out.join("scenes").exists(), "单页模式不落盘场景文件");
            assert!(!out.join("config.json").exists(), "单页模式不落盘 config.json");
            if gzip {
                // 代码在 gzip 归档（base64）里，正文不出现代码原文
                assert!(!html.contains("export const b = 2"), "gzip 单页代码应进归档而非明文");
                assert!(!html.contains("tve:engine/runtime/b.mjs"), "gzip 单页重写后的代码在归档里");
                // 引导脚本从归档提取代码时应包含用户脚本（src/ 前缀）
                assert!(
                    html.contains("path.lastIndexOf(\"src/\", 0) === 0"),
                    "gzip 单页引导脚本应把 src/ 用户脚本提取进代码表"
                );
            } else {
                assert!(html.contains("export const b = 2"), "非 gzip 单页代码应以文本内联");
                assert!(html.contains("tve:engine/b.mjs"), "运行时代码相对 import 应重写为 tve: 说明符");
                assert!(
                    html.contains("\"src/main.js\""),
                    "用户脚本应进入内联代码表（引导脚本据此构建 import map）"
                );
                assert!(
                    html.contains("tve:engine/core/tve.mjs"),
                    "用户脚本的 tve 导入应重写为 tve:engine/core/tve.mjs"
                );
            }
        } else {
            assert!(out.join("player.mjs").is_file(), "多文件运行时代码按文件落盘");
            assert!(out.join("engine/b.mjs").is_file());
            assert!(out.join("src/main.js").is_file(), "用户脚本按文件落盘");
            assert!(out.join("config.json").is_file());
            let html = fs::read_to_string(out.join("index.html")).unwrap();
            assert!(html.contains("src=\"./player.mjs\""), "多文件保留模板脚本标签");
            if gzip {
                let pak = fs::read(out.join("assets.gzip")).unwrap();
                assert_eq!(&pak[..2], &[0x1f, 0x8b]);
                assert!(!out.join("assets").exists(), "gzip 模式资产在归档中");
                assert!(!out.join("scenes").exists(), "gzip 模式场景在归档中");
            } else {
                assert!(out.join("scenes/Main.json").is_file());
                assert!(out.join("assets/materials/M.mat").is_file());
            }
            let cfg: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(out.join("config.json")).unwrap()).unwrap();
            assert_eq!(cfg["scenes"][0]["file"], "scenes/Main.json");
        }
        assert!(result.ok);
    }
    let _ = fs::remove_dir_all(&base);
}
