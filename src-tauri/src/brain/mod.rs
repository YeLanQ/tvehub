// ---------------------------------------------------------------------------
// 大脑门面：冷热存储 + 知识图谱 + 向量自压缩 + 观测台账 + 策略门控 的总装。
// 全部状态在一把 std::Mutex 后面（操作都是微秒-毫秒级内存操作，无阻塞 IO；
// 磁盘只发生在 tick 的 gzip 小文件原子替换）。
// 自律循环：observe →（每 TICK_EVERY 次自动）tick：因果衰减修剪 → 向量近重复
// 合并 → 情景冷却下沉 → 快照持久化。
// ---------------------------------------------------------------------------

use std::sync::Mutex;

pub mod commands;
pub mod docsrc;
pub mod dto;
pub mod execute;
pub mod fileidx;
pub mod graph;
pub mod metrics;
pub mod model;
pub mod nlu;
pub mod policy;
pub mod reposrc;
pub mod skillsrc;
pub mod store;
pub mod vector;

use dto::{BrainStats, MethodStat, ObserveReport, TickReport};
use graph::causal;
use graph::{evolve, redirect, route};
use metrics::OutcomeLedger;
use model::now_ms;
use policy::strategy::{build_plan, Decision, Plan};
use store::{hot::HotTier, HotColdStore};
use vector::VectorIndex;

/// 自动维护间隔：每 25 次观测触发一次 tick
const TICK_EVERY: u32 = 25;
/// 入参护栏：查询/任务文本上限（嵌入与分段都是 O(len)，超长输入直接截断；
/// 与 execute/observe 对 task 的 200 字截断同思路，防大输入拖慢决策路径）
const MAX_INPUT_CHARS: usize = 4096;
/// 工坊资源层外部更新检测节流：读路径高频，指纹扫描虽轻也不逐次做。
/// 外部 repos 改动最迟在本窗口后的下一次读路径自动入图（无需重新编译）。
const REPOS_CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(2);

fn clamp_input(s: &str) -> String {
    s.chars().take(MAX_INPUT_CHARS).collect()
}

#[derive(Debug, Default)]
struct BrainCore {
    store: HotColdStore,
    ledger: OutcomeLedger,
    events_since_tick: u32,
    ticks: u64,
    /// 累计合并掉的向量数（自压缩统计）
    merged_total: u64,
    /// 任务审批会话：任务文本 → 过期时刻（决策中心黄灯门控用；tick 清理过期项）
    approvals: std::collections::HashMap<String, u64>,
    /// 工坊资源动态层：最近一次扫描的文档集（load_repo 直答与目录回喂）
    repos_docs: Vec<reposrc::RepoDoc>,
    /// 工坊仓库根（生产 = crate::repos_root()；测试注入临时目录）
    repos_root: std::path::PathBuf,
    /// 上述文档集对应的仓库指纹（外部更新检测基准）
    repos_finger: u64,
    /// 上次指纹检查时刻（节流用；None 表示下次必查）
    repos_checked: Option<std::time::Instant>,
}

impl BrainCore {
    /// 任务当前审批的过期时刻（无审批或已过期返回 None）
    fn approved_at(&self, task: &str) -> Option<u64> {
        self.approvals.get(task).copied()
    }
}

pub struct Brain {
    core: Mutex<BrainCore>,
    /// 文件内模块索引（@ 大文件的索引+按需检索；自有锁不与 core 竞争）
    fileidx: Mutex<fileidx::FileIndexStore>,
}

impl Brain {
    /// 构造：恢复快照（若有）→ 幂等摄取内嵌技能图谱 → 工坊资源层入图。
    pub fn new(snapshot_path: Option<std::path::PathBuf>) -> Brain {
        Brain::with_repos_root(snapshot_path, crate::repos_root())
    }

