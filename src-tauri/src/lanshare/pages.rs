//! 服务端渲染的两张页面：共享索引页（手机打开 base URL 时看到的）与口令解锁页。
//!
//! 两张页面的颜色一律取自 [`Theme`]（构建期从 ui-kit 主题变量表生成），页面不写死
//! 任何十六进制色值——对外页面与应用内 UI 必须同一套配色，改主题只改 variables.scss。
//! 样式内联、不引外部资源：服务本身可能跑在没网的局域网里，页面必须自足。

use super::theme::CSS_VARS;
use super::config::LanShareConfig;
use super::share::LanShare;

/// HTML 文本转义（标题/设备名都来自用户输入或主机名）
pub(super) fn esc_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn human_size(bytes: u64) -> String {
    if bytes >= 1048576 {
        format!("{:.1} MB", bytes as f64 / 1048576.0)
    } else if bytes >= 1024 {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "whiteboard" => "白板",
        "folder" => "目录",
        _ => "网页",
    }
}

/// 共享索引页：列出全部启用中的共享，点进去即用
pub(super) fn index_html(config: &LanShareConfig, shares: &[LanShare]) -> String {
    let mut items = String::new();
    for share in shares.iter().filter(|s| s.enabled) {
        items.push_str(&format!(
            "<a class=\"item\" href=\"/s/{id}/\"><div class=\"t\">{title}</div>\
<div class=\"m\">{kind} · {files} 个文件 · {size}</div></a>",
            id = esc_html(&share.id),
            title = esc_html(&share.title),
            kind = kind_label(&share.kind),
            files = share.file_count,
            size = human_size(share.size),
        ));
    }
    if items.is_empty() {
        items.push_str("<p class=\"empty\">当前没有共享内容。在桌面端点「共享」后刷新本页。</p>");
    }
    format!(
        r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{device} · 局域网共享</title>
<style>
:root {{
{CSS_VARS}  color-scheme: dark;
  font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  color: var(--tv-text);
  background: var(--tv-bg);
}}
* {{ box-sizing: border-box; }}
body {{ margin: 0; padding: 20px 16px 40px; background: var(--tv-bg); color: var(--tv-text); }}
h1 {{ font-size: 17px; margin: 0 0 4px; }}
.sub {{ color: var(--tv-text-dim); font-size: 12px; margin-bottom: 18px; }}
.item {{ display: block; padding: 14px 16px; margin-bottom: 10px; border-radius: 10px;
  background: var(--tv-panel); border: 1px solid var(--tv-border); color: inherit; text-decoration: none; }}
.item:active {{ background: var(--tv-hover); }}
.t {{ font-size: 15px; font-weight: 600; margin-bottom: 2px; }}
.m {{ color: var(--tv-text-dim); font-size: 12px; }}
.empty {{ color: var(--tv-text-dim); }}
</style></head>
<body><h1>{device}</h1><div class="sub">局域网共享 · TvE</div>{items}</body></html>"#,
        device = esc_html(&config.device_name),
        items = items,
    )
}

/// 口令解锁页：表单 GET 回原路径（`?k=<口令>`），成功由服务端下发 cookie
pub(super) fn unlock_html(target: &str, wrong: bool) -> String {
    format!(
        r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要访问口令</title>
<style>
:root {{
{CSS_VARS}  color-scheme: dark;
  font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  color: var(--tv-text);
}}
body {{ margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  background: var(--tv-bg); color: var(--tv-text); }}
form {{ width: 260px; }}
h1 {{ font-size: 15px; margin: 0 0 12px; }}
input {{ width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--tv-border);
  background: var(--tv-input); color: inherit; font-size: 15px; }}
button {{ margin-top: 10px; width: 100%; padding: 10px; border-radius: 8px; border: 0;
  background: var(--tv-accent); color: var(--tv-bg); font-size: 15px; font-weight: 600; }}
.err {{ color: var(--tv-err); font-size: 12px; margin-top: 8px; }}
</style></head>
<body><form method="get" action="{target}">
<h1>请输入访问口令</h1>
<input name="k" type="password" autofocus autocomplete="off" placeholder="访问口令">
<button type="submit">进入</button>{err}
</form></body></html>"#,
        target = esc_html(target),
        err = if wrong { "<div class=\"err\">口令不正确</div>" } else { "" },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    // 主题常量（值本身）仅在比对时用到；页面里只用 CSS 变量，不直接插值色值
    use crate::lanshare::theme::Theme;

    #[test]
    fn escapes_user_text() {
        assert_eq!(esc_html("a<b>&\"c\""), "a&lt;b&gt;&amp;&quot;c&quot;");
    }

    #[test]
    fn index_lists_only_enabled_and_escapes() {
        let mut config = LanShareConfig::default();
        config.device_name = "机<器>".into();
        let share = LanShare {
            id: "id1".into(),
            kind: "whiteboard".into(),
            title: "标题&<b>".into(),
            note: String::new(),
            source: String::new(),
            entry: "index.html".into(),
            root: String::new(),
            managed: true,
            enabled: true,
            created_at: 0,
            updated_at: 0,
            file_count: 3,
            size: 2048,
            hits: 0,
            last_access: 0,
            last_client: String::new(),
        };
        let mut hidden = share.clone();
        hidden.id = "id2".into();
        hidden.enabled = false;
        let html = index_html(&config, &[share, hidden]);
        assert!(html.contains("机&lt;器&gt;"));
        assert!(html.contains("标题&amp;&lt;b&gt;"));
        assert!(html.contains("/s/id1/"));
        assert!(!html.contains("/s/id2/"), "停用项不出现");
        assert!(html.contains("白板 · 3 个文件 · 2 KB"));
    }

    #[test]
    fn empty_index_shows_hint() {
        let html = index_html(&LanShareConfig::default(), &[]);
        assert!(html.contains("当前没有共享内容"));
    }

    #[test]
    fn unlock_page_escapes_target() {
        let html = unlock_html("/s/a\"b/", true);
        assert!(html.contains("action=\"/s/a&quot;b/\""));
        assert!(html.contains("口令不正确"));
    }

    /// 页面颜色必须来自主题：剔除内联的主题变量块之后，样式里不该再有任何裸色值；
    /// 并且主题变量必须逐条内联到页面上（缺一条就会有一处颜色走浏览器默认值）
    #[test]
    fn pages_use_theme_vars_not_hardcoded_colors() {
        let html = index_html(&LanShareConfig::default(), &[]);
        let unlock = unlock_html("/", false);
        let declarations: Vec<&str> = CSS_VARS
            .lines()
            .map(|l| l.trim())
            .filter(|l| l.starts_with("--tv-"))
            .collect();
        assert!(!declarations.is_empty(), "主题变量块是空的 —— build.rs 未正确生成");

        for (name, page) in [("索引页", &html), ("解锁页", &unlock)] {
            // 主题变量块里的 # 是生成的色值本身，属于唯一合法来源
            let own_styles = page.replace(CSS_VARS, "");
            assert!(
                !own_styles.contains('#'),
                "{name}的样式里出现了裸色值，颜色应全部走主题变量"
            );
            for decl in &declarations {
                assert!(page.contains(decl), "{name}缺少主题变量声明: {decl}");
            }
            assert!(page.contains(Theme::BG), "{name}没有内联主题背景色值");
            assert!(page.contains(Theme::BORDER), "{name}没有内联主题描边色值");
        }
    }
}
