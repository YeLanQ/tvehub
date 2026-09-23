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
    // docs 基图元：手册全量入图，概念层保证检索底料非空
    assert!(
        stats.nodes_by_kind.get("concept").copied().unwrap_or(0) >= 20,
        "docs 应为概念层提供足量节点：{:?}",
        stats.nodes_by_kind
    );
    let plan = brain.plan("帮我写一个旋转脚本组件");
    assert!(!plan.skills.is_empty(), "脚本任务应路由到技能");
}

#[test]
fn routes_docs_queries_to_doc_nodes() {
    let brain = Brain::new(None);
    let hits = brain.query("补间动画 tween 缓动 easing", 6);
    assert!(
        hits.iter().any(|h| h.id.starts_with("concept:doc:")),
        "docs 概念基图元应可被检索命中：{:?}",
        hits.iter().map(|h| h.id.clone()).collect::<Vec<_>>()
    );
}

/// 工坊资源动态层：public/repos 文本资产（随仓库分发）应入图可检索、
/// 可按 id 直读全文——神经图的外部扩展面。
#[test]
fn repos_layer_ingested_and_routable() {
    let brain = Brain::new(None);
    let stats = brain.stats();
    assert!(
        stats.nodes_by_kind.get("concept").copied().unwrap_or(0) >= 20,
        "repos 层应与 docs 共同撑起概念层：{:?}",
        stats.nodes_by_kind
    );
    let hits = brain.query("Rotator 匀速自转", 20);
    assert!(
        hits.iter().any(|h| h.id == "concept:repos:code/Rotator.ts"),
        "仓库自带的 Rotator 原型应可被检索命中：{:?}",
        hits.iter().map(|h| h.id.clone()).collect::<Vec<_>>()
    );
    let doc = brain
        .repos_doc_read("code/Rotator.ts")
        .expect("repos 层应可直读");
    assert_eq!(doc.id, "code/Rotator.ts");
    assert!(!doc.body.is_empty(), "全文应含脚本内容");
    let briefs = brain.repos_doc_briefs();
    assert!(briefs.iter().any(|b| b.id == "code/Rotator.ts"), "目录应列出该资源");
}

/// 外部 repos 更新自动对齐：新增资源入图可检索，删除资源连边下架——
/// 全程不重启、不重新编译（指纹驱动的动态层语义）。
#[test]
fn repos_layer_realigned_on_external_updates() {
    let root = std::env::temp_dir().join(format!("tve-brain-repos-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("code")).unwrap();
    std::fs::write(root.join("code/Spin.ts"), "// @desc: 旋转原型\nclass Spin {}\n").unwrap();
    let brain = Brain::with_repos_root(None, root.clone());
    let hits = brain.query("Spin 旋转原型", 8);
    assert!(
        hits.iter().any(|h| h.id == "concept:repos:code/Spin.ts"),
        "初始资源应入图：{:?}",
        hits.iter().map(|h| h.id.clone()).collect::<Vec<_>>()
    );

    // 外部新增文件 → 刷新后目录与检索可见
    std::fs::write(root.join("code/Bob.ts"), "// @desc: 上下浮动原型\nclass Bob {}\n").unwrap();
    let report = brain.refresh_repos();
    assert!(report.changed, "外部新增应触发重对齐：{report:?}");
    assert_eq!(report.removed, 0);
    assert!(brain.repos_doc_read("code/Bob.ts").is_some(), "新资源应可直读");
    let hits2 = brain.query("Bob 上下浮动原型", 8);
    assert!(
        hits2.iter().any(|h| h.id == "concept:repos:code/Bob.ts"),
        "新增资源应可检索：{:?}",
        hits2.iter().map(|h| h.id.clone()).collect::<Vec<_>>()
    );

    // 外部删除文件 → 节点连边下架
    std::fs::remove_file(root.join("code/Spin.ts")).unwrap();
    let report = brain.refresh_repos();
    assert_eq!(report.removed, 1, "应摘除过期节点：{report:?}");
    assert!(brain.repos_doc_read("code/Spin.ts").is_none());
    let _ = std::fs::remove_dir_all(&root);
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
fn boot_persists_baseline_snapshot() {
    let dir = std::env::temp_dir().join(format!("tve-brain-boot-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join("snapshot.json.gz");
    {
        let _brain = Brain::new(Some(path.clone()));
        assert!(path.is_file(), "启动即应落基线快照（brain/ 目录随之可见）");
    }
    // 重启恢复：基线快照可读（技能摄取幂等，节点不重复）
    let brain2 = Brain::new(Some(path.clone()));
    let stats = brain2.stats();
    assert!(
        stats.nodes_by_kind.get("skill").copied().unwrap_or(0) >= 8,
        "重启后技能节点应恢复：{:?}",
        stats.nodes_by_kind
    );
    let _ = std::fs::remove_dir_all(&dir);
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
