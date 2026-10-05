//! 模块说明符扫描与重写：把运行时代码里解析到产物内文件的相对 import/export
//! 重写为目标说明符（单页内联模块 → `tve:<路径>` 裸说明符；CDN three → 绝对 URL），
//! 单页/多文件两种形态共用。

use std::collections::HashMap;

/// 单页内联模块的裸说明符前缀：相对 import 重写为 `tve:<产物内路径>`，
/// 由引导脚本注入的 import map 映射到 Blob URL
const INLINE_MODULE_PREFIX: &str = "tve:";

fn is_js_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

/// 解析相对说明符（./a、../a）为产物内相对路径；带 ?query/#hash 后缀原样保留。
/// 返回 (产物内相对路径, 后缀)。
fn resolve_relative_spec(dir: &str, spec: &str) -> Option<(String, String)> {
    if !spec.starts_with("./") && !spec.starts_with("../") {
        return None;
    }
    let (path, suffix) = match spec.find(['?', '#']) {
        Some(i) => (&spec[..i], spec[i..].to_string()),
        None => (spec, String::new()),
    };
    let mut segs: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    for part in path.split('/') {
        match part {
            "." | "" => {}
            ".." => {
                segs.pop();
            }
            p => segs.push(p),
        }
    }
    Some((segs.join("/"), suffix))
}

/// 单行引号字符串读取：返回 (字符串内容, 结束引号后的字节偏移)；
/// 起始偏移须指向引号，支持反斜杠转义
fn read_quoted(text: &str, start: usize) -> Option<(&str, usize)> {
    let b = text.as_bytes();
    let quote = *b.get(start)?;
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    let mut k = start + 1;
    while k < b.len() {
        if b[k] == b'\\' {
            k += 2;
            continue;
        }
        if b[k] == quote {
            return Some((&text[start + 1..k], k + 1));
        }
        k += 1;
    }
    None
}

/// 重写一段模块文本：import/export from 的相对说明符与 import("./x") 动态导入，
/// 解析（相对本模块目录）到 remap 表内的产物相对路径时替换为其映射的说明符
/// （单页内联模块 → `tve:<路径>` 裸说明符；CDN 模式的 three → 绝对 URL），
/// 其余原样保留
pub(super) fn rewrite_specifier_text(
    text: &str,
    dir: &str,
    remap: &HashMap<String, String>,
) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len() + 32);
    let mut i = 0;
    while i < b.len() {
        // 关键字起点（词边界）：import / from
        let kw = if is_js_word(b[i]) && (i == 0 || !is_js_word(b[i - 1])) {
            if text[i..].starts_with("import") && (i + 6 >= b.len() || !is_js_word(b[i + 6])) {
                Some((i, 6, true))
            } else if text[i..].starts_with("from") && (i + 4 >= b.len() || !is_js_word(b[i + 4])) {
                Some((i, 4, false))
            } else {
                None
            }
        } else {
            None
        };
        let Some((kw_at, kw_len, is_import)) = kw else {
            let ch = text[i..]
                .chars()
                .next()
                .expect("扫描按字符边界推进，切片起点必为字符边界");
            out.push(ch);
            i += ch.len_utf8();
            continue;
        };

        // 关键字后跳过空白，定位字符串字面量（静态 from/import 后直接字符串；
        // 动态 import 后还有一层括号）
        let mut j = kw_at + kw_len;
        let skip_ws = |j: &mut usize, b: &[u8]| {
            while *j < b.len() && (b[*j] as char).is_ascii_whitespace() {
                *j += 1;
            }
        };
        skip_ws(&mut j, b);
        if is_import && j < b.len() && b[j] == b'(' {
            j += 1;
            skip_ws(&mut j, b);
        }
        if let Some((spec, after)) = read_quoted(text, j) {
            if let Some((rel, suffix)) = resolve_relative_spec(dir, spec) {
                if let Some(to) = remap.get(&rel) {
                    out.push_str(&text[i..j]);
                    out.push_str(&text[j..=j]);
                    out.push_str(to);
                    out.push_str(&suffix);
                    out.push(text.as_bytes()[j] as char);
                    i = after;
                    continue;
                }
            }
        }

        // 未命中：整段关键字原样复制，从关键字后继续扫描
        out.push_str(&text[i..j.min(b.len())]);
        i = j;
    }
    out
}

