// ---------------------------------------------------------------------------
// 神经知识网络图谱：核心数据模型（节点/边/因果链/快照）。
// 设计要点：
// - 节点分五类：Skill（领域技能）/ Command（可执行命令）/ Concept（概念词元）/
//   Task（任务回合）/ Outcome（执行结果）。前三类常驻热层，后两类是情景记忆，
//   按"温度"冷却下沉。
// - 边带 0..1 权重，按半衰期衰减、按观测增益强化——这就是"因果链进化"的载体。
// - 向量不入本文件：统一放 vector::VectorIndex，量化后 64B/条。
// ---------------------------------------------------------------------------

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

/// Unix 毫秒时间戳（测试可注入 now，生产用真实时钟）
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    Skill,
    Command,
    Concept,
    Task,
    Outcome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EdgeKind {
    /// 技能 → 概念（描述词元）
    Mentions,
    /// 技能 → 命令（该技能的执行面）
    Uses,
    /// 因果链：任务 → 命令、命令 → 结果（观测驱动，可进化）
    Caused,
    /// 概念共现（同一技能内词元互连，路由扩展用）
    CoOccurs,
}

/// 图节点：hits/last_hit 驱动冷热分层；text 是向量化来源（截断存储）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRecord {
    pub id: String,
    pub kind: NodeKind,
    pub label: String,
    pub text: String,
    pub hits: u64,
    pub last_hit: u64,
    pub created_at: u64,
}

/// 图边：from → to，weight ∈ (0, 1]。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeRecord {
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
    pub weight: f32,
    pub updated_at: u64,
}

/// 因果链：一次任务回合的事件序列（task → command → outcome …）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CausalChain {
    pub id: String,
    /// 按时间序的事件节点 id
    pub events: Vec<String>,
    pub updated_at: u64,
}

/// 文本规范化 id："kind:词元/哈希"。Task/Outcome 用哈希，其余用语义名。
pub fn node_id(kind: NodeKind, key: &str) -> String {
    format!("{}:{}", kind_key(kind), key)
}

fn kind_key(kind: NodeKind) -> &'static str {
    match kind {
        NodeKind::Skill => "skill",
        NodeKind::Command => "cmd",
        NodeKind::Concept => "concept",
        NodeKind::Task => "task",
        NodeKind::Outcome => "outcome",
    }
}

/// FNV-1a 64 位哈希（任务文本 → 稳定 id；无外部依赖）
pub fn fnv1a64(text: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in text.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// 任务文本 → 8 位十六进制 id（规范化：剔除全部空白差异）
pub fn task_hash(text: &str) -> String {
    let norm: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    format!("{:016x}", fnv1a64(&norm))
}

/// 磁盘/内嵌的持久化形态：全部用 Vec（serde_json 的 map 键必须是字符串）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub nodes: Vec<NodeRecord>,
    pub edges: Vec<EdgeRecord>,
    pub chains: Vec<CausalChain>,
    pub vectors: Vec<(String, crate::brain::vector::QuantVec)>,
    pub ledger: crate::brain::metrics::LedgerSnapshot,
    pub saved_at: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_hash_stable_ignoring_whitespace() {
        assert_eq!(task_hash("写一个 旋转脚本"), task_hash("写一个旋转脚本"));
        assert_eq!(task_hash("abc"), task_hash("abc"));
        assert_ne!(task_hash("abc"), task_hash("abd"));
    }

    #[test]
    fn node_id_prefixes_kind() {
        assert_eq!(node_id(NodeKind::Skill, "tve-scripting"), "skill:tve-scripting");
        assert_eq!(node_id(NodeKind::Command, "node.add"), "cmd:node.add");
    }
}