    /// 注入工坊仓库根的构造（生产走 crate::repos_root()，测试注入临时目录）
    pub(crate) fn with_repos_root(
        snapshot_path: Option<std::path::PathBuf>,
        repos_root: std::path::PathBuf,
    ) -> Brain {
        let fileidx_path =
            snapshot_path.as_ref().map(|p| p.with_file_name("fileidx.json.gz"));
        let mut core = BrainCore {
            store: HotColdStore::new(snapshot_path.clone()),
            ledger: OutcomeLedger::default(),
            events_since_tick: 0,
            ticks: 0,
            merged_total: 0,
            approvals: std::collections::HashMap::new(),
            repos_docs: Vec::new(),
            repos_finger: 0,
            repos_checked: None,
            repos_root,
        };
        if let Some(snap) = core.store.restore() {
            core.ledger.by_method = snap.ledger;
        }
        let report = skillsrc::ingest::ingest_all(
            &mut core.store.hot,
            skillsrc::embedded_skills(),
            now_ms(),
        );
        // 文档基图元：docs 手册全量入图（Concept 节点群）——与技能共同保证
        // 语义检索的冷启动底料；任一索引缺失时另一层仍在
        let doc_report = docsrc::ingest_docs(&mut core.store.hot, docsrc::embedded_docs(), now_ms());
        // 工坊资源动态层：public/repos 文本资产运行时扫描入图（非内嵌——
        // 外部 repos 更新经指纹比对自动重对齐，无需重新编译项目）
        core.repos_docs = reposrc::scan(&core.repos_root);
        core.repos_finger = reposrc::fingerprint(&core.repos_root);
        let repos_report =
            reposrc::ingest::sync(&mut core.store.hot, &core.repos_docs, now_ms());
        // 启动即落基线快照：brain/ 目录随首启可见；低频使用（观测不足自动
        // tick 间隔）时的积累也不只停留在内存。内存模式（None）为空操作。
        let boot_saved = core.store.save(&core.ledger.by_method).is_ok();
        let boot_flushed = core.store.cold.flush().is_ok();
        if core.store.hot.nodes.is_empty() {
            eprintln!(
                "[brain] 警告：图谱为空（技能与文档索引均未摄取成功），语义检索将无命中"
            );
        }
        eprintln!(
            "[brain] 就绪：内嵌技能 {} 条，文档 {} 篇，工坊资源 {} 篇，热层节点 {}，边 {}，快照 {}",
            report.skills,
            doc_report.docs,
            repos_report.docs,
            core.store.hot.nodes.len(),
            core.store.hot.edges.len(),
            if boot_saved && boot_flushed { "已落盘" } else { "落盘失败" }
        );
        Brain { core: Mutex::new(core), fileidx: Mutex::new(fileidx::FileIndexStore::new(fileidx_path)) }
    }

    /// 语义检索（结构类节点：技能/命令/概念）
    pub fn query(&self, text: &str, top_k: usize) -> Vec<route::RouteHit> {
        let mut core = self.core.lock().expect("brain 锁");
        refresh_repos_locked(&mut core);
        route::route(&mut core.store.hot, &clamp_input(text), top_k, now_ms())
    }

    /// 策略规划（含效能门控决策）
    pub fn plan(&self, task: &str) -> Plan {
        let mut core = self.core.lock().expect("brain 锁");
        refresh_repos_locked(&mut core);
        let BrainCore { store, ledger, .. } = &mut *core;
        build_plan(&mut store.hot, ledger, &clamp_input(task), now_ms())
    }

    /// 语义单元化：任务文本 → 分段 → 神经图检索 + 命令预测 → 单元任务与
    /// 处理轨迹（前端过程容器上屏；准确性原子任务由前端代大脑直执行，
    /// 模糊单元转发助手推进，决策仍走 execute）。spec 为语言归一化前置层
    /// （助手 LLM 结构化）产物，存在时检索与分类以它为准；缺失回落原文。
    pub fn decompose(
        &self,
        task: &str,
        root: Option<&str>,
        spec: Option<&nlu::NormSpec>,
    ) -> nlu::Decomposition {
        let mut core = self.core.lock().expect("brain 锁");
        refresh_repos_locked(&mut core);
        nlu::decompose(&mut core.store.hot, &clamp_input(task), now_ms(), root, spec)
    }