/// 单页模式：把运行时代码里的相对 import/export 说明符重写为 `tve:<相对路径>`
/// 裸说明符（运行时由引导脚本的 import map 映射到 Blob URL 加载）；
/// extra_remap 为代码表之外的补充映射（CDN 模式的 three 运行时 → 绝对 URL，
/// blob 模块无法解析相对 import，须一并改写）
pub(super) fn rewrite_module_imports(
    code: &mut HashMap<String, String>,
    extra_remap: &HashMap<String, String>,
) {
    let mut remap: HashMap<String, String> = code
        .keys()
        .map(|rel| (rel.clone(), format!("{INLINE_MODULE_PREFIX}{rel}")))
        .collect();
    for (k, v) in extra_remap {
        remap.insert(k.clone(), v.clone());
    }
    let rels: Vec<String> = code.keys().cloned().collect();
    for rel in rels {
        let dir = match rel.rfind('/') {
            Some(i) => &rel[..=i],
            None => "",
        };
        let text = code.get_mut(&rel).expect("rel 来自同表 keys 快照，条目必在");
        *text = rewrite_specifier_text(text, dir, &remap);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    /// 单页说明符重写：相对路径解析（./ ../）、引号/空白变体、未知目标不重写
    #[test]
    fn single_page_rewrites_module_imports() {
        use super::{rewrite_module_imports, rewrite_specifier_text};
        let remap = HashMap::from([
            ("player.mjs".to_string(), "tve:player.mjs".to_string()),
            ("engine/utils.mjs".to_string(), "tve:engine/utils.mjs".to_string()),
            (
                "engine/loaders/GLTFLoader.js".to_string(),
                "tve:engine/loaders/GLTFLoader.js".to_string(),
            ),
        ]);
        // 相对解析：engine/model.mjs 目录下的 ./x 与 ../x
        assert_eq!(
            rewrite_specifier_text(
                "import { a } from \"./utils.mjs\";\nimport * as G from './loaders/GLTFLoader.js';\nimport(\"./utils.mjs\")\n",
                "engine/",
                &remap
            ),
            "import { a } from \"tve:engine/utils.mjs\";\nimport * as G from 'tve:engine/loaders/GLTFLoader.js';\nimport(\"tve:engine/utils.mjs\")\n"
        );
        // ../ 上溯：engine/ 下的 ../loaders 解析到根目录（不在映射表，不重写）
        assert_eq!(
            rewrite_specifier_text("import '../loaders/GLTFLoader.js';", "engine/", &remap),
            "import '../loaders/GLTFLoader.js';"
        );
        // 压缩形态：from"./x" 无空白
        assert_eq!(
            rewrite_specifier_text("import{a}from\"./utils.mjs\";", "engine/", &remap),
            "import{a}from\"tve:engine/utils.mjs\";"
        );
        // 未知目标 / 裸说明符 / import.meta / 词内匹配不重写
        assert_eq!(
            rewrite_specifier_text(
                "import \"./missing.mjs\";\nimport * as T from \"three\";\nlet x = import.meta.url;\nperformance.from(\"./utils.mjs\");\n",
                "engine/",
                &remap
            ),
            "import \"./missing.mjs\";\nimport * as T from \"three\";\nlet x = import.meta.url;\nperformance.from(\"./utils.mjs\");\n"
        );
        // 端到端：player 相对 import 重写为 tve:；extra_remap（CDN three）直接替换为 URL
        let mut code = HashMap::from([
            (
                "player.mjs".to_string(),
                "import { b } from \"./engine/utils.mjs\";\nimport * as T from \"./engine/core/three.module.min.js\";\n".to_string(),
            ),
            ("engine/utils.mjs".to_string(), "export const b = 1;\n".to_string()),
        ]);
        let extra = HashMap::from([(
            "engine/core/three.module.min.js".to_string(),
            "https://c.com/three.js/0.185.1/three.module.min.js".to_string(),
        )]);
        rewrite_module_imports(&mut code, &extra);
        assert!(code["player.mjs"].contains("\"tve:engine/utils.mjs\""));
        assert!(
            code["player.mjs"]
                .contains("\"https://c.com/three.js/0.185.1/three.module.min.js\""),
            "three 相对 import 直接重写为 CDN 绝对 URL"
        );
    }
}

