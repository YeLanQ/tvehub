// ---------------------------------------------------------------------------
// 语义单元化（自然语义处理层）：用户任务文本 →（分段）→（逐段神经图检索 +
// 命令预测）→ 有序单元任务 + 处理轨迹。单元是给前端助手的"小任务"——助手
// 逐单元推进小循环，避免整任务长线思考；预测方法只是入口建议，最终决策仍
// 经决策中心门控执行。全程确定性规则、微秒级，不调 LLM。
// ---------------------------------------------------------------------------

pub mod matcher;
pub mod params;
pub mod segment;

use serde::Serialize;
use serde_json::{json, Value};

use crate::brain::graph::route;
use crate::brain::model::NodeKind;
use crate::brain::policy::zones::{self, Zone};
use crate::brain::store::hot::HotTier;

/// 图谱命中的权威知识（技能/概念·docs 基图元）：只给「是什么 + 怎么取」的
/// 目录式指引，全文由助手按需 load_skill / load_doc 拉取——不预载内容撑大
/// 任务上下文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeHit {
    /// 节点 id："skill:<id>" / "concept:doc:<path>"
    pub id: String,
    pub label: String,
}

/// 从路由命中提取知识：只要技能与 docs 文档概念——词元锚点（"用""本"这类
/// 单字概念节点）是路由辅助结构，不是知识，混进来会在注入文本里产生碎片。
/// 先过滤后截断，避免名额被噪声占满。
pub fn knowledge_hits(hits: &[route::RouteHit]) -> Vec<KnowledgeHit> {
    hits.iter()
        .filter(|h| h.id.starts_with("skill:") || h.id.starts_with("concept:doc:"))
        .take(4)
        .map(|h| KnowledgeHit { id: h.id.clone(), label: h.label.clone() })
        .collect()
}

/// 单元执行模式：
/// - direct（准确性原子任务）：绿灯只读 + 方法明确 + 参数可提取/可缺省——
///   大脑直接委托命令中心（brain_execute）执行，不经助手，省一轮推理；
/// - assist（模糊原子任务）：写操作/参数不明——助手细化后仍经决策中心执行。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecMode {
    Direct,
    Assist,
}

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
    /// 图谱参考知识：本段命中的技能/概念（含 docs 基图元）——转发给助手作
    /// 深查提示（load_skill / 权威摘要），不参与门控
    pub refs: Vec<KnowledgeHit>,
    /// 执行模式：direct 大脑直执行 / assist 助手细化
    pub exec: ExecMode,
    /// direct 单元的直执行参数（assist 为 null）
    pub params: serde_json::Value,
}

/// 处理轨迹：每个阶段的短句（前端过程容器逐条上屏）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NluTrace {
    pub stage: String,
    pub detail: String,
}

/// 拆解产物：任务原文 + 单元序列 + 处理轨迹 + 整任务知识命中
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decomposition {
    pub task: String,
    pub units: Vec<TaskUnit>,
    pub traces: Vec<NluTrace>,
    /// 整任务粒度的图谱知识命中（技能/文档，结构化；直通路线的注入源）
    pub refs: Vec<KnowledgeHit>,
}

/// 无参数的绿灯方法（大脑可直执行的最小集合；全部在 zones 绿灯表内）
const DIRECT_NO_ARG: &[&str] = &["editor.state", "project.list", "scene.list", "asset.list"];

