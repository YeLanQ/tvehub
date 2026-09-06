//! 保守型 JS 压缩（发布模式用）：
//! - 删除行/块注释（注释按空白分隔符处理——块注释含换行时按换行对待，保 ASI）；
//! - 连续空白折叠：仅当安全时删除（两侧不同时为词字符、非 `++`/`--` 相邻）；
//!   原空白含换行时永远保留一个空格 —— ASI 依赖真实换行，保留空格即保持
//!   `a\n++b`、`return\nx`、`foo\n(x)` 等受限产物的原语义；
//! - 字符串/模板串（含 `${}` 嵌套）/正则字面量按哨兵原样拷贝；
//! - `/` 是正则还是除法按前文启发式判定：词字符之后仅关键字（return/typeof/…）
//!   时为正则；`)`/`]` 之后为除法；`++`/`--` 之后为除法；其余为正则。
//! 不做标识符重命名等改写，任何合法 JS 压缩后语义不变。

/// 其后允许出现正则字面量的关键字（词字符之后 `/` 为正则仅限于此表）
const KEYWORDS_BEFORE_REGEX: [&str; 13] = [
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case",
    "do", "else", "yield",
];

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// 压缩一段 UTF-8 JS 源码（ESM/CJS 通用）
pub fn minify_js(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    let mut prev_sig: Option<char> = None; // 最近写出的代码字符（空白/注释不计）
    let mut prev_sig2: Option<char> = None; // 前一个 prev_sig（`++`/`--` 判定用）
    let mut last_word = String::new(); // 最近的完整词（关键字判定用）
    let mut pending_space = false; // 有待定空白
    let mut pending_newline = false; // 待定空白源自换行（ASI 保护，禁止删除）
    // 模板串栈：`${` 进入代码态，元素为该插值的花括号深度，`}` 配对后回模板字面态
    let mut template_stack: Vec<usize> = Vec::new();
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        match c {
            ' ' | '\t' | '\r' | '\n' => {
                pending_space = true;
                if c == '\n' {
                    pending_newline = true;
                }
                i += 1;
            }
            '/' if i + 1 < chars.len() && chars[i + 1] == '/' => {
                // 行注释：分隔符；其后换行由主循环按换行处理
                pending_space = true;
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if i + 1 < chars.len() && chars[i + 1] == '*' => {
                // 块注释：分隔符；含换行按换行对待（ASI）
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    if chars[i] == '\n' {
                        pending_newline = true;
                    }
                    i += 1;
                }
                i = (i + 2).min(chars.len());
                pending_space = true;
            }
            '/' if regex_allowed(prev_sig, prev_sig2, &last_word) => {
                let (next_i, last) = copy_regex(&chars, i, &mut out);
                i = next_i;
                finish_token(&mut prev_sig, &mut prev_sig2, &mut last_word, Some(last));
                pending_space = false;
                pending_newline = false;
            }
            '"' | '\'' => {
                let last = copy_string(&chars, i, c, &mut out);
                i = last.0;
                finish_token(&mut prev_sig, &mut prev_sig2, &mut last_word, Some(last.1));
                pending_space = false;
                pending_newline = false;
            }
            '`' => {
                template_stack.push(0);
                let last = copy_template_chunk(&chars, i, &mut out);
                i = last.0;
                finish_token(&mut prev_sig, &mut prev_sig2, &mut last_word, Some(last.1));
                pending_space = false;
                pending_newline = false;
            }
            '}' if template_stack.last() == Some(&0) => {
                // 插值结束，回到模板串字面部分
                template_stack.pop();
                let last = copy_template_chunk(&chars, i, &mut out);
                i = last.0;
                finish_token(&mut prev_sig, &mut prev_sig2, &mut last_word, Some(last.1));
                pending_space = false;
                pending_newline = false;
            }
            _ => {
                flush_space(&mut out, pending_space, pending_newline, prev_sig, Some(c));
                if is_word(c) {
                    last_word.push(c);
                } else {
                    last_word.clear();
                }
                if let Some(depth) = template_stack.last_mut() {
                    if c == '{' {
                        *depth += 1;
                    } else if c == '}' {
                        *depth = depth.saturating_sub(1);
                    }
                }
                out.push(c);
                finish_token(&mut prev_sig, &mut prev_sig2, &mut last_word, Some(c));
                pending_space = false;
                pending_newline = false;
                i += 1;
            }
        }
    }
    out
}

/// 记录最近写出的有效字符（last_word 的维护由调用方在词字符分支处理）
fn finish_token(
    prev_sig: &mut Option<char>,
    prev_sig2: &mut Option<char>,
    _last_word: &mut String,
    c: Option<char>,
) {
    if let Some(c) = c {
        *prev_sig2 = *prev_sig;
        *prev_sig = Some(c);
    }
}

/// 写出待定空白：仅当需要时保留一个空格（换行来源 / 两侧词字符相邻 / `++`、`--` 相邻）
fn flush_space(out: &mut String, pending: bool, from_newline: bool, prev: Option<char>, next: Option<char>) {
    if !pending {
        return;
    }
    let keep = from_newline
        || match (prev, next) {
            (Some(p), Some(n)) => (is_word(p) && is_word(n)) || ((p == '+' || p == '-') && n == p),
            _ => false,
        };
    if keep {
        out.push(' ');
    }
}

