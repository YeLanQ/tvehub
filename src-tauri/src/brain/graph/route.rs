// ---------------------------------------------------------------------------
// 语义路由：查询文本 → 种子命中（向量余弦）→ 沿边扩展（邻接加成）→ 排序。
// 只路由结构类节点（Skill/Command/Concept）；Task/Outcome 是情景，不是答案。
// ---------------------------------------------------------------------------

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::brain::model::{NodeKind, NodeRecord};
use crate::brain::store::hot::HotTier;
use crate::brain::vector::embed;
use crate::brain::vector::quant::QuantVec;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteHit {
    pub id: String,
    pub kind: NodeKind,
    pub label: String,
    /// 0..1 归一后的综合分（余弦 + 邻接加成）
    pub score: f32,
}

/// 邻接加成系数：一跳边的贡献 = 邻居余弦 × 边权 × KICK
const KICK: f32 = 0.6;
/// 显著性阈值：余弦必须超过 3/(|q|·|v|) 才算种子命中。
/// 特征是 ±1 计数，余弦 ≈ 共享特征数/√(|q|²|v|²)——单个共享特征（哈希碰撞噪声）
/// 的余弦恰好 ≈ 1/(|q|·|v|)，阈值取 3 倍即要求"至少 3 个共享特征"才算真语义命中。
const SEED_SIGNIFICANCE: f32 = 3.0;
/// 类型先验：技能是策略主体，命令/概念只是锚点，排序时加权
fn kind_prior(kind: NodeKind) -> f32 {
    match kind {
        NodeKind::Skill => 1.0,
        NodeKind::Command => 0.9,
        _ => 0.8,
    }
}

/// 语义路由：返回 top_k 个结构类节点（含访问 touch）。
pub fn route(hot: &mut HotTier, query: &str, top_k: usize, now: u64) -> Vec<RouteHit> {
    let (qv, q_count) = embed::embed(query);
    let q = QuantVec::encode(&qv, q_count);
    let adj = hot.adjacency();
    let mut scores: HashMap<String, f32> = HashMap::new();
    if q_count > 0 {
        let seeds = hot.vectors.iter().filter_map(|(id, v)| {
            let cos = q.cosine(v);
            // 显著性：cos × √(n_q·n_v) ≈ 共享特征数，要求 ≥ 3（单特征碰撞是噪声）
            let min_cos =
                (SEED_SIGNIFICANCE / ((q_count * v.features).max(1) as f32).sqrt()).max(0.05);
            (cos >= min_cos).then_some((id.clone(), cos))
        });
        // 综合 = 自身余弦 + 一跳邻接加成（取所有种子贡献的最大值）
        for (id, cos) in seeds {
            *scores.entry(id.clone()).or_default() += cos;
            if let Some(nbrs) = adj.get(id.as_str()) {
                for (nbr, weight) in nbrs {
                    let bonus = cos * weight * KICK;
                    let slot = scores.entry((*nbr).to_string()).or_default();
                    *slot = slot.max(bonus);
                }
            }
        }
    }
    let mut hits: Vec<RouteHit> = scores
        .into_iter()
        .filter_map(|(id, score)| {
            let n = hot.nodes.get(&id)?;
            structural(n).then(|| RouteHit {
                id,
                kind: n.kind,
                label: n.label.clone(),
                score: score * kind_prior(n.kind),
            })
        })
        .collect();
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(top_k);
    // 命中即加热：访问史喂给冷热分层的温度计分
    for h in &hits {
        hot.touch(&h.id, now);
    }
    hits
}

fn structural(n: &NodeRecord) -> bool {
    matches!(n.kind, NodeKind::Skill | NodeKind::Command | NodeKind::Concept)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain::graph::{reinforce, upsert_embedded};
    use crate::brain::model::EdgeKind;

    fn graph() -> HotTier {
        let mut hot = HotTier::default();
        upsert_embedded(&mut hot, "skill:script", NodeKind::Skill, "tve 脚本编写", "写节点组件脚本 Component property 引擎 API", 0);
        upsert_embedded(&mut hot, "skill:share", NodeKind::Skill, "局域网共享", "LanShare 局域网共享端口配置", 0);
        upsert_embedded(&mut hot, "cmd:node.add", NodeKind::Command, "node.add", "node.add", 0);
        reinforce(&mut hot, "skill:script", "cmd:node.add", EdgeKind::Uses, 0.5, 0);
        hot
    }

    #[test]
    fn routes_script_task_to_scripting_skill() {
        let mut hot = graph();
        let hits = route(&mut hot, "帮我写一个旋转脚本组件", 3, 0);
        assert!(!hits.is_empty());
        assert_eq!(hits[0].id, "skill:script", "脚本任务应路由到脚本技能");
        // Uses 邻接应把命令带进候选
        assert!(hits.iter().any(|h| h.id == "cmd:node.add"), "邻接命令应入候选");
    }

    #[test]
    fn unrelated_query_scores_low_or_empty() {
        let mut hot = graph();
        let hits = route(&mut hot, "完全无关的量子 fluctuation 文本", 3, 0);
        assert!(
            hits.first().map(|h| h.score).unwrap_or(0.0) < 0.35,
            "无关查询得分应低"
        );
    }

    #[test]
    fn touch_records_access_for_temperature() {
        let mut hot = graph();
        route(&mut hot, "写脚本", 3, 12345);
        let n = hot.node("skill:script").unwrap();
        assert_eq!(n.last_hit, 12345, "路由命中应刷新访问时间");
        assert_eq!(n.hits, 1);
    }
}
