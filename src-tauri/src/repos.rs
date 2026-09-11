// ---------------------------------------------------------------------------
// 创意工坊资源仓库：public/repos/<分类>/（分类 = 仓库子目录，目录名即分类 id）。
// - code：脚本原型（*.ts，一个原型一个独立文件）；资产面板「新建脚本 > 创意工坊」
//   直接选用，故保留 list_code_protos / read_code_proto / write_code_proto /
//   delete_code_proto 这组 code 分类专用命令（等价于通用命令的 code 特化）；
// - 其它分类（如 effect）：原样展示的文件资源（首页工坊只读浏览，内容直接维护目录）；
// - 文件描述写在首部注释 "// @desc: 描述"（可选，前 5 行内识别）；
// - 目录定位与内置资源同源（builtin_root）：开发 = 仓库 public/repos，
//   生产 = exe 同级 public/repos（用户文件写 exe 旁，不随构建覆盖）。
// ---------------------------------------------------------------------------

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::repos_root;

/// 仓库内置分类（首次运行确保存在，空目录 git 不保留需在此兜底）
const BUILTIN_CATEGORIES: [&str; 2] = ["code", "effect"];

/// 判定文本文件用的扩展名（二进制文件不读取内容，只列信息）
const TEXT_EXTS: [&str; 18] = [
    "ts", "js", "mjs", "cjs", "tsx", "json", "md", "txt", "shader", "glsl", "hlsl", "cg", "css",
    "scss", "html", "xml", "yml", "yaml",
];

/// 仓库文件（分类下的一个文件）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoFileInfo {
    /// 文件名（含扩展名，如 "Spin.ts"）
    pub file: String,
    /// 显示名（文件名去扩展名）
    pub name: String,
    /// 小写扩展名（无扩展名为空串）
    pub ext: String,
    /// 首部 // @desc: 描述（缺省空字符串）
    pub description: String,
    /// 文件字节数（展示用）
    pub size: u64,
}

/// 仓库分类（public/repos 下的一个子目录）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoCategoryInfo {
    /// 分类 id（= 目录名，如 "code" / "effect"）
    pub id: String,
    /// 分类目录绝对路径（「在文件夹中打开」用）
    pub dir: String,
    /// 分类下的文件（按文件名排序）
    pub files: Vec<RepoFileInfo>,
}

/// 单个路径段守卫：非空、无路径分隔符、无 ..（防越界）
fn safe_segment(name: &str) -> Option<String> {
    let s = name.trim();
    if s.is_empty() || s == "." || s == ".." {
        return None;
    }
    if s.contains('\\') || s.contains('/') || s.contains("..") {
        return None;
    }
    Some(s.to_string())
}

/// 文件名守卫：非空、无路径分隔符、无 ..（防越界）
fn safe_file(file: &str) -> Option<String> {
    let f = safe_segment(file)?;
    if f.starts_with('.') {
        return None;
    }
    Some(f)
}

/// 分类目录（确保存在；分类名非法时报错）
fn category_dir(category: &str) -> Result<PathBuf, String> {
    category_dir_in(&repos_root(), category)
}

/// 分类目录（指定仓库根；便于测试）：确保存在 + 分类名守卫
fn category_dir_in(root: &Path, category: &str) -> Result<PathBuf, String> {
    let id = safe_segment(category).ok_or_else(|| format!("非法仓库分类: {category}"))?;
    let dir = root.join(&id);
    fs::create_dir_all(&dir).map_err(|e| format!("创建仓库分类目录失败: {e}"))?;
    Ok(dir)
}

/// 写入分类目录下的文件（file 已通过守卫；父目录由调用方保证存在）
fn write_file_in(dir: &Path, file: &str, code: &str) -> Result<(), String> {
    fs::write(dir.join(file), code).map_err(|e| format!("写入文件失败 '{file}': {e}"))
}

/// 删除分类目录下的文件（不存在视为成功）
fn delete_file_in(dir: &Path, file: &str) -> Result<(), String> {
    let path = dir.join(file);
    if path.is_file() {
        fs::remove_file(&path).map_err(|e| format!("删除文件失败 '{file}': {e}"))?;
    }
    Ok(())
}

/// 从代码首部注释解析描述（// @desc: xxx，支持全角冒号）
fn parse_desc(code: &str) -> String {
    for line in code.lines().take(5) {
        let t = line.trim();
        for p in ["// @desc:", "// @desc："] {
            if let Some(rest) = t.strip_prefix(p) {
                return rest.trim().to_string();
            }
        }
    }
    String::new()
}