    /// 工坊资源目录（id+title+summary，无正文；load_repo 缺/错 id 时回喂）
    pub fn repos_doc_briefs(&self) -> Vec<reposrc::RepoBrief> {
        let mut core = self.core.lock().expect("brain 锁");
        refresh_repos_locked(&mut core);
        core.repos_docs.iter().map(reposrc::RepoBrief::from).collect()
    }

    /// 读一篇工坊资源全文（load_repo 直答；先懒刷新对齐外部更新）
    pub fn repos_doc_read(&self, id: &str) -> Option<reposrc::RepoDoc> {
        let mut core = self.core.lock().expect("brain 锁");
        refresh_repos_locked(&mut core);
        core.repos_docs.iter().find(|d| d.id == id).cloned()
    }

    /// 手动刷新工坊资源层（brain_repos_refresh 命令；跳过节流强制比对）
    pub fn refresh_repos(&self) -> reposrc::ingest::ReposIngestReport {
        let mut core = self.core.lock().expect("brain 锁");
        core.repos_checked = None;
        match refresh_repos_locked(&mut core) {
            Some(mut r) => {
                r.changed = true;
                r
            }
            None => reposrc::ingest::ReposIngestReport {
                changed: false,
                docs: core.repos_docs.len(),
                ..Default::default()
            },
        }
    }

    /// 观测回写：记账 + 因果链进化；达到间隔自动 tick（自压缩/冷却/持久化）。
    pub fn observe(&self, task: &str, method: &str, ok: bool, ms: u64) -> ObserveReport {
        let mut core = self.core.lock().expect("brain 锁");
        let now = now_ms();
        core.ledger.record(method, ok, ms);
        // 冷却过的任务再次被提起：先从冷层提升（恢复访问史与因果边），再记录
        let task_id = model::node_id(model::NodeKind::Task, &model::task_hash(task));
        if core.store.hot.node(&task_id).is_none() {
            core.store.promote_one(&task_id);
        }
        let (chain_id, _task_id) = causal::record(&mut core.store.hot, task, method, ok, now);
        let stat = core.ledger.stat(method).expect("刚记录过必有统计");
        let score = policy::budget::score(Some(stat), method);
        core.events_since_tick += 1;
        let ticked = if core.events_since_tick >= TICK_EVERY {
            core.events_since_tick = 0;
            Some(tick_locked(&mut core))
        } else {
            None
        };
        ObserveReport {
            chain_id,
            ratio: score.ratio,
            accuracy: score.accuracy,
            auto_eligible: policy::budget::auto_eligible(score.ratio),
            ticked,
        }
    }

    /// 手动维护（brain_tick 命令）
    pub fn tick(&self) -> TickReport {
        let mut core = self.core.lock().expect("brain 锁");
        core.events_since_tick = 0;
        tick_locked(&mut core)
    }

    /// 全局状态报表（节点分布/压缩率/台账/决策计数）
    pub fn stats(&self) -> BrainStats {
        let core = self.core.lock().expect("brain 锁");
        let n = core.store.hot.vectors.len() as u64;
        let dim = vector::embed::EMBED_DIM as u64;
        BrainStats {
            nodes_by_kind: kind_counts(&core.store.hot),
            edges: core.store.hot.edges.len(),
            chains: core.store.hot.chains.len(),
            cold_entries: core.store.cold.len(),
            cold_loaded: core.store.cold.is_loaded(),
            cold_archive_present: core.store.cold.archive_present(),
            vector_raw_bytes: n * dim * 4,
            vector_stored_bytes: n * (dim + 8),
            merged_total: core.merged_total,
            ticks: core.ticks,
            total_energy: core.ledger.total_energy(),
            global_accuracy: core.ledger.global_accuracy(40.0, 0.995),
            decisions: core.ledger.decisions,
            methods: core
                .ledger
                .by_method
                .iter()
                .map(|(m, s)| {
                    let score = policy::budget::score(Some(s), m);
                    MethodStat {
                        method: m.clone(),
                        attempts: s.attempts,
                        successes: s.successes,
                        avg_ms: s.avg_ms(),
                        ratio: score.ratio,
                    }
                })
                .collect(),
        }
    }

