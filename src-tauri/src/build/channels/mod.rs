//! 渠道实现层：每个渠道一个目录，只经 pipeline 工厂桥接、互不可见——
//! 渠道之间不产生代码依赖，形态互斥由渠道各自的组装保证，内容一致性由
//! tests/consistency_e2e.rs 守护。

pub(super) mod web;
pub(super) mod wechat;
