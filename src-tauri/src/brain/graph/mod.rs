// ---------------------------------------------------------------------------
// 知识图谱操作：以扩展 trait 形式挂在 HotTier 上（数据一处持有，操作分文件）。
// 核心进化语义：
// - reinforce：边权 = 衰减(自上次更新) + 增益，封顶 1.0 —— 用得越新越频繁越强；
// - evolve：全图边按半衰期衰减 + 修剪弱边 —— 长期不走的因果链自然淡化；
// - redirect：向量合并后的节点重定向（自压缩的图谱侧收尾）。
// ---------------------------------------------------------------------------

pub mod causal;
pub mod route;

use crate::brain::model::{EdgeKind, EdgeRecord, NodeKind, NodeRecord};
use crate::brain::store::hot::HotTier;
use crate::brain::vector::embed;

/// 边权半衰期：14 天（观测驱动的边，两周不强化就减半）
pub const EDGE_HALF_LIFE_MS: f64 = 14.0 * 24.0 * 3600.0 * 1000.0;
/// 修剪阈值：衰减后低于此权重的边直接移除
pub const PRUNE_BELOW: f32 = 0.02;

/// 建节点（存在则只刷新 text/label 与向量，保留访问史——摄取可重入）
pub fn upsert_embedded(
    hot: &mut HotTier,
    id: &str,
    kind: NodeKind,
    label: &str,
    text: &str,
    now: u64,
) {
    let text = text.chars().take(400).collect::<String>();
    match hot.nodes.get_mut(id) {
        Some(existing) => {
            existing.label = label.to_string();
            if existing.text != text {
                existing.text = text.clone();
                hot.vectors.remove(id);
            }
        }
        None => {
            hot.upsert_node(NodeRecord {
                id: id.to_string(),
                kind,
                label: label.to_string(),
                text: text.clone(),
                hits: 0,
                last_hit: now,
                created_at: now,
            });
        }
    }
    if !hot.vectors.contains_key(id) {
        let (v, n) = embed::embed(&text);
        hot.vectors
            .insert(id.to_string(), crate::brain::vector::quant::QuantVec::encode(&v, n));
    }
}

/// 强化一条边（不存在则建，初始权重 0.05 起）；先衰减再增益，封顶 1.0
pub fn reinforce(hot: &mut HotTier, from: &str, to: &str, kind: EdgeKind, gain: f32, now: u64) {
    let key = HotTier::edge_key(from, to, kind);
    let w = match hot.edges.get(&key) {
        Some(e) => decayed(e.weight, e.updated_at, now),
        None => 0.05,
    };
    hot.edges.insert(
        key,
        EdgeRecord {
            from: from.to_string(),
            to: to.to_string(),
            kind,
            weight: (w + gain).min(1.0),
            updated_at: now,
        },
    );
}

fn decayed(weight: f32, updated_at: u64, now: u64) -> f32 {
    let dt = now.saturating_sub(updated_at) as f64;
    let factor = (-dt / EDGE_HALF_LIFE_MS * std::f64::consts::LN_2).exp();
    weight * factor as f32
}

/// 因果链进化维护：全图衰减 + 修剪，返回 (修剪数, 存活边数)
pub fn evolve(hot: &mut HotTier, now: u64) -> (usize, usize) {
    let keys: Vec<String> = hot.edges.keys().cloned().collect();
    let mut pruned = 0;
    for key in keys {
        let w = {
            let e = &hot.edges[&key];
            decayed(e.weight, e.updated_at, now)
        };
        if w < PRUNE_BELOW {
            hot.edges.remove(&key);
            pruned += 1;
        } else if let Some(e) = hot.edges.get_mut(&key) {
            e.weight = w;
            e.updated_at = now;
        }
    }
    (pruned, hot.edges.len())
}

