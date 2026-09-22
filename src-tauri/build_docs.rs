//! 构建期文档索引生成：扫描 `public/docs/**/*.md`（docs submodule），提取
//! 相对路径 / 标题 / 纯文本摘要，写 `OUT_DIR/docs_index.json`。运行时
//! brain::docsrc 经 include_str! 内嵌——docs 是大脑神经图的概念基图元，
//! 与技能索引共同保证语义检索在任何冷启动下都有非空底料。docs 目录缺失
//! （如单 crate 分发）时写空索引，不阻塞构建。

use std::fs;
use std::path::{Path, PathBuf};

pub const INDEX_FILE: &str = "docs_index.json";

/// 摘要字符上限（嵌入是 128 维哈希，词料适中即可，控制二进制体积）
const SUMMARY_CHARS: usize = 220;

struct RawDoc {
    id: String,
    title: String,
    summary: String,
}

/// 提取标题（首个 `# ` 行，无则用文件名）与纯文本摘要
fn parse_doc(rel: &str, text: &str) -> Option<RawDoc> {
    let mut title = String::new();
    for line in text.lines() {
        let t = line.trim();
        if let Some(h) = t.strip_prefix("# ") {
            title = h.trim().to_string();
            break;
        }
    }
    let summary = plain_text(text, SUMMARY_CHARS);
    if summary.is_empty() {
        return None;
    }
    if title.is_empty() {
        title = Path::new(rel)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(rel)
            .to_string();
    }
    Some(RawDoc { id: rel.to_string(), title, summary })
}

/// markdown → 粗纯文本：跳过代码块与 HTML 行，剥离记号与表格分隔，压空白
fn plain_text(text: &str, limit: usize) -> String {
    let mut out = String::new();
    let mut in_fence = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("```") {
            in_fence = !in_fence;
            out.push(' ');
            continue;
        }
        if in_fence || t.is_empty() || t.starts_with('<') {
            continue;
        }
        if t.starts_with('|') {
            // 表格行：保留单元格文字，丢弃分隔与竖线
            for cell in t.trim_matches('|').split('|') {
                let c = cell.trim();
                if !c.is_empty() && !c.chars().all(|ch| ch == '-' || ch == ':') {
                    out.push_str(c);
                    out.push(' ');
                }
            }
            continue;
        }
        let stripped = t.trim_start_matches(['#', '>', '-']).trim();
        let cleaned: String = stripped
            .chars()
            .filter(|ch| !matches!(ch, '*' | '`' | '_' | '[' | ']' | '(' | ')'))
            .collect();
        if !cleaned.trim().is_empty() {
            out.push_str(cleaned.trim());
            out.push(' ');
        }
        if out.chars().count() >= limit {
            break;
        }
    }
    let compact = out.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(limit).collect()
}

fn scan_docs(root: &Path, dir: &Path, rel: &str, out: &mut Vec<RawDoc>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for p in paths {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let child_rel = if rel.is_empty() { name.to_string() } else { format!("{rel}/{name}") };
        if p.is_dir() {
            scan_docs(root, &p, &child_rel, out);
        } else if name.ends_with(".md") {
            if let Ok(text) = fs::read_to_string(&p) {
                if let Some(doc) = parse_doc(&child_rel, &text) {
                    out.push(doc);
                }
            }
        }
    }
}

/// 生成索引，返回内嵌文档数
pub fn emit_docs_index(manifest_dir: &str, out_dir: &str) -> usize {
    let root = Path::new(manifest_dir).join("../public/docs");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut docs = Vec::new();
    scan_docs(&root, &root, "", &mut docs);

    let mut json = String::from("[");
    for (i, d) in docs.iter().enumerate() {
        if i > 0 {
            json.push(',');
        }
        json.push_str(&format!(
            "{{\"id\":\"{}\",\"title\":\"{}\",\"summary\":\"{}\"}}",
            super::build_skills::json_escape(&d.id),
            super::build_skills::json_escape(&d.title),
            super::build_skills::json_escape(&d.summary)
        ));
    }
    json.push(']');
    fs::write(Path::new(out_dir).join(INDEX_FILE), json).expect("写 docs_index.json 失败");
    docs.len()
}
