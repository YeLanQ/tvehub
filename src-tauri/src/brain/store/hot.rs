// ---------------------------------------------------------------------------
// 热层：常驻内存的图数据（节点/边/因果链/量化向量）+ 访问温度计分。
// 温度 = 频次(ln(1+hits)) + 新近度(半衰期指数)，驱动冷层下沉挑选；
// Skill/Command/Concept 是结构记忆永不下沉，Task/Outcome 是情景记忆可冷却。
// ---------------------------------------------------------------------------

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::brain::model::{CausalChain, EdgeKind, EdgeRecord, NodeKind, NodeRecord};
use crate::brain::vector::QuantVec;

/// 新近度半衰期：3 天（毫秒）
const RECENCY_HALF_LIFE_MS: f64 = 3.0 * 24.0 * 3600.0 * 1000.0;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotTier {
    pub nodes: HashMap<String, NodeRecord>,
    pub edges: HashMap<String, EdgeRecord>,
    pub chains: Vec<CausalChain>,
    pub vectors: HashMap<String, QuantVec>,
}

impl HotTier {
    /// 边的唯一键（from|to|kind）
    pub fn edge_key(from: &str, to: &str, kind: EdgeKind) -> String {
        format!("{from}\u{1}{to}\u{1}{}", kind_name(kind))
    }

    pub fn upsert_node(&mut self, rec: NodeRecord) {
        self.nodes.insert(rec.id.clone(), rec);
    }

    /// 访问命中：hits+1、刷新 last_hit（路由/规划都会走到）
    pub fn touch(&mut self, id: &str, now: u64) {
        if let Some(n) = self.nodes.get_mut(id) {
            n.hits += 1;
            n.last_hit = now;
        }
    }

    /// 精确边查询（测试辅助：产品代码按邻接/全量遍历，不按端点查边）
    #[cfg(test)]
    pub fn get_edge(&self, from: &str, to: &str, kind: EdgeKind) -> Option<&EdgeRecord> {
        self.edges.get(&Self::edge_key(from, to, kind))
    }

    pub fn all_edges(&self) -> impl Iterator<Item = &EdgeRecord> {
        self.edges.values()
    }

    pub fn node(&self, id: &str) -> Option<&NodeRecord> {
        self.nodes.get(id)
    }

    /// 访问温度：越大越热。频次对数压扁 + 新近指数（now 由调用方注入，测试可定）
    pub fn temperature(rec: &NodeRecord, now: u64) -> f64 {
        let freq = (rec.hits as f64 + 1.0).ln();
        let dt = now.saturating_sub(rec.last_hit) as f64;
        let recency = (-dt / RECENCY_HALF_LIFE_MS * std::f64::consts::LN_2).exp();
        freq + 2.0 * recency
    }

    /// 冷却挑选：情景类（Task/Outcome）里温度最低者，结构类直接跳过。
    pub fn coldest_episodic(&self, now: u64) -> Option<String> {
        self.nodes
            .values()
            .filter(|n| matches!(n.kind, NodeKind::Task | NodeKind::Outcome))
            .min_by(|a, b| {
                Self::temperature(a, now)
                    .partial_cmp(&Self::temperature(b, now))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|n| n.id.clone())
    }

    /// 邻接表（查询时现算：图规模千级以内，比维护增量索引更省心且不失速）
    pub fn adjacency(&self) -> HashMap<&str, Vec<(&str, f32)>> {
        let mut adj: HashMap<&str, Vec<(&str, f32)>> = HashMap::new();
        for e in self.edges.values() {
            adj.entry(e.from.as_str()).or_default().push((e.to.as_str(), e.weight));
            adj.entry(e.to.as_str()).or_default().push((e.from.as_str(), e.weight));
        }
        adj
    }
}

fn kind_name(kind: EdgeKind) -> &'static str {
    match kind {
        EdgeKind::Mentions => "m",
        EdgeKind::Uses => "u",
        EdgeKind::Caused => "c",
        EdgeKind::CoOccurs => "o",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain::model::node_id;

    fn node(id: &str, kind: NodeKind, hits: u64, last_hit: u64) -> NodeRecord {
        NodeRecord {
            id: id.to_string(),
            kind,
            label: id.to_string(),
            text: String::new(),
            hits,
            last_hit,
            created_at: 0,
        }
    }

    #[test]
    fn hotter_when_frequent_and_recent() {
        let now = 1_000_000_000_000;
        let hot = node("a", NodeKind::Task, 10, now - 1000);
        let cold = node("b", NodeKind::Task, 0, now - 30 * 24 * 3600 * 1000);
        assert!(HotTier::temperature(&hot, now) > HotTier::temperature(&cold, now));
    }

    #[test]
    fn coldest_episodic_skips_structural_kinds() {
        let mut tier = HotTier::default();
        let now = 1_000_000_000_000;
        tier.upsert_node(node("skill:x", NodeKind::Skill, 0, 0));
        tier.upsert_node(node("task:old", NodeKind::Task, 0, 0));
        assert_eq!(
            tier.coldest_episodic(now).as_deref(),
            Some("task:old"),
            "结构类节点永不参与冷却挑选"
        );
        assert!(tier.coldest_episodic(now) != Some(node_id(NodeKind::Skill, "x")));
    }

    #[test]
    fn touch_bumps_hits_and_recency() {
        let mut tier = HotTier::default();
        tier.upsert_node(node("task:a", NodeKind::Task, 1, 0));
        tier.touch("task:a", 42);
        assert_eq!(tier.node("task:a").map(|n| (n.hits, n.last_hit)), Some((2, 42)));
    }
}