/// 小写扩展名（无扩展名 → 空串）
fn ext_of(file: &str) -> String {
    match file.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => ext.to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// 是否为文本文件（按扩展名判定；未知扩展名按二进制处理，不读取内容）
fn is_text_file(ext: &str) -> bool {
    TEXT_EXTS.contains(&ext)
}

/// 读取文件描述：文本文件按首部注释解析，二进制/读取失败返回空。
/// 描述只可能出现在文件前几行 —— 只读头部 2KB，避免为 5 行描述整读大文件。
fn describe(path: &Path, ext: &str) -> String {
    if !is_text_file(ext) {
        return String::new();
    }
    const HEAD_BYTES: u64 = 2048;
    fs::File::open(path)
        .and_then(|f| {
            let mut buf = Vec::new();
            f.take(HEAD_BYTES).read_to_end(&mut buf)?;
            Ok(buf)
        })
        .map(|buf| parse_desc(&String::from_utf8_lossy(&buf)))
        .unwrap_or_default()
}

/// 扫描单个分类目录 → 文件清单（跳过目录与隐藏文件，按文件名排序）
fn scan_category(dir: &Path) -> Vec<RepoFileInfo> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = rd
        .flatten()
        .filter(|e| e.path().is_file())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|file| {
            let path = dir.join(&file);
            let ext = ext_of(&file);
            let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let name = match file.rsplit_once('.') {
                Some((stem, _)) if !stem.is_empty() => stem.to_string(),
                _ => file.clone(),
            };
            RepoFileInfo {
                description: describe(&path, &ext),
                file,
                name,
                ext,
                size,
            }
        })
        .collect()
}

/// 确保仓库内置分类目录存在（code 用于脚本原型，effect 用于效果资源）
fn ensure_repo_dirs() -> Result<PathBuf, String> {
    let root = repos_root();
    fs::create_dir_all(&root).map_err(|e| format!("创建仓库目录失败: {e}"))?;
    for id in BUILTIN_CATEGORIES {
        let dir = root.join(id);
        if !dir.is_dir() {
            fs::create_dir_all(&dir).map_err(|e| format!("创建仓库分类目录失败: {e}"))?;
        }
    }
    Ok(root)
}

/// 播种脚本原型起点：repos/code 为空时写入内置基础脚本模板为普通文件
/// 「基础脚本.ts」（之后与任意用户原型一视同仁，不再有内置特例）
fn seed_code_protos(dir: &Path) {
    let has_any = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .any(|e| e.path().is_file() && e.file_name().to_string_lossy().ends_with(".ts"))
        })
        .unwrap_or(true);
    if has_any {
        return;
    }
    let tpl = crate::internal_root().join("templates/Script.ts");
    if let Ok(code) = fs::read_to_string(&tpl) {
        let _ = fs::write(dir.join("基础脚本.ts"), code);
    }
}

/// 扫描创意工坊全部分类（public/repos/*，按目录名排序）
#[tauri::command]
pub async fn list_repo_categories() -> Result<Vec<RepoCategoryInfo>, String> {
    let root = ensure_repo_dirs()?;
    seed_code_protos(&root.join("code"));
    let mut ids: Vec<String> = fs::read_dir(&root)
        .map_err(|e| format!("读取仓库目录失败: {e}"))?
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.'))
        .collect();
    ids.sort();
    Ok(ids
        .into_iter()
        .map(|id| {
            let dir = root.join(&id);
            RepoCategoryInfo {
                files: scan_category(&dir),
                dir: dir.display().to_string(),
                id,
            }
        })
        .collect())
}

/// 读取仓库文件内容（category 分类目录下的 file；仅文本文件）
#[tauri::command]
pub async fn read_repo_file(category: String, file: String) -> Result<String, String> {
    let f = safe_file(&file).ok_or_else(|| format!("非法仓库文件名: {file}"))?;
    let path = category_dir(&category)?.join(&f);
    if !path.is_file() {
        return Err(format!("文件不存在: {category}/{f}"));
    }
    fs::read_to_string(&path).map_err(|e| format!("读取文件失败 '{category}/{f}': {e}"))
}

/// 写入仓库文件（新建/整表覆盖；目录不存在自动创建）
#[tauri::command]
pub async fn write_repo_file(category: String, file: String, code: String) -> Result<(), String> {
    let f = safe_file(&file).ok_or_else(|| format!("非法仓库文件名: {file}"))?;
    write_file_in(&category_dir(&category)?, &f, &code)
}

