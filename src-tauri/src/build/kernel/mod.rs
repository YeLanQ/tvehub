//! 导出内容内核（渠道无关）：构建产物「内容」的唯一生产者——场景收集、
//! 产物内文件分类、发布模式（uid 重命名/引用重写/JSON 紧凑化/脚本压缩）。
//! web 与 wechat 管线消费同一份 ContentManifest，跨渠道一致性由
//! tests/consistency_e2e.rs 结构性保证（字节级对比）。

pub(super) mod classify;
pub(super) mod content;
mod refs;
pub(super) mod release;
