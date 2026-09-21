// ---------------------------------------------------------------------------
// 技能注册表：构建期生成的 skills_index.json 经 include_str! 内嵌二进制。
// 解析一次常驻（OnceLock），供图谱摄取与助手策略路由共用——.agents/skills 与
// Rust 大脑的单一事实源在构建链路上收口，技能文档改动必然重新内嵌。
// ---------------------------------------------------------------------------

pub mod ingest;

use std::sync::OnceLock;

use serde::Deserialize;

/// 与 build_skills.rs 的输出结构对应
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub body: String,
}

fn load_index() -> &'static [SkillEntry] {
    static INDEX: OnceLock<Vec<SkillEntry>> = OnceLock::new();
    INDEX.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/skills_index.json")))
            .unwrap_or_else(|e| {
                eprintln!("[brain] 技能索引解析失败（按空索引继续）: {e}");
                Vec::new()
            })
    })
}

/// 内嵌技能清单（构建期快照）
pub fn embedded_skills() -> &'static [SkillEntry] {
    load_index()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_index_parses_and_nonempty() {
        let skills = embedded_skills();
        assert!(!skills.is_empty(), "本仓库构建必须内嵌 .agents/skills 技能组");
        assert!(
            skills.iter().all(|s| !s.id.is_empty() && !s.description.is_empty()),
            "每条技能都应有 id 与路由描述"
        );
        assert!(
            skills.iter().any(|s| s.id == "tve-agent-autonomy"),
            "自主决策框架技能必须在列"
        );
    }
}
