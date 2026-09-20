//! 局域网对外页面的主题色：由 build.rs 从 `src/ui-kit/styles/variables.scss` 生成。
//!
//! 这里只做一件事——把生成的常量挂进模块树，让 `pages.rs` 用 `Theme::BG` 这样的
//! 语义名取色。故意不在这里定义任何色值：一旦本文件出现十六进制颜色，就说明有人
//! 绕过了主题（对外页面与应用内 UI 会开始分叉）。

include!(concat!(env!("OUT_DIR"), "/lan_theme.rs"));
