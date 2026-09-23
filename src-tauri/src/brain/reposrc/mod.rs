// ---------------------------------------------------------------------------
// 工坊资源文本层：public/repos 的文本资产（脚本原型/效果着色器/手册等）作为
// 神经图的动态扩展。与 skills/docs 的构建期内嵌不同，本层运行时从磁盘扫描：
// - 外部 repos 更新（增/删/改文件）经指纹比对自动重对齐图谱，无需重新编译；
// - 节点 id = "concept:repos:<分类>/<文件>"，与 docs 基图元同构（Concept 群）；
// - 目录与全文供助手 load_repo 直答（repos_doc_read / repos_doc_list 命令）。
// ---------------------------------------------------------------------------

pub mod ingest;

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::repos::{ext_of, is_text_file, parse_desc};

/// 单文件正文字符上限（load_repo 直答返回用；嵌入词料只用标题+描述，不受此限）
const MAX_BODY_CHARS: usize = 20_000;
/// 摘要兜底：无 // @desc: 时取正文首个非空行的截断长度
const SUMMARY_FALLBACK_CHARS: usize = 80;

/// 工坊资源文档（图节点与直答共用形态）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDoc {
    /// 相对 id："<分类>/<文件名>"（如 "code/Rotator.ts"）
    pub id: String,
    pub title: String,
    pub summary: String,
    pub body: String,
}

/// 资源目录项（load_repo 缺/错 id 时回喂，不含正文）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoBrief {
    pub id: String,
    pub title: String,
    pub summary: String,
}

impl From<&RepoDoc> for RepoBrief {
    fn from(d: &RepoDoc) -> RepoBrief {
        RepoBrief { id: d.id.clone(), title: d.title.clone(), summary: d.summary.clone() }
    }
}

/// 扫描仓库根下全部分类的文本文件（分类 = 一级子目录；跳过隐藏项，
/// 按分类+文件名排序保证顺序稳定）
pub fn scan(root: &Path) -> Vec<RepoDoc> {
    let mut docs = Vec::new();
    let Ok(cats) = fs::read_dir(root) else {
        return docs;
    };
    let mut cat_names: Vec<String> = cats
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.'))
        .collect();
    cat_names.sort();
    for cat in cat_names {
        let dir = root.join(&cat);
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        let mut names: Vec<String> = rd
            .flatten()
            .filter(|e| e.path().is_file())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| !n.starts_with('.'))
            .collect();
        names.sort();
        for file in names {
            let ext = ext_of(&file);
            if !is_text_file(&ext) {
                continue;
            }
            let Ok(raw) = fs::read_to_string(dir.join(&file)) else {
                continue;
            };
            docs.push(build_doc(&cat, &file, &raw));
        }
    }
    docs
}

fn build_doc(cat: &str, file: &str, raw: &str) -> RepoDoc {
    let body: String = raw.chars().take(MAX_BODY_CHARS).collect();
    let title = match file.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem.to_string(),
        _ => file.to_string(),
    };
    let mut summary = parse_desc(&body);
    if summary.is_empty() {
        summary = body
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(|l| l.chars().take(SUMMARY_FALLBACK_CHARS).collect())
            .unwrap_or_default();
    }
    RepoDoc { id: format!("{cat}/{file}"), title, summary, body }
}

/// 仓库指纹：分类目录与其直属文件的 (相对名, 大小, mtime) 排序后折叠 FNV。
/// 覆盖面与 scan 完全一致——外部增删改任一被摄取的文件即变。
pub fn fingerprint(root: &Path) -> u64 {
    let mut items = collect_meta(root);
    items.sort();
    let mut h = crate::brain::model::fnv1a64("tve-repos-layer");
    for (rel, len, mtime) in items {
        for part in [rel, format!("{len}"), format!("{mtime}")] {
            h ^= crate::brain::model::fnv1a64(&part);
            h = h.wrapping_mul(0x1000_0000_01b3);
        }
    }
    h
}

type Meta = (String, u64, u128);

fn collect_meta(root: &Path) -> Vec<Meta> {
    let mut out = Vec::new();
    let Ok(cats) = fs::read_dir(root) else {
        return out;
    };
    for c in cats.flatten() {
        let cp = c.path();
        if !cp.is_dir() {
            continue;
        }
        let cat = c.file_name().to_string_lossy().to_string();
        if cat.starts_with('.') {
            continue;
        }
        push_meta(&mut out, &cat, &cp);
        let Ok(files) = fs::read_dir(&cp) else { continue };
        for f in files.flatten() {
            let fp = f.path();
            if !fp.is_file() {
                continue;
            }
            let name = f.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            push_meta(&mut out, &format!("{cat}/{name}"), &fp);
        }
    }
    out
}

fn push_meta(out: &mut Vec<Meta>, rel: &str, p: &Path) {
    let Ok(md) = fs::metadata(p) else { return };
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    out.push((rel.to_string(), md.len(), mtime));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tve_reposrc_{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scans_text_files_sorted_and_skips_noise() {
        let root = temp_root("scan");
        let code = root.join("code");
        fs::create_dir_all(&code).unwrap();
        fs::write(code.join("B.ts"), "// @desc: 旋转原型\nclass B {}\n").unwrap();
        fs::write(code.join("A.ts"), "class A {}\n").unwrap();
        fs::write(code.join(".hidden.ts"), "class H {}\n").unwrap();
        fs::write(code.join("pic.png"), "binary-ish").unwrap();
        fs::create_dir_all(code.join("sub")).unwrap();
        let effect = root.join("effect");
        fs::create_dir_all(&effect).unwrap();
        fs::write(effect.join("Rim.shader"), "// @desc: 边缘光\nShader \"e/R\"\n{\n}\n").unwrap();

        let docs = scan(&root);
        assert_eq!(
            docs.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            vec!["code/A.ts", "code/B.ts", "effect/Rim.shader"],
            "应按分类+文件名排序，跳过隐藏/二进制/子目录"
        );
        let b = &docs[1];
        assert_eq!(b.title, "B");
        assert_eq!(b.summary, "旋转原型", "描述取首部 @desc");
        assert!(b.body.starts_with("// @desc:"));
        assert_eq!(docs[0].summary, "class A {}", "无 @desc 时取首个非空行兜底");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn fingerprint_tracks_add_remove_and_edit() {
        let root = temp_root("finger");
        let code = root.join("code");
        fs::create_dir_all(&code).unwrap();
        let base = fingerprint(&root);
        fs::write(code.join("A.ts"), "class A {}\n").unwrap();
        assert_ne!(fingerprint(&root), base, "新增文件应改变指纹");
        let after_add = fingerprint(&root);
        assert_eq!(fingerprint(&root), after_add, "未变更时指纹必须稳定");
        fs::write(code.join("A.ts"), "class A {} // 加长\n").unwrap();
        assert_ne!(fingerprint(&root), after_add, "编辑文件应改变指纹");
        fs::remove_file(code.join("A.ts")).unwrap();
        let after_remove = fingerprint(&root);
        assert_eq!(fingerprint(&root), after_remove, "未变更时指纹必须稳定");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_root_scans_empty_and_fingerprint_stable() {
        let missing = std::env::temp_dir().join("tve_reposrc_no_such_dir");
        assert!(scan(&missing).is_empty());
        assert_eq!(fingerprint(&missing), fingerprint(&missing), "缺根目录指纹稳定");
    }
}
