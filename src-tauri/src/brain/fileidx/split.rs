// ---------------------------------------------------------------------------
// 文件内模块切分：把单个文本文件切成带行号与标题的模块，供索引摘要与向量
// 检索使用。三种策略按扩展名分派：Markdown 按标题、代码按顶格声明、其余按
// 定窗（吸附空行）；超限模块二次硬切。纯结构规则，确定性输出。
// ---------------------------------------------------------------------------

/// 单个原始模块（行号 1-based，闭区间）
#[derive(Debug, Clone)]
pub struct RawModule {
    pub title: String,
    pub line_start: usize,
    pub line_end: usize,
    pub body: String,
}

/// 窗口目标行数；模块行数 / 字符数硬上限（超过即二次切分）
pub const WINDOW_LINES: usize = 150;
pub const MAX_MODULE_LINES: usize = 220;
pub const MAX_MODULE_CHARS: usize = 24 * 1024;

const MARKDOWN_EXTS: &[&str] = &["md", "mdx"];
const CODE_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "py", "css", "scss", "glsl", "wgsl",
];
/// 顶格声明前缀（命中即起新模块；import/注释/属性行不在此列）
const DECL_PREFIXES: &[&str] = &[
    "fn ", "pub ", "struct ", "impl ", "enum ", "trait ", "mod ", "class ", "function ", "export ",
    "interface ", "type ", "def ", "async def ",
];

pub fn split_modules(content: &str, ext: &str) -> Vec<RawModule> {
    let lines: Vec<&str> = content.lines().collect();
    let mut raw = if MARKDOWN_EXTS.contains(&ext) {
        split_by_headings(&lines)
    } else if CODE_EXTS.contains(&ext) {
        split_by_decls(&lines)
    } else {
        let mut v = Vec::new();
        push_windows(&mut v, &lines, 0, lines.len(), None);
        v
    };
    let mut out = Vec::new();
    for m in raw.drain(..) {
        if m.line_end - m.line_start + 1 > MAX_MODULE_LINES || m.body.chars().count() > MAX_MODULE_CHARS
        {
            let base = m.title.clone();
            push_windows(&mut out, &lines, m.line_start - 1, m.line_end, Some(&base));
        } else {
            out.push(m);
        }
    }
    out.retain(|m| !m.body.trim().is_empty());
    out
}

fn push_module(out: &mut Vec<RawModule>, title: String, lines: &[&str], start: usize, end: usize) {
    if end > start {
        out.push(RawModule {
            title,
            line_start: start + 1,
            line_end: end,
            body: lines[start..end].join("\n"),
        });
    }
}

/// Markdown：标题行（#~######，跳过围栏代码块）起新模块；首标题前为导语。
/// 空节（标题后紧跟下一标题）不产出模块，标题行并入下一模块正文。
fn split_by_headings(lines: &[&str]) -> Vec<RawModule> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut title = String::from("导语");
    let mut in_fence = false;
    for (i, line) in lines.iter().enumerate() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(h) = heading_text(line) {
            let body_from = if start == 0 && title == "导语" { start } else { start + 1 };
            if lines[body_from..i].iter().any(|l| !l.trim().is_empty()) {
                push_module(&mut out, title.clone(), lines, start, i);
            }
            start = i;
            title = h;
        }
    }
    let body_from = if start == 0 && title == "导语" { start } else { start + 1 };
    if lines[body_from..lines.len()].iter().any(|l| !l.trim().is_empty()) {
        push_module(&mut out, title, lines, start, lines.len());
    }
    out
}

fn heading_text(line: &str) -> Option<String> {
    let t = line.trim_start();
    let level = t.chars().take_while(|&c| c == '#').count();
    if (1..=6).contains(&level) {
        let rest = t[level..].trim();
        if !rest.is_empty() {
            return Some(rest.chars().take(80).collect());
        }
    }
    None
}

/// 代码：顶格声明起新模块；声明上方的属性/文档注释行回吞归入新模块；
/// 顶格内容（头注释/导入）归「文件头」。无任何声明时整文件为单模块。
fn split_by_decls(lines: &[&str]) -> Vec<RawModule> {
    let mut bounds: Vec<(usize, String)> = vec![(0, "文件头".to_string())];
    for (i, line) in lines.iter().enumerate() {
        if !is_decl(line) {
            continue;
        }
        let prev = bounds.last().map(|(b, _)| *b).unwrap_or(0);
        let mut s = i;
        while s > prev && attr_or_doc(lines[s - 1]) {
            s -= 1;
        }
        if s > prev {
            bounds.push((s, decl_title(line)));
        } else if s == prev {
            // 前一界限之后无正文（声明在文件首行，或属性/注释紧邻声明）：
            // 该界限未获得内容，标题让给当前声明
            bounds.last_mut().expect("bounds 非空").1 = decl_title(line);
        }
    }
    let mut out = Vec::new();
    for w in bounds.windows(2) {
        push_module(&mut out, w[0].1.clone(), lines, w[0].0, w[1].0);
    }
    let (last_start, last_title) = bounds.last().expect("bounds 非空").clone();
    push_module(&mut out, last_title, lines, last_start, lines.len());
    out
}