/// 拆解一段任务（检索会 touch 命中节点——神经图的访问加热闭环）。
/// 段内多命令展开：一段（逗号连排）可同时命中多个准确性原子任务
/// （建项目/加实体/读文件……各自生成直执行单元）；其余按预测生成模糊单元。
pub fn decompose(hot: &mut HotTier, task: &str, now: u64, root: Option<&str>) -> Decomposition {
    let mut traces: Vec<NluTrace> = Vec::new();
    let segs = segment::segment_text(task);
    traces.push(NluTrace {
        stage: "语义解析".into(),
        detail: format!("任务拆为 {} 段语义", segs.len()),
    });

    let mut units: Vec<TaskUnit> = Vec::new();
    let mut graph_hits = 0usize;
    let mut lexicon_hits = 0usize;
    let mut direct_hits = 0usize;
    for seg in segs.into_iter() {
        // 神经图检索：段文本 → 技能/命令/概念节点（命中即加热）
        let hits = route::route(hot, &seg, 4, now);
        let refs = knowledge_hits(&hits);
        let phase = matcher::phase_of(&seg);

        // 段内直执行命令展开（出现顺序）：建项目 → 开项目 → 实体 → 读文件
        let mut covered: Vec<String> = Vec::new();
        let mut push_direct = |units: &mut Vec<TaskUnit>,
                               method: &str,
                               params: Value,
                               covered: &mut Vec<String>| {
            direct_hits += 1;
            covered.push(method.to_string());
            units.push(TaskUnit {
                index: units.len() + 1,
                text: seg.clone(),
                method: Some(method.to_string()),
                source: Some("lexicon".into()),
                zone: Some(zones::zone_of(method)),
                phase: matcher::phase_of(&seg),
                refs: refs.clone(),
                exec: ExecMode::Direct,
                params,
            });
        };

        if seg.contains("项目") {
            if let Some(name) = params::extract_name(&seg) {
                if seg.contains("创建") || seg.contains("新建") || seg.contains("建") {
                    push_direct(
                        &mut units,
                        "project.create",
                        json!({ "name": name }),
                        &mut covered,
                    );
                }
            }
            if seg.contains("打开") || seg.contains("载入") {
                if let Some(p) = params::open_params(&seg, units.len() + 1) {
                    push_direct(&mut units, "project.open", p, &mut covered);
                }
            }
        }
        for (kind, subtype) in params::match_entities(&seg) {
            push_direct(
                &mut units,
                "node.add",
                params::node_params(kind, subtype),
                &mut covered,
            );
        }
        if let Some(path) = params::extract_path(&seg) {
            if seg.contains("读取") || seg.contains("查看") || seg.contains("@") {
                push_direct(&mut units, "asset.read", json!({ "path": path }), &mut covered);
            }
        }
        // 无参绿灯方法（查状态/列清单）：大脑代查
        if let Some((m, src)) = matcher::predict_method(&seg, &hits) {
            if DIRECT_NO_ARG.contains(&m.as_str()) && !covered.contains(&m) {
                let mut p = serde_json::Map::new();
                if matches!(m.as_str(), "scene.list" | "asset.list") {
                    if let Some(r) = root {
                        p.insert("root".into(), Value::String(r.into()));
                    }
                }
                push_direct(&mut units, &m, Value::Object(p), &mut covered);
                let _ = src;
            }
        }
        if !covered.is_empty() {
            // 直执行未覆盖的意图仍按预测补一个模糊单元（如"…再写个脚本"）
            if let Some((m, src)) = matcher::predict_method(&seg, &hits) {
                if !covered.contains(&m) {
                    let z = zones::zone_of(&m);
                    units.push(TaskUnit {
                        index: units.len() + 1,
                        text: seg.clone(),
                        method: Some(m.clone()),
                        source: Some(src.to_string()),
                        zone: Some(z),
                        phase,
                        refs,
                        exec: ExecMode::Assist,
                        params: Value::Null,
                    });
                    if src == "graph" {
                        graph_hits += 1;
                    } else {
                        lexicon_hits += 1;
                    }
                }
            }
            continue;
        }

        // 无直执行命中：预测 → 模糊单元（原路径）
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
        units.push(TaskUnit {
            index: units.len() + 1,
            text: seg,
            method,
            source,
            zone,
            phase,
            refs,
            exec: ExecMode::Assist,
            params: Value::Null,
        });
    }
    if direct_hits > 0 {
        traces.push(NluTrace {
            stage: "原子任务".into(),
            detail: format!("识别 {} 个准确性原子任务（大脑直执行）", direct_hits),
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
    // 整任务粒度的知识命中（技能 + docs 文档概念），结构化供直通路线注入
    let refs = knowledge_hits(&route::route(hot, task, 6, now));
    traces.push(NluTrace {
        stage: "单元化完成".into(),
        detail: format!("产出 {} 个单元任务，知识命中 {} 条", units.len(), refs.len()),
    });
    Decomposition { task: task.to_string(), units, traces, refs }
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
        let deco = decompose(&mut hot, "创建一个项目,然后添加一个立方体,最后保存场景", 0, None);
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
        let deco = decompose(&mut hot, "列出资产,然后写入一个脚本文件", 0, None);
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
        let deco = decompose(&mut hot, "   ", 0, None);
        assert!(deco.units.is_empty());
    }

    #[test]
    fn chit_chat_unit_without_method() {
        let mut hot = graph();
        let deco = decompose(&mut hot, "你好呀", 0, None);
        assert_eq!(deco.units.len(), 1);
        assert!(deco.units[0].method.is_none(), "闲聊不应有方法预测");
    }

    #[test]
    fn classifies_direct_and_assist_units() {
        let mut hot = graph();
        // 准确性原子任务：绿灯无参方法 → direct，root 注入参数
        let deco = decompose(&mut hot, "列出资产", 0, Some("P:/proj"));
        let u = &deco.units[0];
        assert_eq!(u.exec, ExecMode::Direct);
        assert_eq!(u.params["root"], "P:/proj");
        // 模糊原子任务：黄灯写操作 → 助手细化，不直执行
        let deco2 = decompose(&mut hot, "写入一个脚本文件", 0, None);
        assert_eq!(deco2.units[0].exec, ExecMode::Assist);
        // 绿灯带参方法：路径可提取 → direct
        let deco3 = decompose(&mut hot, "读取 src/TweenMotion.ts", 0, None);
        assert_eq!(deco3.units[0].exec, ExecMode::Direct);
        assert_eq!(deco3.units[0].params["path"], "src/TweenMotion.ts");
        // 无方法预测 → assist
        let deco4 = decompose(&mut hot, "你好呀", 0, None);
        assert_eq!(deco4.units[0].exec, ExecMode::Assist);
    }

    #[test]
    fn knowledge_hits_exclude_token_fragments() {
        // 回归：词元锚点概念（"用""本"这类单字节点）混进知识命中，
        // 注入文本出现碎片。只有技能与 docs 文档概念算知识。
        let hits = vec![
            route::RouteHit {
                id: "concept:用".into(),
                kind: NodeKind::Concept,
                label: "用".into(),
                score: 0.9,
            },
            route::RouteHit {
                id: "concept:doc:sdk/tween.md".into(),
                kind: NodeKind::Concept,
                label: "tween 补间动画".into(),
                score: 0.7,
            },
            route::RouteHit {
                id: "cmd:node.add".into(),
                kind: NodeKind::Command,
                label: "node.add".into(),
                score: 0.6,
            },
        ];
        let refs = knowledge_hits(&hits);
        assert_eq!(refs.len(), 1, "词元与命令都应被过滤：{:?}", refs);
        assert_eq!(refs[0].id, "concept:doc:sdk/tween.md");
    }
}