/// 节点重定向（自压缩合并后调用）：边改挂 keep，chain 事件改指 keep，
/// 跨类型/缺节点时跳过合并返回 false。
pub fn redirect(hot: &mut HotTier, drop: &str, keep: &str) -> bool {
    let (Some(a), Some(b)) = (hot.nodes.get(drop), hot.nodes.get(keep)) else {
        return false;
    };
    if a.kind != b.kind {
        return false;
    }
    let edges: Vec<EdgeRecord> = hot.edges.values().cloned().collect();
    for e in edges {
        let new_from = if e.from == drop { keep.to_string() } else { e.from.clone() };
        let new_to = if e.to == drop { keep.to_string() } else { e.to.clone() };
        if new_from == new_to {
            hot.edges.remove(&HotTier::edge_key(&e.from, &e.to, e.kind));
            continue;
        }
        let old_key = HotTier::edge_key(&e.from, &e.to, e.kind);
        let new_key = HotTier::edge_key(&new_from, &new_to, e.kind);
        let mut moved = e.clone();
        moved.from = new_from;
        moved.to = new_to;
        // 重定向边与既有边取最大权重（合并的是身份，不是叠加流量）
        if let Some(existing) = hot.edges.get(&new_key) {
            moved.weight = moved.weight.max(existing.weight);
        }
        hot.edges.remove(&old_key);
        hot.edges.insert(new_key, moved);
    }
    for chain in &mut hot.chains {
        for ev in &mut chain.events {
            if ev == drop {
                *ev = keep.to_string();
            }
        }
        chain.events.dedup();
    }
    // 访问史并入保留节点
    let (drop_hits, drop_last) = {
        let d = &hot.nodes[drop];
        (d.hits, d.last_hit)
    };
    let keep_node = hot.nodes.get_mut(keep).expect("keep 已校验存在");
    keep_node.hits += drop_hits;
    keep_node.last_hit = keep_node.last_hit.max(drop_last);
    hot.nodes.remove(drop);
    hot.vectors.remove(drop);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain::store::hot::HotTier;

    const DAY: u64 = 24 * 3600 * 1000;

    fn setup() -> HotTier {
        let mut hot = HotTier::default();
        upsert_embedded(&mut hot, "skill:a", NodeKind::Skill, "a", "写脚本组件", 0);
        upsert_embedded(&mut hot, "concept:脚本", NodeKind::Concept, "脚本", "脚本", 0);
        hot
    }

    #[test]
    fn reinforce_caps_and_updates() {
        let mut hot = setup();
        for _ in 0..20 {
            reinforce(&mut hot, "skill:a", "concept:脚本", EdgeKind::Mentions, 0.1, 0);
        }
        let e = hot
            .get_edge("skill:a", "concept:脚本", EdgeKind::Mentions)
            .expect("边应存在");
        assert!((e.weight - 1.0).abs() < 1e-6, "多次强化应封顶 1.0");
    }

    #[test]
    fn evolve_decays_and_prunes() {
        let mut hot = setup();
        reinforce(&mut hot, "skill:a", "concept:脚本", EdgeKind::Mentions, 0.1, 0);
        let (pruned, left) = evolve(&mut hot, 60 * DAY);
        assert_eq!(pruned + left, 1, "边要么修剪要么存活，不消失");
        if pruned == 0 {
            let e = hot.get_edge("skill:a", "concept:脚本", EdgeKind::Mentions).unwrap();
            assert!(e.weight < 0.1, "60 天后应显著衰减");
        }
    }

    #[test]
    fn redirect_merges_edges_and_preserves_kind_check() {
        let mut hot = setup();
        upsert_embedded(&mut hot, "concept:编写", NodeKind::Concept, "编写", "编写", 0);
        upsert_embedded(&mut hot, "concept:脚本2", NodeKind::Concept, "脚本2", "脚本", 0);
        reinforce(&mut hot, "concept:脚本2", "skill:a", EdgeKind::Mentions, 0.3, 0);
        assert!(redirect(&mut hot, "concept:脚本2", "concept:脚本"));
        assert!(hot.node("concept:脚本2").is_none());
        assert!(
            hot.get_edge("concept:脚本", "skill:a", EdgeKind::Mentions).is_some(),
            "边应改挂到保留节点"
        );
        // 跨类型合并必须被拒
        assert!(!redirect(&mut hot, "concept:脚本", "skill:a"));
    }
}
