// ---------------------------------------------------------------------------
// 因果链：任务回合的事件记忆与进化。
// 一次观测 = task -Caused-> command -Caused-> outcome(ok|fail)，链按任务哈希
// 聚合（同任务反复执行复用同一条链）。成功增益大、失败增益小但非零——失败的
// 教训也是知识；权重随时间衰减，久不发生的因果自然淡出（evolve 修剪）。
// ---------------------------------------------------------------------------

use crate::brain::model::{node_id, task_hash, CausalChain, EdgeKind, NodeKind};
use crate::brain::store::hot::HotTier;

use super::{reinforce, upsert_embedded};

/// 因果增益：task→cmd 与 cmd→outcome 的强化步长
pub const GAIN_TASK_CMD: f32 = 0.18;
pub const GAIN_CMD_OUTCOME: f32 = 0.14;

/// 确保任务节点存在（文本哈希为 id，同义反复任务聚合到同一节点）
pub fn ensure_task(hot: &mut HotTier, text: &str, now: u64) -> String {
    let id = node_id(NodeKind::Task, &task_hash(text));
    let label: String = text.chars().take(24).collect();
    upsert_embedded(hot, &id, NodeKind::Task, &label, text, now);
    id
}

/// 确保命令节点存在（结构记忆，向量 = 方法名本身）
pub fn ensure_command(hot: &mut HotTier, method: &str, now: u64) -> String {
    let id = node_id(NodeKind::Command, method);
    upsert_embedded(hot, &id, NodeKind::Command, method, method, now);
    id
}

/// 确保结果节点存在（按 方法+成败 聚合，如 outcome:node.add:ok）
pub fn ensure_outcome(hot: &mut HotTier, method: &str, ok: bool, now: u64) -> String {
    let id = node_id(NodeKind::Outcome, &format!("{method}:{}", if ok { "ok" } else { "fail" }));
    let label = format!("{method} {}", if ok { "成功" } else { "失败" });
    upsert_embedded(hot, &id, NodeKind::Outcome, &label, &label, now);
    id
}

/// 记录一次观测并进化因果链；返回 (链 id, 任务节点 id)。
pub fn record(hot: &mut HotTier, task_text: &str, method: &str, ok: bool, now: u64) -> (String, String) {
    let task_id = ensure_task(hot, task_text, now);
    let cmd_id = ensure_command(hot, method, now);
    let outcome_id = ensure_outcome(hot, method, ok, now);

    reinforce(hot, &task_id, &cmd_id, EdgeKind::Caused, GAIN_TASK_CMD, now);
    reinforce(
        hot,
        &cmd_id,
        &outcome_id,
        EdgeKind::Caused,
        if ok { GAIN_CMD_OUTCOME } else { GAIN_CMD_OUTCOME * 0.4 },
        now,
    );
    // 访问加热：观测即访问，喂给冷热分层的温度计分。upsert 刻意不动访问史
    //（保住幂等摄取的语义），加热统一由 record 负责——新节点 hits 0→1，
    // 老节点在原值上续计。
    hot.touch(&task_id, now);
    hot.touch(&cmd_id, now);

    let chain_id = format!("chain:{}", &task_id["task:".len()..]);
    append_chain(hot, &chain_id, &[task_id.clone(), cmd_id.clone(), outcome_id], now);
    (chain_id, task_id)
}

fn append_chain(hot: &mut HotTier, chain_id: &str, events: &[String], now: u64) {
    if let Some(chain) = hot.chains.iter_mut().find(|c| c.id == chain_id) {
        for ev in events {
            if chain.events.last() != Some(ev) {
                chain.events.push(ev.clone());
            }
        }
        chain.updated_at = now;
        return;
    }
    hot.chains.push(CausalChain {
        id: chain_id.to_string(),
        events: events.to_vec(),
        updated_at: now,
    });
}

/// 链上限：最老的先淘汰（情景记忆容量护栏）
pub const MAX_CHAINS: usize = 512;

/// 淘汰最久未更新的因果链
pub fn trim_chains(hot: &mut HotTier) -> usize {
    if hot.chains.len() <= MAX_CHAINS {
        return 0;
    }
    hot.chains.sort_by_key(|c| c.updated_at);
    let drop = hot.chains.len() - MAX_CHAINS;
    hot.chains.drain(..drop);
    drop
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_builds_chain_and_edges() {
        let mut hot = HotTier::default();
        let (chain, task) = record(&mut hot, "写一个旋转脚本", "node.add", true, 100);
        assert!(chain.starts_with("chain:"));
        let cmd = node_id(NodeKind::Command, "node.add");
        assert!(
            hot.get_edge(&task, &cmd, EdgeKind::Caused).is_some(),
            "task→cmd 因果边应建立"
        );
        let outcome = node_id(NodeKind::Outcome, "node.add:ok");
        assert!(hot.get_edge(&cmd, &outcome, EdgeKind::Caused).is_some());
    }

    #[test]
    fn same_task_reuses_chain_and_strengthens() {
        let mut hot = HotTier::default();
        let (chain1, task1) = record(&mut hot, "写一个旋转脚本", "node.add", true, 100);
        let (chain2, task2) = record(&mut hot, "写一个旋转脚本", "node.add", true, 200);
        assert_eq!(chain1, chain2, "同任务同链");
        assert_eq!(task1, task2);
        let cmd = node_id(NodeKind::Command, "node.add");
        let w2 = hot.get_edge(&task1, &cmd, EdgeKind::Caused).unwrap().weight;
        assert!(w2 > GAIN_TASK_CMD, "二次观测应强化边权");
    }

    #[test]
    fn trim_chains_keeps_newest() {
        let mut hot = HotTier::default();
        for i in 0..(MAX_CHAINS + 5) {
            record(&mut hot, &format!("任务{i}"), "asset.list", true, i as u64 * 1000);
        }
        let dropped = trim_chains(&mut hot);
        assert_eq!(dropped, 5);
        assert_eq!(hot.chains.len(), MAX_CHAINS);
        let oldest = hot.chains.first().map(|c| c.id.clone()).unwrap();
        assert_ne!(oldest, "chain:0", "最老的链应被淘汰");
    }
}