/// 删除仓库文件
#[tauri::command]
pub async fn delete_repo_file(category: String, file: String) -> Result<(), String> {
    let f = safe_file(&file).ok_or_else(|| format!("非法仓库文件名: {file}"))?;
    delete_file_in(&category_dir(&category)?, &f)
}

/// 文件名守卫（脚本原型）：仅允许 .ts，且不含路径分隔符与 ..
fn safe_proto_file(file: &str) -> Option<String> {
    let f = safe_file(file)?;
    if !f.ends_with(".ts") || f.len() <= 3 {
        return None;
    }
    Some(f)
}

// ---------------------------------------------------------------------------
// code 分类特化（脚本原型）：资产面板「新建脚本 > 创意工坊」与原型维护共用
// ---------------------------------------------------------------------------

/// 扫描脚本原型目录（repos/code/*.ts，按文件名排序；空目录播种基础脚本模板）
#[tauri::command]
pub async fn list_code_protos() -> Result<Vec<RepoFileInfo>, String> {
    let dir = category_dir("code")?;
    seed_code_protos(&dir);
    Ok(scan_category(&dir)
        .into_iter()
        .filter(|f| f.ext == "ts")
        .collect())
}

/// 读取原型文件内容（file 含 .ts）
#[tauri::command]
pub async fn read_code_proto(file: String) -> Result<String, String> {
    let f = safe_proto_file(&file).ok_or_else(|| format!("非法原型文件名: {file}"))?;
    let path = category_dir("code")?.join(&f);
    if !path.is_file() {
        return Err(format!("原型文件不存在: {f}"));
    }
    fs::read_to_string(&path).map_err(|e| format!("读取原型失败 '{f}': {e}"))
}

/// 写入原型文件（新建/整表覆盖；目录不存在自动创建）
#[tauri::command]
pub async fn write_code_proto(file: String, code: String) -> Result<(), String> {
    let f = safe_proto_file(&file).ok_or_else(|| format!("非法原型文件名: {file}"))?;
    let path = category_dir("code")?.join(&f);
    fs::write(&path, code).map_err(|e| format!("写入原型失败 '{f}': {e}"))
}