    /// 决策计数入账（策略门控每次给出决策时调用）
    pub fn note_decision(&self, d: Decision) {
        let mut core = self.core.lock().expect("brain 锁");
        match d {
            Decision::AutoExecute => core.ledger.decisions.auto_execute += 1,
            Decision::NeedConfirm => core.ledger.decisions.need_confirm += 1,
            Decision::Deny => core.ledger.decisions.denied += 1,
        }
    }
}

/// 工坊资源层懒刷新（持锁调用）：节流窗口外比对仓库指纹，变了就重对齐图。
/// 返回 Some(报告) 表示发生了重对齐，None 表示指纹未变或在本窗口内已检查过。
fn refresh_repos_locked(core: &mut BrainCore) -> Option<reposrc::ingest::ReposIngestReport> {
    let now = std::time::Instant::now();
    if let Some(t) = core.repos_checked {
        if now.duration_since(t) < REPOS_CHECK_EVERY {
            return None;
        }
    }
    core.repos_checked = Some(now);
    let finger = reposrc::fingerprint(&core.repos_root);
    if finger == core.repos_finger {
        return None;
    }
    core.repos_finger = finger;
    core.repos_docs = reposrc::scan(&core.repos_root);
    let report = reposrc::ingest::sync(&mut core.store.hot, &core.repos_docs, model::now_ms());
    eprintln!(
        "[brain] 工坊资源层已更新：{} 篇入图，摘除 {} 个过期节点",
        report.docs, report.removed
    );
    Some(report)
}

/// 维护一轮：因果衰减修剪 → 向量近重复合并 → 情景冷却 → 快照持久化
fn tick_locked(core: &mut BrainCore) -> TickReport {
    let started = std::time::Instant::now();
    let now = now_ms();
    // 过期审批会话清理（approve_task 登记的黄灯豁免不能永久有效）
    core.approvals.retain(|_, exp| *exp > now);
    let (pruned_edges, _) = evolve(&mut core.store.hot, now);
    let merged = merge_vectors(&mut core.store.hot);
    core.merged_total += merged as u64;
    let mut demoted = 0;
    for _ in 0..8 {
        let Some(coldest) = core.store.hot.coldest_episodic(now) else { break };
        if !core.store.demote_one(&coldest) {
            break;
        }
        demoted += 1;
    }
    causal::trim_chains(&mut core.store.hot);
    let snapshot_saved = core.store.save(&core.ledger.by_method).is_ok();
    let cold_flushed = core.store.cold.flush().is_ok();
    core.ticks += 1;
    TickReport {
        pruned_edges,
        merged_vectors: merged,
        demoted_nodes: demoted,
        snapshot_saved: snapshot_saved && cold_flushed,
        elapsed_us: started.elapsed().as_micros(),
    }
}

/// 向量近重复合并：find_merges → 图谱重定向 → 向量移除
fn merge_vectors(hot: &mut HotTier) -> usize {
    let mut idx = VectorIndex::default();
    for (k, v) in hot.vectors.iter() {
        idx.put(k, v.clone());
    }
    let mut applied = 0;
    for (keep, drop) in idx.find_merges() {
        if redirect(hot, &drop, &keep) {
            hot.vectors.remove(&drop);
            applied += 1;
        }
    }
    applied
}

fn kind_counts(hot: &HotTier) -> std::collections::BTreeMap<String, usize> {
    let mut m = std::collections::BTreeMap::new();
    for n in hot.nodes.values() {
        let k = format!("{:?}", n.kind).to_lowercase();
        *m.entry(k).or_default() += 1;
    }
    m
}

#[cfg(test)]
mod tests;