/// `/` 此处是否可作为正则字面量起始（启发式）
fn regex_allowed(prev_sig: Option<char>, prev_sig2: Option<char>, last_word: &str) -> bool {
    match prev_sig {
        None => true,
        Some(c) => {
            if is_word(c) {
                return KEYWORDS_BEFORE_REGEX.contains(&last_word);
            }
            match c {
                ')' | ']' => false,
                '+' | '-' => prev_sig2 != Some(c), // `++`/`--` 之后是除法
                _ => true,
            }
        }
    }
}

/// 拷贝字符串字面量（含转义），返回（新下标，末字符）
fn copy_string(chars: &[char], mut i: usize, quote: char, out: &mut String) -> (usize, char) {
    let start = out.len();
    out.push(chars[i]);
    i += 1;
    while i < chars.len() {
        let c = chars[i];
        out.push(c);
        i += 1;
        if c == '\\' && i < chars.len() {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        if c == quote {
            break;
        }
    }
    (i, out[start..].chars().last().unwrap_or('"'))
}

/// 拷贝正则字面量（含 `[...]` 类与转义；`/` 在类内不终止）+ flags，返回（新下标，末字符）
fn copy_regex(chars: &[char], mut i: usize, out: &mut String) -> (usize, char) {
    let start = out.len();
    out.push(chars[i]); // 起始 '/'
    i += 1;
    let mut in_class = false;
    while i < chars.len() {
        let c = chars[i];
        out.push(c);
        i += 1;
        match c {
            '\\' if i < chars.len() => {
                out.push(chars[i]);
                i += 1;
            }
            '[' => in_class = true,
            ']' => in_class = false,
            '/' if !in_class => break,
            _ => {}
        }
    }
    while i < chars.len() && is_word(chars[i]) {
        out.push(chars[i]);
        i += 1;
    }
    (i, out[start..].chars().last().unwrap_or('/'))
}

/// 拷贝模板串字面部分到串尾或 `${`（进入代码态），返回（新下标，末字符）
fn copy_template_chunk(chars: &[char], mut i: usize, out: &mut String) -> (usize, char) {
    let start = out.len();
    out.push(chars[i]); // '`' 或 '}'
    i += 1;
    while i < chars.len() {
        let c = chars[i];
        out.push(c);
        i += 1;
        if c == '\\' && i < chars.len() {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        if c == '`' {
            break;
        }
        if c == '$' && i < chars.len() && chars[i] == '{' {
            out.push('{');
            i += 1;
            break;
        }
    }
    (i, out[start..].chars().last().unwrap_or('`'))
}

#[cfg(test)]
mod tests {
    use super::minify_js;

    #[test]
    fn removes_comments_and_indents() {
        let src = "// line\nexport  const  A = 1;  /* block */\nconst B = 2;\n";
        let out = minify_js(src);
        assert!(!out.contains("//") && !out.contains("/*"));
        assert!(out.contains("export const A=1;"), "out={out}");
        assert!(out.contains("const B=2;"), "out={out}");
    }

    #[test]
    fn comment_is_a_separator() {
        // 注释删除后仍需保留 token 边界
        assert_eq!(minify_js("let a/*x*/b;"), "let a b;");
    }

    #[test]
    fn preserves_strings_and_templates() {
        let src = "const a = \"x // y\";\nconst b = `t ${a /*c*/ + 1} end`;\nconst c = 's';\n";
        let out = minify_js(src);
        assert!(out.contains("\"x // y\""));
        assert!(out.contains("`t ${a+1} end`"), "out={out}");
        assert!(out.contains("'s'"));
    }

    #[test]
    fn asi_and_incdec_safe() {
        // 换行来源的空白永不删除：ASI 受限产物语义不变
        assert_eq!(minify_js("let a = 1\n++b;\n"), "let a=1 ++b;");
        assert_eq!(minify_js("function f(){return\nx}\n"), "function f(){return x}");
        // 空格来源：非词相邻可删
        assert_eq!(minify_js("a = b + ++c;\n"), "a=b+ ++c;");
    }

    #[test]
    fn regex_vs_division() {
        assert_eq!(minify_js("const r = /[a//b]/g;\n"), "const r=/[a//b]/g;");
        assert_eq!(minify_js("return /x/.test(s);\n"), "return/x/.test(s);");
        assert_eq!(minify_js("y = a++ / 2;\n"), "y=a++/2;");
        assert_eq!(minify_js("y = a / b / c;\n"), "y=a/b/c;");
        assert_eq!(minify_js("if (a) /x/.test(b);\n"), "if(a)/x/.test(b);");
    }

    #[test]
    fn import_export_preserved() {
        let src = "import * as THREE from \"./three.module.min.js\";\nimport { A } from \"./x.mjs\";\nexport async function f() { return 1; }\n";
        let out = minify_js(src);
        assert!(out.contains("import*as THREE from\"./three.module.min.js\""), "out={out}");
        assert!(out.contains("import{A}from\"./x.mjs\""), "out={out}");
        assert!(out.contains("export async function f(){return 1;}"), "out={out}");
    }
}

