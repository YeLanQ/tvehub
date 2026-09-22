//! 构建期技能索引生成：扫描仓库 `.agents/skills/*/SKILL.md`，解析 frontmatter
//! （name/description + 正文），写入 `OUT_DIR/skills_index.json`。
//! 运行时 brain::skillsrc 经 include_str! 内嵌该索引——技能组改动会触发
//! rerun-if-changed 重新编译，Rust 侧与 .agents 永不分叉（与 lan_theme 同思路）。
//! .agents 目录缺失（如单 crate 分发）时写空索引，不阻塞构建。

use std::fs;
use std::path::{Path, PathBuf};

pub const INDEX_FILE: &str = "skills_index.json";

struct RawSkill {
    id: String,
    name: String,
    description: String,
    body: String,
}

/// 解析 SKILL.md：`---` 包裹的 frontmatter 取 name/description，id 取目录名。
fn parse_skill(dir_name: &str, text: &str) -> Option<RawSkill> {
    let rest = text.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    let front = &rest[..end];
    let body = rest[end + 4..].trim_start_matches(['\n', '-']).to_string();
    let mut name = String::new();
    let mut description = String::new();
    for line in front.lines() {
        if let Some(v) = line.strip_prefix("name:") {
            name = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("description:") {
            description = v.trim().to_string();
        }
    }
    if name.is_empty() || description.is_empty() {
        return None;
    }
    Some(RawSkill {
        id: dir_name.to_string(),
        name,
        description,
        body,
    })
}

fn scan_skills(root: &Path) -> Vec<RawSkill> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return out;
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    for dir in dirs {
        let Some(name) = dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let md = dir.join("SKILL.md");
        if let Ok(text) = fs::read_to_string(&md) {
            if let Some(skill) = parse_skill(name, &text) {
                out.push(skill);
            }
        }
    }
    out
}

/// 手写 JSON 字符串转义（build.rs 不引 serde_json，控制构建依赖面）
pub(crate) fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// 生成技能索引到 OUT_DIR；返回写入了多少条（供构建日志观察）。
pub fn emit_skills_index(manifest_dir: &str, out_dir: &str) -> usize {
    let root = Path::new(manifest_dir).join("../.agents/skills");
    println!("cargo:rerun-if-changed={}", root.display());
    let skills = scan_skills(&root);
    let mut json = String::from("[");
    for (i, s) in skills.iter().enumerate() {
        if i > 0 {
            json.push(',');
        }
        json.push_str(&format!(
            "{{\"id\":\"{}\",\"name\":\"{}\",\"description\":\"{}\",\"body\":\"{}\"}}",
            json_escape(&s.id),
            json_escape(&s.name),
            json_escape(&s.description),
            json_escape(&s.body)
        ));
    }
    json.push(']');
    let path = Path::new(out_dir).join(INDEX_FILE);
    fs::write(&path, json).expect("写 skills_index.json 失败");
    skills.len()
}
