// ---------------------------------------------------------------------------
// 语义单元化（自然语义处理层）：用户任务文本 →（分段）→（逐段神经图检索 +
// 命令预测）→ 有序单元任务 + 处理轨迹。单元是给前端助手的"小任务"——助手
// 逐单元推进小循环，避免整任务长线思考；预测方法只是入口建议，最终决策仍
// 经决策中心门控执行。全程确定性规则、微秒级，不调 LLM。
// ---------------------------------------------------------------------------

pub mod matcher;
pub mod segment;

use serde::Serialize;

use crate::brain::graph::route;
use crate::brain::model::NodeKind;
use crate::brain::policy::zones::{self, Zone};
use crate::brain::store::hot::HotTier;

/// 一个单元任务：一段语义 + 预测入口 + 边界区域 + 阶段
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUnit {
    /// 1 起始序号
    pub index: usize,
    /// 语义段原文（转发给助手的最小任务面）
    pub text: String,
    /// 预测的 devtools 方法（graph/lexicon 双来源；无预测为 None）
    pub method: Option<String>,
    /// 预测依据："graph"（神经图命令节点）| "lexicon"（关键词词典）
    pub source: Option<String>,
    /// 该方法的行动边界（未知/无预测为 None）
    pub zone: Option<Zone>,
    /// 任务阶段：inspect 调研 / act 执行 / verify 验证
    pub phase: matcher::Phase,
    /// 图谱参考知识：本段命中的技能/概念（含 docs 基图元）标签——转发给
    /// 助手作深查提示（load_skill / brain.query），不参与门控
    pub refs: Vec<String>,
}

/// 处理轨迹：每个阶段的短句（前端过程容器逐条上屏）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NluTrace {
    pub stage: String,
    pub detail: String,
}

/// 拆解产物：任务原文 + 单元序列 + 处理轨迹
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decomposition {
    pub task: String,
    pub units: Vec<TaskUnit>,
    pub traces: Vec<NluTrace>,
}

/// 拆解一段任务（检索会 touch 命中节点——神经图的访问加热闭环）
pub fn decompose(hot: &mut HotTier, task: &str, now: u64) -> Decomposition {
    let mut traces: Vec<NluTrace> = Vec::new();
    let segs = segment::segment_text(task);
    traces.push(NluTrace {
        stage: "语义解析".into(),
        detail: format!("任务拆为 {} 段语义", segs.len()),
    });

    let mut units = Vec::with_capacity(segs.len());
    let mut graph_hits = 0usize;
    let mut lexicon_hits = 0usize;
    for (i, seg) in segs.into_iter().enumerate() {
        // 神经图检索：段文本 → 技能/命令/概念节点（命中即加热）
        let hits = route::route(hot, &seg, 4, now);
        let (method, source, zone) = match matcher::predict_method(&seg, &hits) {
            Some((m, src)) => {
                if src == "graph" {
                    graph_hits += 1;
                } else {
                    lexicon_hits += 1;
                }
                let z = zones::zone_of(&m);
                (Some(m), Some(src.to_string()), Some(z))
            }
            None => (None, None, None),
        };
        let phase = matcher::phase_of(&seg);
        units.push(TaskUnit {
            index: i + 1,
            text: seg,
            method,
            source,
            zone,
            phase,
            refs: matcher::knowledge_refs(&hits),
        });
    }
    traces.push(NluTrace {
        stage: "神经图检索".into(),
        detail: format!("命令命中：图谱 {graph_hits} 段 / 词典 {lexicon_hits} 段"),
    });
    let skills: Vec<String> = route::route(hot, task, 2, now)
        .into_iter()
        .filter(|h| h.kind == NodeKind::Skill)
        .map(|h| h.label)
        .collect();
    if !skills.is_empty() {
        traces.push(NluTrace {
            stage: "策略关联".into(),
            detail: format!("相近技能：{}", skills.join("、")),
        });
    }
    traces.push(NluTrace {
        stage: "单元化完成".into(),
        detail: format!("产出 {} 个单元任务", units.len()),
    });
    Decomposition { task: task.to_string(), units, traces }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain::graph::upsert_embedded;
    use crate::brain::model::EdgeKind;
    use crate::brain::graph::reinforce;

    fn graph() -> HotTier {
        let mut hot = HotTier::default();
        upsert_embedded(
            &mut hot,
            "cmd:project.create",
            NodeKind::Command,
            "project.create",
            "新建项目 创建项目 project.create 模板",
            0,
        );
        upsert_embedded(&mut hot, "cmd:node.add", NodeKind::Command, "node.add", "node.add", 0);
        reinforce(
            &mut hot,
            "cmd:project.create",
            "cmd:node.add",
            EdgeKind::Uses,
            0.5,
            0,
        );
        hot
    }

    #[test]
    fn builds_units_with_traces() {
        let mut hot = graph();
        let deco = decompose(&mut hot, "创建一个项目,然后添加一个立方体,最后保存场景", 0);
        assert!(!deco.traces.is_empty(), "应有处理轨迹");
        assert!(deco.units.len() >= 2, "应拆出多单元：{:?}", deco.units);
        assert_eq!(deco.units[0].index, 1);
        let all_traces = deco
            .traces
            .iter()
            .map(|t| t.stage.clone())
            .collect::<Vec<_>>();
        assert!(all_traces.contains(&"语义解析".to_string()));
        assert!(all_traces.contains(&"单元化完成".to_string()));
    }

    #[test]
    fn predicts_methods_and_zones() {
        let mut hot = graph();
        let deco = decompose(&mut hot, "列出资产,然后写入一个脚本文件", 0);
        let u1 = &deco.units[0];
        assert_eq!(u1.method.as_deref(), Some("asset.list"));
        assert_eq!(u1.zone, Some(Zone::Green));
        let u2 = &deco.units[1];
        assert_eq!(u2.method.as_deref(), Some("asset.write"));
        assert_eq!(u2.zone, Some(Zone::Yellow));
    }

    #[test]
    fn empty_task_yields_empty_units() {
        let mut hot = graph();
        let deco = decompose(&mut hot, "   ", 0);
        assert!(deco.units.is_empty());
    }

    #[test]
    fn chit_chat_unit_without_method() {
        let mut hot = graph();
        let deco = decompose(&mut hot, "你好呀", 0);
        assert_eq!(deco.units.len(), 1);
        assert!(deco.units[0].method.is_none(), "闲聊不应有方法预测");
    }
}
