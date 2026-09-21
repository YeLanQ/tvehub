// 大脑端到端测试：构造 → 规划 → 观测进化 → 维护 → 快照往返。
// 全部走内存模式（snapshot_path = None）以隔离文件系统；快照往返单独用临时目录。

use super::*;

#[test]
fn brain_boots_with_embedded_skills_and_plans() {
    let brain = Brain::new(None);
    let stats = brain.stats();
    assert!(
        stats.nodes_by_kind.get("skill").copied().unwrap_or(0) >= 8,
        "内嵌技能组应有 8 个技能节点：{:?}",
        stats.nodes_by_kind
    );
    let plan = brain.plan("帮我写一个旋转脚本组件");
    assert!(!plan.skills.is_empty(), "脚本任务应路由到技能");
}

#[test]
fn observe_evolves_causal_chain_and_ledger() {
    let brain = Brain::new(None);
    for _ in 0..3 {
        let report = brain.observe("写一个旋转脚本", "asset.write", true, 120);
        assert!(report.chain_id.starts_with("chain:"));
        assert!(report.ratio > 0.0);
    }
    let stats = brain.stats();
    let w = stats.methods.iter().find(|m| m.method == "asset.write").expect("应有台账");
    assert_eq!(w.attempts, 3);
    assert_eq!(w.successes, 3);
    assert!(stats.total_energy > 0.0, "能耗当量应累计");
    assert_eq!(stats.chains, 1, "同任务同链");
}

#[test]
fn repeated_failures_demote_to_need_confirm() {
    let brain = Brain::new(None);
    for _ in 0..10 {
        brain.observe("反复失败的任务", "node.add", false, 3_000);
    }
    let report = brain.observe("反复失败的任务", "node.add", false, 3_000);
    assert!(
        !report.auto_eligible,
        "连续失败后效能比必须跌破 0.99（ratio={}）",
        report.ratio
    );
}

#[test]
fn tick_compresses_and_persists_snapshot() {
    let dir = std::env::temp_dir().join(format!("tve-brain-snap-{}", std::process::id()));
    let path = dir.join("snapshot.json.gz");
    let brain = Brain::new(Some(path.clone()));
    brain.observe("快照任务", "asset.read", true, 50);
    let report = brain.tick();
    assert!(report.snapshot_saved, "快照应落盘：{report:?}");
    assert!(path.is_file(), "快照文件应存在");
    // 重新构造：应恢复台账（技能摄取幂等，不破坏访问史）
    let brain2 = Brain::new(Some(path.clone()));
    let stats2 = brain2.stats();
    assert!(
        stats2.methods.iter().any(|m| m.method == "asset.read"),
        "重启后台账应恢复：{:?}",
        stats2.methods
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn auto_tick_triggers_every_interval() {
    let brain = Brain::new(None);
    let mut ticked_at = None;
    for i in 0..25 {
        let r = brain.observe(&format!("任务{i}"), "asset.list", true, 10);
        if r.ticked.is_some() {
            ticked_at = Some(i);
            break;
        }
    }
    assert_eq!(ticked_at, Some(24), "第 25 次观测应触发自动维护");
    assert!(brain.stats().ticks >= 1);
}

#[test]
fn note_decision_counts_zones() {
    use policy::strategy::Decision;
    let brain = Brain::new(None);
    brain.note_decision(Decision::AutoExecute);
    brain.note_decision(Decision::NeedConfirm);
    brain.note_decision(Decision::Deny);
    let s = brain.stats();
    assert_eq!(s.decisions.auto_execute, 1);
    assert_eq!(s.decisions.need_confirm, 1);
    assert_eq!(s.decisions.denied, 1);
}
