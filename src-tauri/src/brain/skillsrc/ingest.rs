// ---------------------------------------------------------------------------
// 技能摄取：把构建期内嵌的技能清单展开成图谱子图。
//   skill 节点（向量 = 名称+描述+正文截断）
//   ├─ Mentions → concept 节点（词频 Top-N 词元，路由锚点）
//   └─ Uses     → cmd 节点（正文中出现的已知 devtools 方法）
// 摄取幂等：重建 Brain 时重复调用只刷新文本与向量，不重置访问史与边权。
// ---------------------------------------------------------------------------

use crate::brain::graph::{reinforce, upsert_embedded};
use crate::brain::model::{node_id, EdgeKind, NodeKind};
use crate::brain::policy::zones;
use crate::brain::store::hot::HotTier;

use super::SkillEntry;

/// 每技能摄取的概念词元上限（防长正文撑爆图）
const CONCEPTS_PER_SKILL: usize = 8;

#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestReport {
    pub skills: usize,
    pub concepts: usize,
    pub commands: usize,
}

/// 全量摄取（幂等）
pub fn ingest_all(hot: &mut HotTier, skills: &[SkillEntry], now: u64) -> IngestReport {
    let mut report = IngestReport::default();
    for s in skills {
        ingest_one(hot, s, now, &mut report);
    }
    report
}

fn ingest_one(hot: &mut HotTier, s: &SkillEntry, now: u64, report: &mut IngestReport) {
    let skill_id = node_id(NodeKind::Skill, &s.id);
    let text = format!("{} {} {}", s.name, s.description, s.body);
    upsert_embedded(hot, &skill_id, NodeKind::Skill, &s.name, &text, now);

    // 概念锚点：名称 + 描述的高频词元（正文太长只做兜底，避免概念噪声）
    let concept_text = format!("{} {}", s.name, s.description);
    let mut seen_concepts: Vec<String> = Vec::new();
    for token in top_tokens(&concept_text, CONCEPTS_PER_SKILL) {
        let cid = node_id(NodeKind::Concept, &token);
        upsert_embedded(hot, &cid, NodeKind::Concept, &token, &token, now);
        reinforce(hot, &skill_id, &cid, EdgeKind::Mentions, 0.2, now);
        seen_concepts.push(cid);
    }

    // 执行面：正文中出现的已知命令 → Uses 边
    let mut found: Vec<String> = Vec::new();
    for m in zones::known_methods() {
        if s.body.contains(m) && !found.iter().any(|f| f == m) {
            found.push(m.to_string());
        }
    }
    for m in &found {
        let cmd_id = node_id(NodeKind::Command, m);
        upsert_embedded(hot, &cmd_id, NodeKind::Command, m, m, now);
        reinforce(hot, &skill_id, &cmd_id, EdgeKind::Uses, 0.3, now);
    }

    report.skills += 1;
    report.concepts += seen_concepts.len();
    report.commands += found.len();
}

/// 词元频次统计：中文按字/二元组、英文按词，取频次 Top-N（稳定排序）
fn top_tokens(text: &str, n: usize) -> Vec<String> {
    let mut freq: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for f in crate::brain::vector::embed::features(text) {
        *freq.entry(f).or_default() += 1;
    }
    let mut pairs: Vec<(String, usize)> = freq.into_iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    pairs.into_iter().take(n).map(|(t, _)| t).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain::skillsrc::SkillEntry;

    fn entry(id: &str, name: &str, desc: &str, body: &str) -> SkillEntry {
        SkillEntry {
            id: id.to_string(),
            name: name.to_string(),
            description: desc.to_string(),
            body: body.to_string(),
        }
    }

    #[test]
    fn ingest_builds_skill_concept_command_subgraph() {
        let mut hot = HotTier::default();
        let skills = [entry(
            "tve-scripting",
            "tve 脚本编写",
            "写节点组件脚本 Component 属性",
            "用 node.add 建节点后挂脚本；asset.write 写入 src 目录。",
        )];
        let report = ingest_all(&mut hot, &skills, 0);
        assert_eq!(report.skills, 1);
        assert!(report.concepts > 0, "应摄取概念锚点");
        assert!(
            hot.node(&node_id(NodeKind::Command, "node.add")).is_some(),
            "正文提到的已知命令应建 cmd 节点"
        );
        assert!(
            hot.get_edge(
                &node_id(NodeKind::Skill, "tve-scripting"),
                &node_id(NodeKind::Command, "node.add"),
                EdgeKind::Uses
            )
            .is_some(),
            "技能→命令应有 Uses 边"
        );
    }

    #[test]
    fn ingest_is_idempotent_for_hits() {
        let mut hot = HotTier::default();
        let skills = [entry("s", "脚本", "写脚本", "body")];
        ingest_all(&mut hot, &skills, 0);
        let id = node_id(NodeKind::Skill, "s");
        hot.touch(&id, 7);
        ingest_all(&mut hot, &skills, 9);
        let n = hot.node(&id).unwrap();
        assert_eq!(n.hits, 1, "重复摄取不得清零访问史");
    }
}
