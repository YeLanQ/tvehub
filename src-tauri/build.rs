// 构建期：把编辑器内置资源（public/<kind>/…）打包进二进制，
// 运行时由 exe 启动时提取到其同级 public/<kind>（免安装便携），
// 开发（debug）则直接读取仓库 public/<kind>。
// kind = internal（内置只读资产）/ templates（工程模板）/ exports（Web 导出
// 模板）——这三类由 Rust 命令从 exe 旁磁盘读取，生产环境无随包资源目录，
// 必须内嵌自带（docs/engine/web-preview 走前端产物，不在此列）。
// repos（创意工坊）不内嵌：体量大且用户会直接改写其中文件——release 构建
// 由本脚本把 public/repos 拷贝到 exe 同级 public/repos（见 copy_repos_to_target）。
// 归档格式：u32 条数 + 每条 [u32 pathLen][path][u32 dataLen][data]，
// 其中 path 以 kind 为前缀（如 "internal/materials/Default.mat"）。
//
// 另外从这里生成局域网对外页面的主题常量（见 emit_lan_theme）：服务端渲染的
// 共享索引页/解锁页拿不到应用样式表，颜色必须在构建期从主题变量表取出来内联。
// 放在 build.rs 而不是「生成一份入库的 Rust 文件」，是为了让 Rust 侧不可能与主题
// 分叉：改 variables.scss 会触发 rerun-if-changed，重新生成常量并重编译。

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

#[path = "build_skills.rs"]
mod build_skills;

#[path = "build_docs.rs"]
mod build_docs;

/// 局域网对外页面需要的主题令牌：CSS 变量名 → Rust 常量名。
/// 与 scripts/gen-lan-theme.mjs 的 TOKENS 保持一致（同源同集合）。
const LAN_THEME_TOKENS: &[(&str, &str)] = &[
    ("--bg", "BG"),
    ("--bg-panel", "BG_PANEL"),
    ("--bg-panel-2", "BG_PANEL_2"),
    ("--bg-hover", "BG_HOVER"),
    ("--bg-input", "BG_INPUT"),
    ("--border", "BORDER"),
    ("--text", "TEXT"),
    ("--text-dim", "TEXT_DIM"),
    ("--accent", "ACCENT"),
    ("--ok", "OK"),
    ("--warn", "WARN"),
    ("--err", "ERR"),
];

/// 主题变量表（前端 ui-kit 的单一事实源）
const THEME_SOURCE: &str = "../src/ui-kit/styles/variables.scss";

/// 从 variables.scss 的 `:root { ... }` 里取令牌值。
/// 只认「--name: value;」这一形态（主题表就是这个形态）；缺令牌直接 panic —— 
/// 宁可构建失败，也不要产出一张缺色的页面。
fn read_theme_token(scss: &str, name: &str) -> String {
    let root_start = scss
        .find(":root")
        .unwrap_or_else(|| panic!("{THEME_SOURCE} 里找不到 :root"));
    let rest = &scss[root_start..];
    let body_start = rest
        .find('{')
        .unwrap_or_else(|| panic!("{THEME_SOURCE} 的 :root 缺少 {{"));
    let body = &rest[body_start + 1..];
    let body_end = body
        .find("\n}")
        .unwrap_or_else(|| panic!("{THEME_SOURCE} 的 :root 缺少收尾 }}"));
    for line in body[..body_end].lines() {
        let line = line.trim();
        if let Some(after) = line.strip_prefix(name) {
            // 必须是完整变量名（避免 --text 命中 --text-dim）
            if !after.starts_with(':') {
                continue;
            }
            let value = after[1..].trim().trim_end_matches(';').trim();
            if !value.is_empty() {
                return value.to_string();
            }
        }
    }
    panic!("{THEME_SOURCE} 的 :root 缺少局域网需要的令牌 {name}")
}

/// 生成 `lan_theme.rs`：常量 + 一段可直接内联的 CSS 自定义属性声明
fn emit_lan_theme(manifest_dir: &str, out_dir: &str) {
    let source_path = PathBuf::from(manifest_dir).join(THEME_SOURCE);
    println!("cargo:rerun-if-changed={}", source_path.display());
    let scss = std::fs::read_to_string(&source_path).unwrap_or_else(|e| {
        panic!("读取主题文件 {} 失败: {e}", source_path.display())
    });

    let mut code = String::from(
        "// 由 build.rs 从 ui-kit 主题变量表生成，请勿手改（改主题请改 variables.scss）。\n\
         // 服务端渲染的局域网页面用这里的值拼内联 CSS，与前端共用同一份主题。\n\n\
         /// 主题色值（语义名与主题令牌一一对应）\n\
         pub(crate) struct Theme;\n\n\
         #[allow(dead_code)]\n\
         impl Theme {\n",
    );
    let mut vars = String::new();
    for (css_name, const_name) in LAN_THEME_TOKENS {
        let value = read_theme_token(&scss, css_name);
        code.push_str(&format!("    pub(crate) const {const_name}: &str = \"{value}\";\n"));
        // CSS 变量名去前缀转小写连字符：--bg-panel → tv-bg-panel
        let suffix = css_name.trim_start_matches("--");
        vars.push_str(&format!("  --tv-{suffix}: {value};\n"));
    }
    // 供页面直接内联的声明块（含整体配色方案与字体栈，与 ui-kit 的 :root 对齐）
    code.push_str(
        "}\n\n\
         /// 内联到对外页面的 CSS 自定义属性声明（`<style>:root{…}</style>` 用）\n\
         pub(crate) const CSS_VARS: &str = \"",
    );
    code.push_str(&vars.replace('\n', "\\n").replace('"', "\\\""));
    code.push_str("\";\n");

    let out = Path::new(out_dir).join("lan_theme.rs");
    let mut f = File::create(&out).expect("create lan_theme.rs");
    f.write_all(code.as_bytes()).expect("write lan_theme.rs");
}

