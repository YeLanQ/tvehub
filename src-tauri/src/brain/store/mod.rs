// ---------------------------------------------------------------------------
// 冷热数据中心门面：hot（内存热层）+ cold（gzip 归档冷层）+ 快照持久化。
// 下沉（demote）：挑温度最低的情景节点，连带向量与边整体搬进冷层；
// 提升（promote）：观测命中冷却任务时按 id 搬回；
// 快照（snapshot/restore）：热层全量 gzip 落盘，应用重启恢复记忆。
// ---------------------------------------------------------------------------

pub mod cold;
pub mod hot;

use crate::brain::model::{NodeKind, Snapshot};
use crate::brain::store::cold::ColdTier;
use crate::brain::store::hot::HotTier;

#[cfg(test)]
use crate::brain::model::NodeRecord;

#[derive(Debug, Default)]
pub struct HotColdStore {
    pub hot: HotTier,
    pub cold: ColdTier,
    /// 热层快照路径（None = 内存模式，测试用）
    snapshot_path: Option<std::path::PathBuf>,
}

impl HotColdStore {
    pub fn new(snapshot_path: Option<std::path::PathBuf>) -> HotColdStore {
        HotColdStore {
            cold: ColdTier::new(snapshot_path.as_ref().map(|p| {
                p.with_file_name(format!(
                    "cold-{}",
                    p.file_name().and_then(|n| n.to_str()).unwrap_or("x")
                ))
            })),
            snapshot_path,
            hot: HotTier::default(),
        }
    }

    /// 单节点下沉：返回是否成功（结构类节点拒绝下沉）
    pub fn demote_one(&mut self, id: &str) -> bool {
        let Some(node) = self.hot.nodes.get(id) else {
            return false;
        };
        if !matches!(node.kind, NodeKind::Task | NodeKind::Outcome) {
            return false;
        }
        let node = node.clone();
        let vectors = self
            .hot
            .vectors
            .remove(id)
            .map(|v| vec![(id.to_string(), v)])
            .unwrap_or_default();
        let edges: Vec<_> = self
            .hot
            .edges
            .values()
            .filter(|e| e.from == id || e.to == id)
            .cloned()
            .collect();
        let edge_keys: Vec<_> = edges
            .iter()
            .map(|e| HotTier::edge_key(&e.from, &e.to, e.kind))
            .collect();
        for k in &edge_keys {
            self.hot.edges.remove(k);
        }
        // 因果链里只留占位（链仍在热层，节点冷却后可按 id 提升）
        self.cold.demote(node, vectors, edges);
        self.hot.nodes.remove(id);
        true
    }

    /// 按 id 从冷层提升（观测路径用：冷却任务被再次提起）
    pub fn promote_one(&mut self, id: &str) -> bool {
        let Some((node, vectors, edges)) = self.cold.promote_by_id(id) else {
            return false;
        };
        self.hot.upsert_node(node);
        for (vid, v) in vectors {
            self.hot.vectors.insert(vid, v);
        }
        for e in edges {
            let key = HotTier::edge_key(&e.from, &e.to, e.kind);
            self.hot.edges.insert(key, e);
        }
        true
    }

    /// 热层全量快照落盘
    pub fn save(&self, ledger: &crate::brain::metrics::LedgerSnapshot) -> Result<(), String> {
        let Some(path) = &self.snapshot_path else { return Ok(()) };
        let snap = Snapshot {
            nodes: self.hot.nodes.values().cloned().collect(),
            edges: self.hot.edges.values().cloned().collect(),
            chains: self.hot.chains.clone(),
            vectors: self
                .hot
                .vectors
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            ledger: ledger.clone(),
            saved_at: crate::brain::model::now_ms(),
        };
        cold::save_snapshot(path, &snap)
    }

    /// 启动时恢复热层快照；无快照/损坏返回 None（损坏时调用方记日志）
    pub fn restore(&mut self) -> Option<Snapshot> {
        let path = self.snapshot_path.as_ref()?;
        let snap = cold::load_snapshot(path).ok().flatten()?;
        self.hot.chains = snap.chains.clone();
        self.hot.edges = snap
            .edges
            .iter()
            .cloned()
            .map(|e| (HotTier::edge_key(&e.from, &e.to, e.kind), e))
            .collect();
        self.hot.vectors = snap.vectors.iter().cloned().collect();
        self.hot.nodes = snap
            .nodes
            .iter()
            .cloned()
            .map(|n| (n.id.clone(), n))
            .collect();
        Some(snap)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain::model::node_id;

    fn task_node(key: &str) -> NodeRecord {
        NodeRecord {
            id: node_id(NodeKind::Task, key),
            kind: NodeKind::Task,
            label: key.to_string(),
            text: String::new(),
            hits: 0,
            last_hit: 0,
            created_at: 0,
        }
    }

    #[test]
    fn demote_moves_node_and_edges_to_cold() {
        let mut store = HotColdStore::new(None);
        let id = node_id(NodeKind::Task, "abc");
        store.hot.upsert_node(task_node("abc"));
        store.demote_one(&id);
        assert!(store.hot.node(&id).is_none(), "下沉后热层应无此节点");
        assert_eq!(store.cold.len(), 1, "冷层应收到归档条目");
        assert!(store.cold.promote_by_id(&id).is_some(), "冷层应能按 id 取回");
    }

    #[test]
    fn structural_nodes_refuse_demotion() {
        let mut store = HotColdStore::new(None);
        let id = node_id(NodeKind::Skill, "tve-scripting");
        store.hot.upsert_node(NodeRecord {
            id: id.clone(),
            kind: NodeKind::Skill,
            label: "x".into(),
            text: String::new(),
            hits: 0,
            last_hit: 0,
            created_at: 0,
        });
        assert!(!store.demote_one(&id), "结构类必须拒绝下沉");
        assert!(store.hot.node(&id).is_some());
    }

    #[test]
    fn promote_restores_node() {
        let mut store = HotColdStore::new(None);
        let id = node_id(NodeKind::Task, "abc");
        store.hot.upsert_node(task_node("abc"));
        store.demote_one(&id);
        assert!(store.promote_one(&id), "提升应命中");
        assert!(store.hot.node(&id).is_some());
    }
}
