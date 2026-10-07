//! 端到端（发布模式）：资产 uid 重命名（.meta uuid 优先/哈希回退）、场景与
//! 材质引用重写、JSON 紧凑化、模型二进制化（LQENBIN1）。

use std::collections::HashMap;
use std::fs;

use crate::build::{run_build, BuildJob, JobCtx};
use crate::build::kernel::release::fallback_uid;

/// 发布模式：资产 uid 重命名（.meta uuid 优先/哈希回退）、场景与材质引用重写、
/// JSON 紧凑化、模型二进制化（LQENBIN1，.gltf 外部兄弟内联剔除）。
#[test]
fn build_export_release_renames_and_rewrites() {
    let base = std::env::temp_dir().join(format!("tve-build-rel-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let root = base.join("proj");
    fs::create_dir_all(root.join("assets/materials")).unwrap();
    fs::create_dir_all(root.join("assets/textures")).unwrap();
    fs::create_dir_all(root.join("assets/models")).unwrap();

    // 材质有 .meta（uuid 重命名）；贴图无 .meta（路径哈希回退）
    fs::write(
        root.join("assets/materials/M.mat"),
        r#"{
  "$type": "material",
  "map": "assets/textures/a.png",
  "normalMap": "assets/textures/a.png"
}"#,
    )
    .unwrap();
    fs::write(root.join("assets/materials/M.mat.meta"), r#"{"uuid":"11111111-2222-3333-4444-555555555555"}"#).unwrap();
    fs::write(root.join("assets/textures/a.png"), [9u8; 8]).unwrap();

    // 模型：glb（kind1 包装）/ gltf（外部 .bin+贴图内联）/ obj（kind0 网格）
    fs::write(root.join("assets/models/cube.glb"), b"glTFfake-glb-bytes").unwrap();
    fs::write(
        root.join("assets/models/tree.gltf"),
        r#"{"asset":{"version":"2.0"},"buffers":[{"uri":"tree.bin","byteLength":4}],"bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":4}],"images":[{"uri":"tree.png"}]}"#,
    ).unwrap();
    fs::write(root.join("assets/models/tree.gltf.meta"), r#"{"uuid":"99999999-8888-7777-6666-555555555555"}"#).unwrap();
    fs::write(root.join("assets/models/tree.bin"), [1u8, 2, 3, 4]).unwrap();
    fs::write(root.join("assets/models/tree.png"), [7u8; 4]).unwrap();
    fs::write(root.join("assets/models/rock.obj"), "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n").unwrap();
    // 粒子系统节点引用的贴图（不经材质，直接在 particles.texture 上）
    fs::write(root.join("assets/textures/spark.png"), [5u8; 6]).unwrap();
    // 逻辑运行器资产（.fsm/.bt 文本）：settings.asset 引用随发布重写
    fs::create_dir_all(root.join("assets/logic")).unwrap();
    fs::write(root.join("assets/logic/Patrol.fsm"), r#"{"states":[{"id":"s1","name":"巡逻"}]}"#).unwrap();
    fs::write(root.join("assets/logic/Tree.bt"), r#"{"tree":{"type":"sequence"}}"#).unwrap();

    let scene = r#"{
  "type": "scene",
  "root": {
"type": "node",
"children": [
  { "type": "meshNode", "source": "primitive", "material": "assets/materials/M.mat" },
  { "type": "meshNode", "source": "model", "model": "assets/models/tree.gltf", "material": "assets/materials/M.mat" },
  { "type": "meshNode", "source": "model", "model": "assets/models/cube.glb" },
  { "type": "meshNode", "source": "model", "model": "assets/models/rock.obj" },
  { "type": "particleSystemNode", "particles": { "emissionRate": 20, "texture": "assets/textures/spark.png" } },
  { "type": "fsmRunnerNode", "settings": { "asset": "assets/logic/Patrol.fsm", "autoStart": true } },
  { "type": "btRunnerNode", "settings": { "asset": "assets/logic/Tree.bt", "autoStart": false } }
]
  }
}"#;
    fs::write(root.join("assets/Main.scene"), scene).unwrap();

    let run = |release: bool| {
        run_build(
            BuildJob {
                root: root.display().to_string(),
                channel: "web".into(),
                scenes: vec!["assets/Main.scene".into()],
                main_scene: "assets/Main.scene".into(),
                title: "T".into(),
                debug: false,
                single_page: false,
                gzip: false,
                release,
                cdn: false,
                gzip_base: String::new(),
                cdn_base: String::new(),
                files: HashMap::from([
                ("index.html".to_string(), "<html></html>".to_string()),
                ("player.mjs".to_string(), "// player entry\nimport { A } from \"./engine/helper.mjs\";\nconsole.log(A);\n".to_string()),
                (
                    "engine/helper.mjs".to_string(),
                    "// helper comment\nexport const A = 1;\n".to_string(),
                ),
                (
                    "engine/core/three.module.min.js".to_string(),
                    "/*already minified*/export const T = 1;".to_string(),
                ),
            ]),
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

    // 未发布：原名 + 保留缩进
    run(false);
    let out = root.join("build/web");
    assert!(out.join("assets/materials/M.mat").is_file());
    let scene_text = fs::read_to_string(out.join("scenes/Main.json")).unwrap();
    assert!(scene_text.contains("assets/materials/M.mat"));
    assert!(scene_text.contains('\n'), "未发布保留原格式");
    assert!(out.join("assets/textures/spark.png").is_file(), "粒子贴图随导出拷贝");
    assert!(scene_text.contains("assets/textures/spark.png"), "未发布粒子贴图引用保持原名");
    assert!(out.join("assets/logic/Patrol.fsm").is_file(), "逻辑资产随导出拷贝");
    assert!(scene_text.contains("assets/logic/Patrol.fsm"), "未发布逻辑资产引用保持原名");

    // 发布：uuid 文件名 + 引用重写 + JSON 紧凑
    let result = run(true);
    assert!(result.release);
    let out = root.join("build/web");
    assert!(!out.join("assets/materials/M.mat").exists(), "原名文件应已重命名");
    let mat_rel = "assets/materials/11111111-2222-3333-4444-555555555555.mat";
    assert!(out.join(&mat_rel).is_file(), "uuid 文件名（.meta uuid）");
    let scene_text = fs::read_to_string(out.join("scenes/Main.json")).unwrap();
    assert!(scene_text.contains(mat_rel), "场景材质引用已重写");
    assert!(!scene_text.contains('\n'), "场景 JSON 已紧凑化");
    let mat_text = fs::read_to_string(out.join(mat_rel)).unwrap();
    assert!(!mat_text.contains("assets/textures/a.png"), "贴图引用已重写");
    let fallback = fallback_uid("assets/textures/a.png");
    assert!(out.join(format!("assets/textures/{fallback}.png")).is_file(), "无 .meta 走路径哈希 uid");
    assert!(mat_text.contains(&fallback), "材质贴图引用重写为哈希 uid");
    // 粒子贴图：文件重命名 + particles.texture 引用重写
    let spark_uid = fallback_uid("assets/textures/spark.png");
    assert!(!out.join("assets/textures/spark.png").exists(), "粒子贴图原名不保留");
    assert!(out.join(format!("assets/textures/{spark_uid}.png")).is_file(), "粒子贴图重命名为哈希 uid");
    assert!(scene_text.contains(&format!("assets/textures/{spark_uid}.png")), "particles.texture 引用已重写");
    assert!(!scene_text.contains("spark.png"), "场景内不残留粒子贴图原名");

    // 逻辑资产（.fsm/.bt）：文件随发布打包并重命名，settings.asset 引用同步重写
    // （缺重写时运行时按旧路径取不到 → 运行器空转，表现为状态机/行为树"被过滤"）
    let fsm_uid = fallback_uid("assets/logic/Patrol.fsm");
    let bt_uid = fallback_uid("assets/logic/Tree.bt");
    assert!(out.join(format!("assets/logic/{fsm_uid}.fsm")).is_file(), "状态机资产随发布打包（uid 名）");
    assert!(out.join(format!("assets/logic/{bt_uid}.bt")).is_file(), "行为树资产随发布打包（uid 名）");
    assert!(scene_text.contains(&format!("assets/logic/{fsm_uid}.fsm")), "状态机 settings.asset 引用已重写");
    assert!(scene_text.contains(&format!("assets/logic/{bt_uid}.bt")), "行为树 settings.asset 引用已重写");
    assert!(!scene_text.contains("assets/logic/Patrol.fsm") && !scene_text.contains("assets/logic/Tree.bt"), "场景内不残留逻辑资产原名");

    // 脚本压缩：player/engine 脚本去注释压缩；*.min.* 跳过
    let player_min = fs::read_to_string(out.join("player.mjs")).unwrap();
    assert!(!player_min.contains("//"), "player.mjs 注释已移除");
    let helper_min = fs::read_to_string(out.join("engine/helper.mjs")).unwrap();
    assert!(!helper_min.contains("// helper"), "engine 脚本注释已移除");
    assert!(!helper_min.contains(" = 1;"), "engine 脚本空白已压缩");
    let three_min = fs::read_to_string(out.join("engine/core/three.module.min.js")).unwrap();
    assert!(three_min.contains("/*already minified*/"), "*.min.* 不重复压缩");

    // 模型二进制化：glb → kind1；gltf → 自包含 glb → kind1（兄弟文件剔除）；obj → kind0
    assert!(!out.join("assets/models/cube.glb").exists(), "glb 原名不保留");
    assert!(!out.join("assets/models/tree.gltf").exists());
    assert!(!out.join("assets/models/rock.obj").exists());
    assert!(!out.join("assets/models/tree.bin").exists(), "gltf 外部 .bin 已内联剔除");
    assert!(!out.join("assets/models/tree.png").exists(), "gltf 外部贴图已内联剔除");
    let cube_bin = fs::read(out.join("assets/models/").join(format!("{}.bin", fallback_uid("assets/models/cube.glb")))).unwrap();
    assert_eq!(&cube_bin[0..8], b"LQENBIN1");
    assert_eq!(u32::from_le_bytes(cube_bin[8..12].try_into().unwrap()), 1, "glb → kind1");
    assert_eq!(&cube_bin[16..20], b"glTF", "kind1 payload 为原始 GLB");
    let tree_bin = fs::read(out.join("assets/models/99999999-8888-7777-6666-555555555555.bin")).unwrap();
    assert_eq!(&tree_bin[0..8], b"LQENBIN1");
    assert_eq!(u32::from_le_bytes(tree_bin[8..12].try_into().unwrap()), 1, "gltf → 自包含 glb → kind1");
    assert_eq!(&tree_bin[16..20], b"glTF");
    // 内嵌 .bin 数据（[1,2,3,4]）出现在自包含 GLB 的 BIN chunk 中
    assert!(tree_bin.windows(4).any(|w| w == [1, 2, 3, 4]));
    let rock_bin = fs::read(out.join("assets/models/").join(format!("{}.bin", fallback_uid("assets/models/rock.obj")))).unwrap();
    assert_eq!(u32::from_le_bytes(rock_bin[8..12].try_into().unwrap()), 0, "obj → kind0 网格");
    assert_eq!(u32::from_le_bytes(rock_bin[24..28].try_into().unwrap()), 1, "1 个三角面");
    // 场景引用重写为 .bin 路径
    assert!(scene_text.contains(&format!("assets/models/{}.bin", fallback_uid("assets/models/cube.glb"))));
    assert!(scene_text.contains("assets/models/99999999-8888-7777-6666-555555555555.bin"));
    assert!(!scene_text.contains("tree.gltf") && !scene_text.contains("rock.obj"));
    assert_eq!(result.bin_converted.len(), 3, "三个模型均转换");
    let _ = fs::remove_dir_all(&base);
}