/// 删除原型文件
#[tauri::command]
pub async fn delete_code_proto(file: String) -> Result<(), String> {
    let f = safe_proto_file(&file).ok_or_else(|| format!("非法原型文件名: {file}"))?;
    let path = category_dir("code")?.join(&f);
    if path.is_file() {
        fs::remove_file(&path).map_err(|e| format!("删除原型失败 '{f}': {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desc_parsing_accepts_halfwidth_and_fullwidth_colon() {
        assert_eq!(parse_desc("// @desc: 旋转动画\nclass A {}"), "旋转动画");
        assert_eq!(parse_desc("\n\n// @desc：跟随相机\n"), "跟随相机");
        assert_eq!(parse_desc("// 普通注释\nclass A {}"), "");
        // 只识别首部 5 行
        assert_eq!(parse_desc("// 1\n// 2\n// 3\n// 4\n// 5\n// @desc: 太靠后\n"), "");
    }

    #[test]
    fn ext_and_text_file_classification() {
        assert_eq!(ext_of("Spin.ts"), "ts");
        assert_eq!(ext_of("Hologram.SHADER"), "shader");
        assert_eq!(ext_of("noext"), "");
        assert_eq!(ext_of(".hidden"), "");
        assert!(is_text_file("shader"));
        assert!(!is_text_file("png"));
        assert!(!is_text_file(""));
    }

    #[test]
    fn safe_segment_and_file_guards() {
        assert_eq!(safe_segment("code"), Some("code".to_string()));
        assert_eq!(safe_segment(" code "), Some("code".to_string()));
        assert_eq!(safe_segment(""), None);
        assert_eq!(safe_segment("."), None);
        assert_eq!(safe_segment(".."), None);
        assert_eq!(safe_segment("a/b"), None);
        assert_eq!(safe_segment("a\\b"), None);
        assert_eq!(safe_segment("..\\evil"), None);
        // 文件名额外拒绝隐藏文件；原型额外要求 .ts
        assert_eq!(safe_file(".gitkeep"), None);
        assert_eq!(safe_file("Spin.ts"), Some("Spin.ts".to_string()));
        assert_eq!(safe_proto_file("Spin.ts"), Some("Spin.ts".to_string()));
        assert_eq!(safe_proto_file("Spin.shader"), None);
        assert_eq!(safe_proto_file("evil/Spin.ts"), None);
        assert_eq!(safe_proto_file("../Spin.ts"), None);
    }

    /// 分类扫描：只收文件、跳过隐藏文件、按名排序、描述来自首部注释
    #[test]
    fn scan_category_lists_files_sorted_with_desc() {
        let dir = std::env::temp_dir().join(format!("tve_repos_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("B.ts"), "// @desc: 第二个\nclass B {}").unwrap();
        fs::write(dir.join("A.ts"), "class A {}").unwrap();
        fs::write(dir.join(".hidden.ts"), "class H {}").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();

        let files = scan_category(&dir);
        assert_eq!(
            files.iter().map(|f| f.file.as_str()).collect::<Vec<_>>(),
            vec!["A.ts", "B.ts"]
        );
        assert_eq!(files[0].name, "A");
        assert_eq!(files[0].ext, "ts");
        assert_eq!(files[0].description, "");
        assert_eq!(files[1].description, "第二个");
        assert!(files[0].size > 0);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 随仓库分发的示例效果（public/repos/effect/*.shader）必须始终可用：
    /// 每个文件都是可解析的效果着色器（Properties + Base + 至少一个 Hook），
    /// 且首部带 // @desc: 描述（工坊卡片展示用）。
    #[test]
    fn shipped_effect_examples_stay_parseable() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/repos/effect");
        let files = scan_category(&dir);
        assert!(!files.is_empty(), "public/repos/effect 下应有示例效果");
        for f in &files {
            assert!(
                f.file.ends_with(".shader"),
                "示例效果应为 .shader（实际 {}）",
                f.file
            );
            assert!(!f.description.is_empty(), "示例 {} 缺少 // @desc: 描述", f.file);
            let text = fs::read_to_string(dir.join(&f.file)).unwrap_or_default();
            let parsed = crate::scene::shader::parse_shader(&text);
            assert!(
                parsed.error.is_none(),
                "示例 {} 无法解析为效果着色器: {:?}",
                f.file,
                parsed.error
            );
            assert!(
                crate::scene::shader::base_kind(&parsed.base).is_some(),
                "示例 {} 应声明渲染分支 Base（实际 \"{}\"）",
                f.file,
                parsed.base
            );
            assert!(!parsed.hooks.is_empty(), "示例 {} 应含至少一个 Hook", f.file);
            assert!(!parsed.properties.is_empty(), "示例 {} 应含 Properties", f.file);
        }
    }

    /// 原型增删改链路（工坊「添加原型」的落盘路径，脚本与效果分类同一条）：
    /// 写入 → 扫描可见（含 // @desc: 描述）→ 改名（旧文件删除）→ 删除。
    /// 用临时仓库根，不触碰真实 public/repos。
    #[test]
    fn prototype_write_scan_rename_delete_roundtrip() {
        let root = std::env::temp_dir().join(format!("tve_repo_write_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        // 效果原型：写入 effect 分类（分类目录不存在时自动创建）
        let effect_dir = category_dir_in(&root, "effect").unwrap();
        write_file_in(&effect_dir, "Hologram.shader", "// @desc: 全息\nShader \"effect/Hologram\"\n{\n}\n")
            .unwrap();
        let files = scan_category(&effect_dir);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].file, "Hologram.shader");
        assert_eq!(files[0].ext, "shader");
        assert_eq!(files[0].description, "全息");

        // 改名 = 新文件 + 删旧文件（与工坊保存逻辑一致）
        write_file_in(&effect_dir, "Holo2.shader", "// @desc: 改名后\nShader \"effect/Holo2\"\n{\n}\n")
            .unwrap();
        delete_file_in(&effect_dir, "Hologram.shader").unwrap();
        let files = scan_category(&effect_dir);
        assert_eq!(
            files.iter().map(|f| f.file.as_str()).collect::<Vec<_>>(),
            vec!["Holo2.shader"]
        );
        assert_eq!(files[0].description, "改名后");

        // 删除（重复删除不报错）
        delete_file_in(&effect_dir, "Holo2.shader").unwrap();
        delete_file_in(&effect_dir, "Holo2.shader").unwrap();
        assert!(scan_category(&effect_dir).is_empty());

        // 脚本原型分类同样适用
        let code_dir = category_dir_in(&root, "code").unwrap();
        write_file_in(&code_dir, "Spin.ts", "// @desc: 旋转\nclass Spin {}\n").unwrap();
        let code = scan_category(&code_dir);
        assert_eq!((code[0].file.as_str(), code[0].ext.as_str()), ("Spin.ts", "ts"));

        // 分类名/文件名守卫仍然生效（越界一律拒绝）
        assert!(category_dir_in(&root, "../etc").is_err());
        assert!(safe_file("../Spin.ts").is_none());
        let _ = fs::remove_dir_all(&root);
    }
}