fn is_decl(line: &str) -> bool {
    !line.is_empty()
        && !line.starts_with(char::is_whitespace)
        && DECL_PREFIXES.iter().any(|p| line.starts_with(p))
}

fn attr_or_doc(line: &str) -> bool {
    let t = line.trim();
    !t.is_empty()
        && ["#[", "///", "//", "/*", "*", "@"]
            .iter()
            .any(|p| t.starts_with(p))
}

fn decl_title(line: &str) -> String {
    format!("声明 {}", line.trim().chars().take(80).collect::<String>())
}

/// 定窗切分：每窗 ≤WINDOW_LINES 行且 ≤MAX_MODULE_CHARS 字符，窗界向后吸附
/// 到窗口后 30% 内最近的空行；base_title 给定时子窗标题带「·序号」后缀。
fn push_windows(out: &mut Vec<RawModule>, lines: &[&str], from: usize, to: usize, base_title: Option<&str>) {
    let mut start = from;
    let mut idx = 1;
    while start < to {
        let limit = (start + WINDOW_LINES).min(to);
        let mut end = start;
        let mut chars = 0usize;
        while end < limit {
            chars += lines[end].chars().count() + 1;
            if end > start && (end - start >= WINDOW_LINES || chars > MAX_MODULE_CHARS) {
                break;
            }
            end += 1;
        }
        if end < to {
            let lo = start + (end - start) * 7 / 10;
            for i in (lo..end).rev() {
                if lines[i].trim().is_empty() {
                    end = i + 1;
                    break;
                }
            }
        }
        if end <= start {
            end = start + 1;
        }
        let title = match base_title {
            Some(base) => format!("{base}·{idx}"),
            None => format!("第{}段 L{}-{}", idx, start + 1, end),
        };
        push_module(out, title, lines, start, end);
        idx += 1;
        start = end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_splits_by_headings_and_skips_fence_hashes() {
        let content = "# 总览\nintro line\n```bash\n# not a heading\n```\n## 安装\npip install\n## 用法\nrun it\n";
        let ms = split_modules(content, "md");
        assert_eq!(ms.len(), 3, "导语/安装/用法 三模块：{ms:?}");
        assert_eq!(ms[0].title, "总览");
        assert_eq!(ms[1].title, "安装");
        assert_eq!(ms[1].line_start, 6);
        assert_eq!(ms[2].title, "用法");
        assert!(ms.iter().all(|m| !m.body.contains("not a heading") || m.line_start == 1));
    }

    #[test]
    fn code_splits_by_decls_and_attaches_doc_comments() {
        let content = "// 头注释\nuse std::fmt;\n\n/// 文档\n#[cfg(unix)]\nfn alpha() {\n    a();\n}\n\nfn beta() {\n    b();\n}\n";
        let ms = split_modules(content, "rs");
        assert_eq!(ms.len(), 3, "文件头 + alpha + beta：{ms:?}");
        assert_eq!(ms[0].title, "文件头");
        assert!(ms[1].title.contains("fn alpha"));
        assert!(ms[1].body.starts_with("/// 文档"), "属性行与文档注释应回吞进声明模块");
    }

    #[test]
    fn fallback_windows_cover_all_lines_and_snap_to_blank() {
        let mut content = String::new();
        for i in 0..400 {
            content.push_str(&format!("line {i}\n"));
            if i % 20 == 19 {
                content.push('\n');
            }
        }
        let ms = split_modules(&content, "txt");
        assert!(ms.len() >= 3, "400 行应多窗：{}", ms.len());
        assert_eq!(ms.first().expect("非空").line_start, 1);
        assert_eq!(ms.last().expect("非空").line_end, 420, "行号闭区间覆盖到末行");
        for w in ms.windows(2) {
            assert_eq!(w[1].line_start, w[0].line_end + 1, "窗口行号应连续衔接");
        }
        assert!(ms.iter().all(|m| m.line_end - m.line_start + 1 <= MAX_MODULE_LINES));
    }

    #[test]
    fn oversize_module_gets_secondary_split() {
        let mut content = String::from("fn big() {\n");
        for i in 0..500 {
            content.push_str(&format!("    x{i} = {i};\n\n"));
        }
        content.push_str("}\n");
        let ms = split_modules(&content, "rs");
        assert!(ms.len() >= 3, "超限单声明应二次切分：{}", ms.len());
        assert!(ms.iter().all(|m| m.line_end - m.line_start + 1 <= MAX_MODULE_LINES));
        assert!(ms[0].title.contains("fn big"), "子窗标题保留父标题");
    }

    #[test]
    fn empty_and_whitespace_content_yield_no_modules() {
        assert!(split_modules("", "txt").is_empty());
        assert!(split_modules("\n \n\t\n", "md").is_empty());
    }
}
