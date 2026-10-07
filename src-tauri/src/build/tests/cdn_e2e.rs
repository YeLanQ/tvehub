//! 端到端（CDN 模式）：Three CDN 与 gzip 资源地址相互独立，地址归一化与
//! 前缀去重拼接行为校验。

use std::collections::HashMap;
use std::fs;

use crate::build::{run_build, BuildJob, JobCtx};

/// CDN 模式与 gzip 资源地址相互独立：
/// - Three CDN 地址（CDN 模式开启且非空）：three.js 不内嵌——多文件从产物剔除并在
///   入口页注入 import map，单页不内联代码且经 cdnImports 映射到 CDN 地址；
/// - gzip 资源地址（非空，与 CDN 模式无关）：写入 config 的 gzipBase 供运行时
///   远程拉取归档，three 是否内嵌不受影响；
/// - 地址留空各自回退当前行为（three 内嵌 / 归档本地读取）。
#[test]
fn build_export_cdn_mode() {
    let base = std::env::temp_dir().join(format!("tve-build-cdn-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let root = base.join("proj");
    fs::create_dir_all(root.join("assets/textures")).unwrap();
    fs::write(root.join("assets/textures/a.png"), [1u8, 2, 3, 4]).unwrap();
    fs::write(
        root.join("assets/Main.scene"),
        r#"{"type":"scene","root":{"type":"node","children":[]}}"#,
    )
    .unwrap();

    let runtime_files = |single: bool| {
        let entry = if single { "{{BUILD_DATA}}" } else { "" };
        HashMap::from([
            (
                "index.html".to_string(),
                format!("<html><head></head><body>{entry}<script type=\"module\" src=\"./player.mjs\"></script></body></html>"),
            ),
            ("player.mjs".to_string(), "import * as T from \"./engine/core/three.module.min.js\";\nimport { b } from \"./engine/b.mjs\";\nconsole.log(T, b);\n".to_string()),
            ("engine/b.mjs".to_string(), "import * as T from \"./core/three.module.min.js\";
export const b = T ? 2 : 0;
".to_string()),
            ("engine/core/three.module.min.js".to_string(), "THREEMODULE_FAKE".to_string()),
            ("engine/core/three.core.min.js".to_string(), "THREECORE_FAKE".to_string()),
        ])
    };
    let three_cdn = "https://cdn.example.com/tve";
    let gzip_cdn = "https://res.example.com/pkg";
    let run = |single: bool, gzip: bool, cdn: bool, gzip_base: &str, three_base: &str| {
        run_build(
            BuildJob {
                root: root.display().to_string(),
                channel: "web".into(),
                scenes: vec!["assets/Main.scene".into()],
                main_scene: "assets/Main.scene".into(),
                title: "T".into(),
                debug: false,
                single_page: single,
                gzip,
                release: false,
                cdn,
                gzip_base: gzip_base.into(),
                cdn_base: three_base.into(),
                files: runtime_files(single),
                out_dir: None,
            wechat_appid: None,
            wechat_orientation: None,
            wechat_subpackages: None,
            wechat_subpackage_size: None,
            },
            &JobCtx::default(),
        )
        .unwrap()
    };

    // 多文件 + Three CDN：three 文件不落盘，运行时脚本里指向 three 的相对
    // import 直接重写为 CDN 绝对 URL（import map 拦截不了相对说明符）；
    // 未填 gzip 资源地址时 config 不带 gzipBase
    let result = run(false, false, true, "", three_cdn);
    let out = root.join("build/web");
    assert!(result.cdn);
    assert!(!out.join("engine/core/three.module.min.js").exists(), "three.module 不内嵌");
    assert!(!out.join("engine/core/three.core.min.js").exists(), "three.core 不内嵌");
    assert!(out.join("engine/b.mjs").is_file(), "其余 engine 模块仍内嵌");
    let player = fs::read_to_string(out.join("player.mjs")).unwrap();
    assert!(
        player.contains(&format!("\"{three_cdn}/three.module.min.js\"")),
        "player 的 three import 重写为 CDN URL"
    );
    let helper = fs::read_to_string(out.join("engine/b.mjs")).unwrap();
    assert!(
        helper.contains(&format!("\"{three_cdn}/three.module.min.js\"")),
        "engine 模块的 three import 重写为 CDN URL"
    );
    let html = fs::read_to_string(out.join("index.html")).unwrap();
    assert!(!html.contains("importmap"), "不再注入 import map");
    let cfg: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(out.join("config.json")).unwrap()).unwrap();
    assert!(cfg.get("gzipBase").is_none(), "未填 gzip 地址时不写 gzipBase");
    assert!(!html.contains("THREEMODULE_FAKE"));

    // 多文件 + gzip + gzip 资源地址（CDN 开关关）：归档仍生成（供上传 CDN），
    // three 照常内嵌，仅 config 带 gzipBase 供运行时远程拉取
    let result = run(false, true, false, gzip_cdn, "");
    let out = root.join("build/web");
    assert!(!result.cdn);
    assert!(out.join("engine/core/three.module.min.js").is_file(), "CDN 关闭时 three 内嵌");
    assert!(out.join("assets.gzip").is_file());
    let player = fs::read_to_string(out.join("player.mjs")).unwrap();
    assert!(
        player.contains("\"./engine/core/three.module.min.js\""),
        "CDN 关闭时说明符保持相对路径"
    );
    let cfg: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(out.join("config.json")).unwrap()).unwrap();
    assert_eq!(cfg["gzipBase"], gzip_cdn);

    // 单页 + Three CDN（gzip 两种形态）：three 不内联，代码内模块说明符重写为
    // tve:，指向 three 的说明符直接重写为 CDN 绝对 URL（不再需要 cdnImports）
    for gzip in [false, true] {
        let result = run(true, gzip, true, "", three_cdn);
        assert!(result.cdn);
        let html = fs::read_to_string(root.join("build/web/index.html")).unwrap();
        assert!(!html.contains("cdnImports"), "不再内联 cdnImports 映射表");
        assert!(!html.contains("THREEMODULE_FAKE"), "three 源码不内联");
        if !gzip {
            assert!(html.contains("tve:engine/b.mjs"), "其余模块仍内联并重写说明符");
            // 代码内联为 JSON 字符串，URL 前的引号被转义为 \"，只断言 URL 本身
            assert!(
                html.contains(&format!("{three_cdn}/three.module.min.js")),
                "three import 直接重写为 CDN URL"
            );
        }
    }

    // 前缀剥离与协议补全：产物 engine/core/ 前缀被剥离，不与基地址结尾目录
    // 重复拼接；无协议地址自动补 https://（否则被按页面相对路径解析）；
    // gzip 地址以 /assets.gzip 结尾时 config 原样保留（运行时拼接去重）
    let result = run(false, false, true, "", "cdn.example.com/tve/libs");
    assert!(result.cdn);
    let player = fs::read_to_string(root.join("build/web/player.mjs")).unwrap();
    assert!(
        player.contains("https://cdn.example.com/tve/libs/three.module.min.js"),
        "无协议地址补 https:// 且产物前缀剥离后不重复拼接"
    );
    let _ = run(false, true, false, "https://res.example.com/pkg/assets.gzip", "");
    let cfg: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(root.join("build/web/config.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(cfg["gzipBase"], "https://res.example.com/pkg/assets.gzip");

    // 官方 CDN 版本目录（无 engine/ 前缀）：URL 直接指向目录下的构建文件，
    // 不追加产物内的 engine/ 目录前缀（cdnjs 0.185.1 与内嵌运行时同名同版本）
    let three_official = "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.185.1";
    let _ = run(false, false, true, "", three_official);
    let player = fs::read_to_string(root.join("build/web/player.mjs")).unwrap();
    assert!(
        player.contains(&format!("\"{three_official}/three.module.min.js\"")),
        "官方 CDN 版本目录直接拼接文件名"
    );
    assert!(
        !player.contains(&format!("\"{three_official}/engine/")),
        "映射 URL 不追加产物内 engine/ 前缀"
    );

    // Three CDN 地址留空：CDN 模式不生效，回退标准构建（three 内嵌）
    let result = run(false, false, true, "", "   ");
    assert!(!result.cdn);
    assert!(root.join("build/web/engine/core/three.module.min.js").is_file());
    let _ = fs::remove_dir_all(&base);
}
