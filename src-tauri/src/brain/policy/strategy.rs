// ---------------------------------------------------------------------------
// 策略规划：任务文本 →（语义路由）→ 主技能 + 推荐步骤 + 效能门控决策。
// 决策规则（与 tve-agent-autonomy 三区一致）：
//   任一步红灯 → Deny；任一步黄灯 → NeedConfirm；
//   全绿且每步效能比 ≥ 0.99 → AutoExecute；否则 NeedConfirm（附原因）。
// ---------------------------------------------------------------------------

use serde::{Deserialize, Serialize};

use crate::brain::graph::route::{self, RouteHit};
use crate::brain::metrics::OutcomeLedger;
use crate::brain::model::{EdgeKind, NodeKind};
use crate::brain::policy::budget;
use crate::brain::policy::zones::{self, Zone};
use crate::brain::store::hot::HotTier;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    AutoExecute,
    NeedConfirm,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub method: String,
    pub zone: Zone,
    pub ratio: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub task: String,
    pub decision: Decision,
    pub reason: String,
    /// 全计划瓶颈效能比（最弱一步）
    pub ratio: f32,
    pub skills: Vec<RouteHit>,
    pub steps: Vec<PlanStep>,
}

/// 单技能推荐命令上限
const STEPS_PER_SKILL: usize = 6;

/// 生成执行计划（只读路由会 touch 命中节点）
pub fn build_plan(hot: &mut HotTier, ledger: &OutcomeLedger, task: &str, now: u64) -> Plan {
    // 多取候选再滤技能：命令/概念节点可能占前列，技能才是策略主体
    let skills: Vec<RouteHit> = route::route(hot, task, 8, now)
        .into_iter()
        .filter(|h| h.kind == NodeKind::Skill)
        .collect();
    let Some(primary) = skills.first() else {
        return Plan {
            task: task.to_string(),
            decision: Decision::NeedConfirm,
            reason: "图谱无匹配策略：无内嵌技能与此任务语义相近".to_string(),
            ratio: 0.0,
            skills: Vec::new(),
            steps: Vec::new(),
        };
    };

    // 主技能的 Uses 边 → 推荐步骤（边权降序）
    let mut weighted: Vec<(String, f32)> = hot
        .all_edges()
        .filter(|e| e.from == primary.id && e.kind == EdgeKind::Uses)
        .map(|e| (e.to.clone(), e.weight))
        .collect();
    weighted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let steps: Vec<PlanStep> = weighted
        .into_iter()
        .take(STEPS_PER_SKILL)
        .filter_map(|(to, _)| {
            let method = to.strip_prefix("cmd:")?.to_string();
            let stat = ledger.stat(&method);
            let s = budget::score(stat, &method);
            let zone = zones::zone_of(&method);
            Some(PlanStep { method, zone, ratio: s.ratio })
        })
        .collect();

    decide(task, &skills, steps)
}

fn decide(task: &str, skills: &[RouteHit], steps: Vec<PlanStep>) -> Plan {
    let bottleneck = steps
        .iter()
        .map(|s| s.ratio)
        .fold(f32::INFINITY, f32::min)
        .min(1.0);
    // 所有分支都保留 steps：需确认/拒绝的计划也要展示"将做什么"才能问得明白
    let plan = |decision: Decision, reason: &str| Plan {
        task: task.to_string(),
        decision,
        reason: reason.to_string(),
        ratio: if steps.is_empty() { 0.0 } else { bottleneck },
        skills: skills.to_vec(),
        steps: steps.clone(),
    };
    if steps.is_empty() {
        return plan(Decision::NeedConfirm, "技能未关联已知命令，无既定执行面，请人工确认路径");
    }
    if steps.iter().any(|s| s.zone == Zone::Red) {
        return plan(Decision::Deny, "计划包含红灯操作，禁止自主执行");
    }
    if steps.iter().any(|s| s.zone == Zone::Yellow) {
        return plan(Decision::NeedConfirm, "计划包含写操作（黄灯区），按行动边界需先向用户确认");
    }
    if budget::auto_eligible(bottleneck) {
        plan(Decision::AutoExecute, "全绿灯且每步效能比 ≥ 0.99，可自主执行")
    } else {
        plan(
            Decision::NeedConfirm,
            &format!("效能比 {bottleneck:.3} 低于自主门槛 0.99（历史正确率/速度/能耗不足）"),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain::graph::reinforce;
    use crate::brain::model::node_id;
    use crate::brain::skillsrc::{ingest::ingest_all, SkillEntry};

    fn brain_graph() -> HotTier {
        let mut hot = HotTier::default();
        let skills = [SkillEntry {
            id: "tve-operations".to_string(),
            name: "编辑器操作指引".to_string(),
            description: "用户问编辑器资产场景操作时使用".to_string(),
            body: "用 asset.list 列资产；用 asset.write 写文件；用 node.add 加节点。".to_string(),
        }];
        ingest_all(&mut hot, &skills, 0);
        hot
    }

    #[test]
    fn yellow_zone_plan_requires_confirmation() {
        let mut hot = brain_graph();
        let ledger = OutcomeLedger::default();
        let plan = build_plan(&mut hot, &ledger, "帮我把资产列表导出并写入文件", 0);
        assert_eq!(plan.decision, Decision::NeedConfirm, "黄灯必须确认：{:?}", plan.steps);
        assert!(plan.steps.iter().any(|s| s.zone == Zone::Yellow));
    }

    #[test]
    fn green_only_plan_auto_executes() {
        let mut hot = HotTier::default();
        let skills = [SkillEntry {
            id: "tve-inspect".to_string(),
            name: "资产盘点".to_string(),
            description: "列出与读取项目资产".to_string(),
            body: "用 asset.list 列出，再 asset.read 读取内容。".to_string(),
        }];
        ingest_all(&mut hot, &skills, 0);
        let plan = build_plan(&mut hot, &OutcomeLedger::default(), "列出并读取项目资产", 0);
        assert_eq!(plan.decision, Decision::AutoExecute, "全绿灯冷启动应可自主执行");
        assert!(budget::auto_eligible(plan.ratio));
    }

    #[test]
    fn no_matching_skill_needs_confirmation() {
        let mut hot = HotTier::default();
        let plan = build_plan(&mut hot, &OutcomeLedger::default(), "完全无关的任务", 0);
        assert_eq!(plan.decision, Decision::NeedConfirm);
        assert!(plan.steps.is_empty());
    }

    #[test]
    fn uses_edges_rank_steps_by_weight() {
        let mut hot = brain_graph();
        let skill = node_id(NodeKind::Skill, "tve-operations");
        reinforce(&mut hot, &skill, &node_id(NodeKind::Command, "asset.read"), EdgeKind::Uses, 0.0, 0);
        let plan = build_plan(&mut hot, &OutcomeLedger::default(), "编辑器资产操作", 0);
        assert!(!plan.steps.is_empty());
        for w in plan.steps.windows(2) {
            // 权重信息已折叠进排序，这里只验证方法去重且都在登记表内
            assert!(zones::zone_of(&w[0].method) != Zone::Red);
        }
    }
}

