// ---------------------------------------------------------------------------
// 文档基图元：构建期生成的 docs_index.json（public/docs submodule 的 22 篇
// 手册）经 include_str! 内嵌二进制，摄取为 Concept 节点群。与技能索引共同
// 构成神经图的"种子层"——冷启动即有非空底料，语义检索永远有据可查；
// docs 改动经 rerun-if-changed 重新内嵌，图谱与文档永不分叉。
// ---------------------------------------------------------------------------

use crate::brain::graph::{reinforce, upsert_embedded};
use crate::brain::model::{node_id, EdgeKind, NodeKind};
use crate::brain::policy::zones;
use crate::brain::skillsrc::ingest::top_tokens;
use crate::brain::store::hot::HotTier;
use std::sync::OnceLock;

use serde::Deserialize;

/// 与 build_docs.rs 的输出结构对应
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocEntry {
    /// 相对路径，如 "editor/scene.md" / "sdk/tween.md"
    pub id: String,
    pub title: String,
    pub summary: String,
}

fn load_index() -> &'static [DocEntry] {
    static INDEX: OnceLock<Vec<DocEntry>> = OnceLock::new();
    INDEX.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/docs_index.json")))
            .unwrap_or_else(|e| {
                eprintln!("[brain] 文档索引解析失败（按空索引继续）: {e}");
                Vec::new()
            })
    })
}

/// 内嵌文档清单（构建期快照）
pub fn embedded_docs() -> &'static [DocEntry] {
    load_index()
}

/// 每篇文档摄取的概念锚点上限（防长摘要撑爆图）
const CONCEPTS_PER_DOC: usize = 6;

#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocIngestReport {
    pub docs: usize,
    pub concepts: usize,
    pub commands: usize,
}

/// 全量摄取（幂等）：doc → Concept 节点（向量 = 标题+摘要+路径词），
/// Mentions → 词元锚点，Uses → 摘要中出现的已知 devtools 命令。
pub fn ingest_docs(hot: &mut HotTier, docs: &[DocEntry], now: u64) -> DocIngestReport {
    let mut report = DocIngestReport::default();
    for d in docs {
        ingest_one(hot, d, now, &mut report);
    }
    report
}

fn ingest_one(hot: &mut HotTier, d: &DocEntry, now: u64, report: &mut DocIngestReport) {
    // 路径分段是检索词料（"sdk/tween.md" → "sdk tween"）
    let path_words = d.id.replace(['/', '.', '-'], " ");
    let text = format!("{} {} {} {}", d.title, d.summary, path_words, d.id);
    let doc_id = node_id(NodeKind::Concept, &format!("doc:{}", d.id));
    upsert_embedded(hot, &doc_id, NodeKind::Concept, &d.title, &text, now);

    let mut seen = 0usize;
    for token in top_tokens(&format!("{} {}", d.title, d.summary), CONCEPTS_PER_DOC) {
        let cid = node_id(NodeKind::Concept, &token);
        upsert_embedded(hot, &cid, NodeKind::Concept, &token, &token, now);
        reinforce(hot, &doc_id, &cid, EdgeKind::Mentions, 0.15, now);
        seen += 1;
    }

    let mut found: Vec<String> = Vec::new();
    for m in zones::known_methods() {
        if text.contains(m) && !found.iter().any(|f| f == m) {
            found.push(m.to_string());
        }
    }
    for m in &found {
        let cmd_id = node_id(NodeKind::Command, m);
        upsert_embedded(hot, &cmd_id, NodeKind::Command, m, m, now);
        reinforce(hot, &doc_id, &cmd_id, EdgeKind::Uses, 0.2, now);
    }

    report.docs += 1;
    report.concepts += seen;
    report.commands += found.len();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_index_parses_and_nonempty() {
        let docs = embedded_docs();
        assert!(docs.len() >= 20, "docs submodule 手册必须全量内嵌：{}", docs.len());
        assert!(
            docs.iter().all(|d| !d.id.is_empty() && !d.title.is_empty() && !d.summary.is_empty()),
            "每篇文档都应有 id/标题/摘要"
        );
        assert!(
            docs.iter().any(|d| d.id == "sdk/tween.md"),
            "SDK 补间文档必须在列"
        );
    }

    #[test]
    fn ingest_builds_doc_concept_command_subgraph() {
        let mut hot = HotTier::default();
        let report = ingest_docs(&mut hot, embedded_docs(), 0);
        assert!(report.docs >= 20);
        assert!(report.concepts > 0);
        let doc_id = node_id(NodeKind::Concept, "doc:sdk/tween.md");
        assert!(hot.node(&doc_id).is_some(), "tween 文档应建 Concept 节点");
        // 幂等：重复摄取不清零访问史
        hot.touch(&doc_id, 7);
        ingest_docs(&mut hot, embedded_docs(), 9);
        assert_eq!(hot.node(&doc_id).unwrap().hits, 1, "重复摄取不得清零访问史");
    }
}
