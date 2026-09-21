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
    pub cold_entries: usize,
    /// f32 原始体积（量化前的理论大小）
    pub vector_raw_bytes: u64,
    /// i8 量化后的实际体积
    pub vector_stored_bytes: u64,
    pub merged_total: u64,
    pub ticks: u64,
    pub total_energy: f64,
    pub global_accuracy: f64,
    pub decisions: Decisions,
    pub methods: Vec<MethodStat>,
}