fn collect_files(dir: &Path, base: &Path, prefix: &str, out: &mut Vec<(String, Vec<u8>)>) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                collect_files(&p, base, prefix, out);
            } else if let Ok(rel) = p.strip_prefix(base) {
                if let Ok(bytes) = std::fs::read(&p) {
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    out.push((format!("{prefix}/{rel_str}"), bytes));
                }
            }
        }
    }
}

/// repos（创意工坊）外置：release 构建把 public/repos 拷到 exe 同级
/// public/repos（OUT_DIR 上溯三级 = <target>/<profile>）。只补缺失文件、
/// 不覆盖已有文件——与运行时释放语义一致，用户写在 exe 旁的工坊文件不被
/// 重构建冲掉；debug 开发直接读仓库目录，无需拷贝。
fn copy_repos_to_target(manifest_dir: &str, out_dir: &str) {
    let src = PathBuf::from(manifest_dir).join("../public/repos");
    println!("cargo:rerun-if-changed={}", src.display());
    if std::env::var("PROFILE").as_deref() != Ok("release") {
        return;
    }
    let Some(profile_dir) = Path::new(out_dir).ancestors().nth(3) else {
        println!("cargo:warning=无法从 OUT_DIR 定位 target 目录，跳过 repos 外置拷贝");
        return;
    };
    let dest_root = profile_dir.join("public/repos");
    fn walk(src: &Path, dest: &Path, copied: &mut usize) {
        if !src.is_dir() {
            return;
        }
        let _ = std::fs::create_dir_all(dest);
        if let Ok(rd) = std::fs::read_dir(src) {
            for entry in rd.flatten() {
                let sp = entry.path();
                let dp = dest.join(entry.file_name());
                if sp.is_dir() {
                    walk(&sp, &dp, copied);
                } else if !dp.exists() && std::fs::copy(&sp, &dp).is_ok() {
                    *copied += 1;
                }
            }
        }
    }
    let mut copied = 0usize;
    walk(&src, &dest_root, &mut copied);
    println!("cargo:warning=repos externalized to {}: {copied} files copied", dest_root.display());
}

fn main() {
    tauri_build::build();

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let out_dir = std::env::var("OUT_DIR").unwrap();

    // 局域网对外页面的主题常量（改 variables.scss 会触发重编译并重新生成）
    emit_lan_theme(&manifest_dir, &out_dir);

    // 助手大脑的技能索引：.agents/skills → OUT_DIR/skills_index.json（运行时内嵌）
    let skill_count = build_skills::emit_skills_index(&manifest_dir, &out_dir);
    println!("cargo:warning=brain skills index: {skill_count} skills embedded");

    // 助手大脑的文档基图元：public/docs（submodule）→ OUT_DIR/docs_index.json
    let doc_count = build_docs::emit_docs_index(&manifest_dir, &out_dir);
    println!("cargo:warning=brain docs index: {doc_count} docs embedded");

    // 内嵌资源：internal / templates / exports（repos 外置，见 copy_repos_to_target）
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for kind in ["internal", "templates", "exports"] {
        let dir = PathBuf::from(&manifest_dir).join("../public").join(kind);
        println!("cargo:rerun-if-changed={}", dir.display());
        collect_files(&dir, &dir, kind, &mut entries);
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    // repos 外置：release 构建拷贝 public/repos → exe 同级 public/repos
    copy_repos_to_target(&manifest_dir, &out_dir);

    let mut raw: Vec<u8> = Vec::new();
    raw.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (path, data) in &entries {
        raw.extend_from_slice(&(path.len() as u32).to_le_bytes());
        raw.extend_from_slice(path.as_bytes());
        raw.extend_from_slice(&(data.len() as u32).to_le_bytes());
        raw.extend_from_slice(data);
    }

    let out_path = Path::new(&out_dir).join("builtin.bin");
    let mut f = File::create(&out_path).expect("create builtin.bin");
    f.write_all(&raw).expect("write builtin.bin");
}
