// ---------------------------------------------------------------------------
// 大脑对外 DTO（camelCase 对齐前端）：维护报告 / 观测回执 / 状态报表。
// ---------------------------------------------------------------------------

use serde::{Deserialize, Serialize};

use super::metrics::Decisions;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TickReport {
    pub pruned_edges: usize,
    pub merged_vectors: usize,
    pub demoted_nodes: usize,
    pub snapshot_saved: bool,
    pub elapsed_us: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserveReport {
    pub chain_id: String,
    pub ratio: f32,
    pub accuracy: f64,
    pub auto_eligible: bool,
    pub ticked: Option<TickReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodStat {
    pub method: String,
    pub attempts: u64,
    pub successes: u64,
    pub avg_ms: f64,
    pub ratio: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainStats {
    pub nodes_by_kind: std::collections::BTreeMap<String, usize>,
    pub edges: usize,
    pub chains: usize,
    /// 冷层条目数（未装载时为 0——结合 cold_loaded 区分"0 条"与"未装载"）
    pub cold_entries: usize,
    /// 冷层是否已在内存装载
    pub cold_loaded: bool,
    /// 磁盘上是否存在冷归档（未装载时的"有冷数据"信号）
    pub cold_archive_present: bool,
    /// f32 原始体积（量化前的理论大小）
    pub vector_raw_bytes: u64,
    /// i8 量化后的载荷体积（dims + norm；不含 Vec/HashMap 堆开销，
    /// 与进程 RSS 对账会有数倍差距，展示压缩率请用 raw/stored 比值）
    pub vector_stored_bytes: u64,
    pub merged_total: u64,
    pub ticks: u64,
    pub total_energy: f64,
    pub global_accuracy: f64,
    pub decisions: Decisions,
    pub methods: Vec<MethodStat>,
}
