// ---------------------------------------------------------------------------
// 工坊资源摄取：repos 文本层展开成图谱子图（与 docsrc 同构，id 段不同）。
//   concept:repos:<分类>/<文件> 节点（向量 = 标题+描述+id 词料）
//   ├─ Mentions → 词元锚点（标题+描述 Top-N）
//   └─ Uses     → 正文中出现的已知 devtools 命令
// sync（外部更新后的重对齐）：现存文件 upsert（保留访问史与边权）；
// 消失文件连同其边与向量一起摘除。词元锚点是全局共享结构，不随单文件
// 删除（留给 evolve 半衰期自然淡化）。
// ---------------------------------------------------------------------------

use std::collections::HashSet;

use crate::brain::graph::{reinforce, upsert_embedded};
use crate::brain::model::{node_id, EdgeKind, NodeKind};
use crate::brain::policy::zones;
use crate::brain::reposrc::RepoDoc;
use crate::brain::skillsrc::ingest::top_tokens;
use crate::brain::store::hot::HotTier;

/// repos 层节点 id 前缀（"concept:repos:<分类>/<文件>"）
pub const ID_PREFIX: &str = "concept:repos:";

/// 每个资源摄取的概念锚点上限（与 docs 基图元同档）
const CONCEPTS_PER_DOC: usize = 6;
/// 嵌入词料里的正文头部截断：原型的语义本体在代码里（class 名、tve API、
/// 中文属性标签），只有标题+描述路由命中会很弱；upsert_embedded 对 text
/// 有 400 字符封顶，正文头部取再多也只会被截掉
const BODY_HEAD_CHARS: usize = 260;

#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReposIngestReport {
    /// 指纹是否变化并重对齐（手动刷新未变更时为 false）
    pub changed: bool,
    pub docs: usize,
    pub concepts: usize,
    pub commands: usize,
    /// 因外部更新被摘除的过期节点数
    pub removed: usize,
}

/// 工坊资源文档 → 图节点 id："concept:repos:<分类>/<文件>"
pub fn doc_node_id(d: &RepoDoc) -> String {
    node_id(NodeKind::Concept, &format!("repos:{}", d.id))
}

/// 重对齐一轮：先摘除消失文件的节点/边/向量，再全量幂等摄取现存文件。
pub fn sync(hot: &mut HotTier, docs: &[RepoDoc], now: u64) -> ReposIngestReport {
    let mut report = ReposIngestReport { changed: true, ..Default::default() };
    let live: HashSet<String> = docs.iter().map(doc_node_id).collect();
    let stale: Vec<String> = hot
        .nodes
        .keys()
        .filter(|id| id.starts_with(ID_PREFIX) && !live.contains(id.as_str()))
        .cloned()
        .collect();
    if !stale.is_empty() {
        for id in &stale {
            hot.nodes.remove(id);
            hot.vectors.remove(id);
        }
        report.removed = stale.len();
        let keys: Vec<String> = hot.edges.keys().cloned().collect();
        for k in keys {
            let e = &hot.edges[&k];
            if stale.contains(&e.from) || stale.contains(&e.to) {
                hot.edges.remove(&k);
            }
        }
    }
    for d in docs {
        ingest_one(hot, d, now, &mut report);
    }
    report
}
fn ingest_one(hot: &mut HotTier, d: &RepoDoc, now: u64, report: &mut ReposIngestReport) {
    // 路径分段是检索词料（"code/Rotator.ts" → "code rotator ts"）；正文头部
    // 进嵌入词料（title+summary+path 之后，受 upsert 的 400 字符封顶约束）
    let path_words = d.id.replace(['/', '.', '-'], " ");
    let body_head: String = d.body.chars().take(BODY_HEAD_CHARS).collect();
    let text = format!("{} {} {} {} {}", d.title, d.summary, path_words, d.id, body_head);
    let nid = doc_node_id(d);
    upsert_embedded(hot, &nid, NodeKind::Concept, &d.title, &text, now);

    for token in top_tokens(&format!("{} {}", d.title, d.summary), CONCEPTS_PER_DOC) {
        let cid = node_id(NodeKind::Concept, &token);
        upsert_embedded(hot, &cid, NodeKind::Concept, &token, &token, now);
        reinforce(hot, &nid, &cid, EdgeKind::Mentions, 0.15, now);
        report.concepts += 1;
    }

    for m in zones::known_methods() {
        if text.contains(m) {
            let cmd_id = node_id(NodeKind::Command, m);
            upsert_embedded(hot, &cmd_id, NodeKind::Command, m, m, now);
            reinforce(hot, &nid, &cmd_id, EdgeKind::Uses, 0.2, now);
            report.commands += 1;
        }
    }
    report.docs += 1;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(id: &str, title: &str, summary: &str, body: &str) -> RepoDoc {
        RepoDoc {
            id: id.to_string(),
            title: title.to_string(),
            summary: summary.to_string(),
            body: body.to_string(),
        }
    }

    #[test]
    fn sync_builds_concept_subgraph_with_uses_edges() {
        let mut hot = HotTier::default();
        let docs = [doc(
            "code/Rotator.ts",
            "Rotator",
            "旋转脚本原型 node.add",
            "用 node.add 建节点后挂脚本。",
        )];
        let report = sync(&mut hot, &docs, 0);
        assert_eq!(report.docs, 1);
        assert!(report.concepts > 0, "应摄取概念锚点");
        let nid = doc_node_id(&docs[0]);
        assert_eq!(nid, "concept:repos:code/Rotator.ts");
        assert!(hot.node(&nid).is_some(), "资源应建 Concept 节点");
        assert!(
            hot.get_edge(&nid, &node_id(NodeKind::Command, "node.add"), EdgeKind::Uses).is_some(),
            "资源文本提到的已知命令应有 Uses 边"
        );
    }

    #[test]
    fn sync_preserves_hits_and_removes_stale_docs() {
        let mut hot = HotTier::default();
        let a = doc("code/A.ts", "A", "原型甲", "class A {}");
        let b = doc("code/B.ts", "B", "原型乙", "class B {}");
        sync(&mut hot, &[a.clone(), b.clone()], 0);
        hot.touch(&doc_node_id(&a), 7);
        // 外部删除了 B：A 的访问史保留，B 连边带节点一起下架
        let report = sync(&mut hot, &[a.clone()], 9);
        assert_eq!(report.removed, 1, "应摘除消失文件的节点：{:?}", report);
        assert!(hot.node(&doc_node_id(&b)).is_none());
        assert!(hot.vectors.get(&doc_node_id(&b)).is_none(), "过期向量应一并移除");
        assert_eq!(hot.node(&doc_node_id(&a)).unwrap().hits, 1, "存活文件访问史不清零");
        // 词元锚点是共享结构：A/B 共有的锚点不随 B 删除而消失
        assert!(
            hot.node(&node_id(NodeKind::Concept, "原型")).is_some(),
            "共享词元锚点应存活"
        );
    }

    #[test]
    fn sync_empty_docs_clears_all_repos_nodes() {
        let mut hot = HotTier::default();
        let a = doc("effect/A.shader", "A", "全息效果", "Shader \"effect/A\"");
        sync(&mut hot, &[a], 0);
        let report = sync(&mut hot, &[], 1);
        assert_eq!(report.removed, 1);
        assert!(
            !hot.nodes.keys().any(|k| k.starts_with(ID_PREFIX)),
            "资源清空后 repos 层节点应归零"
        );
    }
}
