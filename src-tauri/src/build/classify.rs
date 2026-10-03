//! 产物内文件分类：运行时代码/入口页/运行时支撑数据判定、场景条目名去重、
//! 可压缩脚本与模型扩展名识别。

/// 场景文件在产物内的显示名（去目录与 .scene 扩展名；重名追加序号去重）
pub(super) fn scene_entry_name(rel: &str, used: &mut Vec<String>) -> String {
    let base = rel.rsplit('/').next().unwrap_or(rel);
    let stem = base.strip_suffix(".scene").unwrap_or(base);
    let mut name = stem.to_string();
    let mut n = 2;
    while used.iter().any(|u| u == &name) {
        name = format!("{stem}-{n}");
        n += 1;
    }
    used.push(name.clone());
    name
}

/// 网页运行时代码文件（多文件按文件落盘；单页全部内联进 HTML，不进归档/内联数据
/// 的场景/资产部分）；入口页 index.html 与多模板附加页 index-<模板目录>.html 都算运行时代码。
/// src/ 前缀 = 编辑器编译后的用户脚本模块（src/**.js，前端随 files 传入；
/// 相对 import 由 rewrite_module_imports 重写，与 engine 模块同一套加载机制）
pub(super) fn is_runtime_code(rel: &str) -> bool {
    rel == "player.mjs"
        || (rel.starts_with("engine/") && !is_runtime_support_data(rel))
        || rel.starts_with("src/")
        || is_entry_page(rel)
}

/// 运行时支撑数据（Draco/Basis 解码器与 wasm 二进制等按文件名被加载器 fetch 的
/// engine/ 下非模块文件）：不算运行时代码（单页/gzip 模式进资产表经 fetch 拦截
/// 供数据，而非内联成 blob 模块——解码器无 export、内联后无法按文件名取回，wasm
/// 二进制文本化即损坏），也不参与发布模式 uid 改名（DRACOLoader 等按固定文件名
/// decoderPath + 文件名拉取）。
pub(super) fn is_runtime_support_data(rel: &str) -> bool {
    rel.starts_with("engine/runtime/loaders/draco/")
        || rel.starts_with("engine/runtime/loaders/basis/")
        || (rel.starts_with("engine/") && rel.ends_with(".wasm"))
}

/// 入口页：首个模板生成 index.html，其余模板生成 index-<模板目录>.html
pub(super) fn is_entry_page(rel: &str) -> bool {
    rel == "index.html" || (rel.starts_with("index-") && rel.ends_with(".html"))
}

pub(super) fn is_model_ext(rel: &str) -> bool {
    matches!(
        rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str(),
        "glb" | "gltf" | "obj"
    )
}

pub(super) fn rel_ext(rel: &str) -> String {
    let file = rel.rsplit('/').next().unwrap_or(rel);
    match file.rfind('.') {
        Some(_) => file.rsplit('.').next().unwrap_or("").to_ascii_lowercase(),
        None => String::new(),
    }
}

/// 需要压缩的运行时脚本（.js/.mjs；已压缩的 *.min.* 跳过，如 three 运行时）
pub(super) fn is_minifiable_script(rel: &str) -> bool {
    is_runtime_code(rel)
        && (rel.ends_with(".js") || rel.ends_with(".mjs"))
        && !rel.contains(".min.")
}

#[cfg(test)]
mod tests {
    use super::{is_runtime_code, scene_entry_name};

    #[test]
    fn scene_entry_name_dedups() {
        let mut used = Vec::new();
        assert_eq!(scene_entry_name("assets/Main.scene", &mut used), "Main");
        assert_eq!(scene_entry_name("assets/sub/Main.scene", &mut used), "Main-2");
        assert_eq!(scene_entry_name("Level1.scene", &mut used), "Level1");
    }

    #[test]
    fn runtime_code_detection() {
        assert!(is_runtime_code("index.html"));
        assert!(is_runtime_code("index-single.html"));
        assert!(is_runtime_code("player.mjs"));
        assert!(is_runtime_code("engine/core/three.module.min.js"));
        assert!(is_runtime_code("src/main.js"), "用户脚本编译产物按运行时代码处理");
        assert!(!is_runtime_code("assets/materials/Default.mat"));
        assert!(!is_runtime_code("scenes/Main.json"));
        assert!(!is_runtime_code("config.json"));
        assert!(!is_runtime_code("index.json"));
    }
}

