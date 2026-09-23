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

/// 图谱命中的权威知识（技能/概念·docs 基图元·工坊资源层）：只给「是什么 +
/// 怎么取」的目录式指引，全文由助手按需 load_skill / load_doc / load_repo
/// 拉取——不预载内容撑大任务上下文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeHit {
    /// 节点 id："skill:<id>" / "concept:doc:<path>" / "concept:repos:<分类>/<文件>"
    pub id: String,
    pub label: String,
}

/// 从路由命中提取知识：技能、docs 文档概念与工坊资源；词元锚点（"用""本"
/// 这类单字概念节点）是路由辅助结构，不是知识，混进来会在注入文本里产生
/// 碎片。总名额 4；候选里有工坊资源时划拨最多 2 个名额给它——原型是任务
/// 的高价值参考，不划名额会被技能/文档占满（先过滤后截断，顺序保持得分序）。
pub fn knowledge_hits(hits: &[route::RouteHit]) -> Vec<KnowledgeHit> {
    let repos_cap = hits
        .iter()
        .filter(|h| h.id.starts_with("concept:repos:"))
        .count()
        .min(2);
    let general_cap = 4 - repos_cap;
    let mut out: Vec<KnowledgeHit> = Vec::new();
    let (mut general, mut repos) = (0usize, 0usize);
    for h in hits {
        if out.len() >= 4 {
            break;
        }
        let is_repos = h.id.starts_with("concept:repos:");
        if is_repos {
            if repos >= repos_cap {
                continue;
            }
            repos += 1;
        } else if h.id.starts_with("skill:") || h.id.starts_with("concept:doc:") {
            if general >= general_cap {
                continue;
            }
            general += 1;
        } else {
            continue;
        }
        out.push(KnowledgeHit { id: h.id.clone(), label: h.label.clone() });
    }
    out
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

/// 语言归一化前置层产物（助手 LLM 单轮结构化，前端校验后下发）：大脑的规则
/// NLU（分段/词典/字面特征）对口语化、含混的表述经常抓不准锚点；本结构由
/// 助手先把自然语言"翻译"成大脑可检索的形态——规范化任务表述 + 检索锚点 +
/// 已确认存在于工作区的文件（只校验存在性，不读内容）+ 任务类型分类。
/// spec 缺失 = 归一化不可用，大脑按原始文本走既有规则链路，行为不变。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormSpec {
    /// operate 命令操作 / create 指令创作 / optimize 指令优化 /
    /// analyze 指令解析 / chat 闲聊对话
    #[serde(default)]
    pub task_type: String,
    /// 规范化后的任务表述（分段与单元文本的输入；空则回落原始任务文本）
    #[serde(default)]
    pub task: String,
    /// 检索锚点（方法名/API 名/对象词，中英混合）——只并入检索词料，
    /// 不污染单元文本
    #[serde(default)]
    pub keywords: Vec<String>,
    /// 提及且经前端确认存在的项目文件（相对路径）——基名并入检索词料
    #[serde(default)]
    pub files: Vec<String>,
}

/// 任务类型的中文标注（轨迹展示用）
fn task_type_cn(task_type: &str) -> &'static str {
    match task_type {
        "operate" => "命令操作",
        "create" => "指令创作",
        "optimize" => "指令优化",
        "analyze" => "指令解析",
        "chat" => "闲聊对话",
        _ => "未分类",
    }
}

fn path_basename(p: &str) -> &str {
    p.rsplit(['/', '\\']).next().unwrap_or(p)
}

/// 无参数的绿灯方法（大脑可直执行的最小集合；全部在 zones 绿灯表内）
const DIRECT_NO_ARG: &[&str] = &["editor.state", "project.list", "scene.list", "asset.list"];

/// 拆解一段任务（检索会 touch 命中节点——神经图的访问加热闭环）。
/// 段内多命令展开：一段（逗号连排）可同时命中多个准确性原子任务
/// （建项目/加实体/读文件……各自生成直执行单元）；其余按预测生成模糊单元。
/// spec（语言归一化层产物）存在时：单元文本用规范化表述，检索词料并入
/// 锚点与文件基名；analyze 类型把默认 Act 阶段判成 Inspect；chat 直通
/// （零单元，仍做整任务知识检索）。
pub fn decompose(
    hot: &mut HotTier,
    task: &str,
    now: u64,
    root: Option<&str>,
    spec: Option<&NormSpec>,
) -> Decomposition {
    let mut traces: Vec<NluTrace> = Vec::new();
    let task_type = spec.map(|s| s.task_type.as_str()).unwrap_or("");
    // 规范化表述（空则回落原文）+ 检索锚点尾部（只进检索，不进单元文本）
    let base = match spec {
        Some(s) if !s.task.trim().is_empty() => s.task.trim().to_string(),
        _ => task.to_string(),
    };
    let enrich_tail: String = spec
        .map(|s| {
            let mut tail = String::new();
            for k in &s.keywords {
                tail.push(' ');
                tail.push_str(k.trim());
            }
            for f in &s.files {
                tail.push(' ');
                tail.push_str(path_basename(f));
            }
            tail
        })
        .unwrap_or_default();

    if let Some(s) = spec {
        traces.push(NluTrace {
            stage: "语言归一化".into(),
            detail: format!(
                "类型={} · 锚点 {} 个 · 工作区文件 {} 个",
                task_type_cn(task_type),
                s.keywords.len(),
                s.files.len()
            ),
        });
    }
    // 闲聊直通：不拆单元（前端 assistUnits 为空走直通路线），知识检索照做
    if task_type == "chat" {
        let task_hits = route::route(hot, &format!("{base}{enrich_tail}"), 6, now);
        let refs = knowledge_hits(&task_hits);
        traces.push(NluTrace {
            stage: "单元化完成".into(),
            detail: "纯对话任务，不拆单元，直通助手".into(),
        });
        return Decomposition { task: task.to_string(), units: Vec::new(), traces, refs };
    }

    let segs = segment::segment_text(&base);
    traces.push(NluTrace {
        stage: "语义解析".into(),
        detail: format!("任务拆为 {} 段语义", segs.len()),
    });

    let mut units: Vec<TaskUnit> = Vec::new();
    let mut graph_hits = 0usize;
    let mut lexicon_hits = 0usize;
    let mut direct_hits = 0usize;
    for seg in segs.into_iter() {
        // 神经图检索：段文本 → 技能/命令/概念节点（命中即加热）。top 6 给
        // 工坊资源留进候选的余地（knowledge_hits 层再做保底分账）；归一化
        // 锚点并入检索词料，单元文本保持干净的规范化表述
        let hits = route::route(hot, &format!("{seg}{enrich_tail}"), 6, now);
        let refs = knowledge_hits(&hits);
        let mut phase = matcher::phase_of(&seg);
        if task_type == "analyze" && phase == matcher::Phase::Act {
            phase = matcher::Phase::Inspect; // 解析类任务的默认视角是调研
        }
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
        // 绿色通道（唯一直执行例外）：死板过程命令——无参绿灯查询，大脑直接
        // 委托命令中心，不经助手
        if let Some(m) = &method {
            if DIRECT_NO_ARG.contains(&m.as_str()) {
                let mut p = serde_json::Map::new();
                if matches!(m.as_str(), "scene.list" | "asset.list") {
                    if let Some(r) = root {
                        p.insert("root".into(), Value::String(r.into()));
                    }
                }
                units.push(TaskUnit {
                    index: units.len() + 1,
                    text: seg,
                    method: method.clone(),
                    source: source.clone(),
                    zone,
                    phase,
                    refs,
                    exec: ExecMode::Direct,
                    params: Value::Object(p),
                });
                direct_hits += 1;
                continue;
            }
        }
        // 其余原子任务一律经助手：助手把自然语言转换为精准命令（方法+参数）
        // 后交决策中心派发。大脑提取的建议参数随单元下发，辅助助手精准转换。
        let suggestion = method.as_deref().and_then(|m| params::suggest(m, &seg));
        units.push(TaskUnit {
            index: units.len() + 1,
            text: seg,
            method,
            source,
            zone,
            phase,
            refs,
            exec: ExecMode::Assist,
            params: suggestion.unwrap_or(Value::Null),
        });
    }
    if direct_hits > 0 {
        traces.push(NluTrace {
            stage: "原子任务".into(),
            detail: format!("识别 {} 个准确性原子任务（大脑直执行）", direct_hits),
        });
    }

    // 隐式依赖提示：节点类任务需要项目在编辑器打开（node.add 报
    // 「没有活跃编辑器」），用户说"在项目中添加"时往往不会说"打开项目"——
    // 自动补一个 project.open 模糊单元（助手转换执行；绑定了工作区时附
    // 路径建议，刚创建的场景下助手按上下文打开刚建的项目）。
    let has_node_task = units.iter().any(|u| u.method.as_deref() == Some("node.add"));
    let has_open = units.iter().any(|u| u.method.as_deref() == Some("project.open"));
    if has_node_task && !has_open {
        let insert_at = units
            .iter()
            .position(|u| u.method.as_deref() == Some("project.create"))
            .map(|i| i + 1)
            .unwrap_or(0);
        let params = if insert_at == 0 {
            root.map(|r| json!({ "path": r })).unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        units.insert(
            insert_at,
            TaskUnit {
                index: 0,
                text: "在编辑器中打开项目".into(),
                method: Some("project.open".into()),
                source: Some("lexicon".into()),
                zone: Some(zones::zone_of("project.open")),
                phase: matcher::Phase::Act,
                refs: Vec::new(),
                exec: ExecMode::Assist,
                params,
            },
        );
        for (i, u) in units.iter_mut().enumerate() {
            u.index = i + 1; // 插入后重排序号
        }
    }
    traces.push(NluTrace {
        stage: "神经图检索".into(),
        detail: format!("命令命中：图谱 {graph_hits} 段 / 词典 {lexicon_hits} 段"),
    });
    // 整任务粒度路由一次（top 8），技能关联与知识命中同源提取——原先两次
    // 全图扫描只差 top_k，合并省一遍嵌入与余弦；轨迹展示仍取前 2 个技能，
    // 与旧行为一致（top 8 ⊇ top 2，取前 2 后顺序不变）。检索词料用规范化
    // 表述 + 锚点（存在时），命中率高于原始口语
    let task_hits = route::route(hot, &format!("{base}{enrich_tail}"), 8, now);
    let skills: Vec<String> = task_hits
        .iter()
        .filter(|h| h.kind == NodeKind::Skill)
        .take(2)
        .map(|h| h.label.clone())
        .collect();
    if !skills.is_empty() {
        traces.push(NluTrace {
            stage: "策略关联".into(),
            detail: format!("相近技能：{}", skills.join("、")),
        });
    }
    let refs = knowledge_hits(&task_hits);
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

    fn spec(task: &str, task_type: &str, keywords: &[&str], files: &[&str]) -> NormSpec {
        NormSpec {
            task: task.to_string(),
            task_type: task_type.to_string(),
            keywords: keywords.iter().map(|s| s.to_string()).collect(),
            files: files.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn norm_spec_enriches_routing_and_classifies() {
        let mut hot = graph();
        // 模拟工坊原型节点：口语化原文本不含其词面，锚点注入后应能命中
        upsert_embedded(
            &mut hot,
            "concept:repos:code/Rotator.ts",
            NodeKind::Concept,
            "Rotator",
            "Rotator 旋转原型 code Rotator ts 绕 Y 轴匀速自转 speed onUpdate",
            0,
        );
        let s = spec(
            "让这个物体慢慢转起来",
            "create",
            &["Rotator", "旋转", "自转"],
            &["src/TweenMotion.ts"],
        );
        let deco = decompose(&mut hot, "让它转起来", 0, None, Some(&s));
        assert!(
            deco.refs.iter().any(|r| r.id == "concept:repos:code/Rotator.ts"),
            "锚点应把口语任务路由到原型：{:?}",
            deco.refs
        );
        // 锚点只进检索词料，单元文本保持干净的规范化表述
        assert!(deco.units.iter().all(|u| !u.text.contains("Rotator")));
        assert!(
            deco.traces
                .iter()
                .any(|t| t.stage == "语言归一化" && t.detail.contains("指令创作")),
            "轨迹应标注归一化类型：{:?}",
            deco.traces
        );
    }

    #[test]
    fn analyze_type_inspects_and_chat_passes_through() {
        let mut hot = graph();
        // analyze：默认执行视角（Act）改判为调研（Inspect）
        let s = spec("介绍一下当前项目", "analyze", &[], &[]);
        let deco = decompose(&mut hot, "介绍一下", 0, None, Some(&s));
        assert!(
            deco.units.iter().all(|u| u.phase == matcher::Phase::Inspect),
            "解析类任务单元应为调研阶段：{:?}",
            deco.units
        );
        // chat：直通不拆单元（前端走直通路线）
        let c = spec("你好呀", "chat", &[], &[]);
        let deco = decompose(&mut hot, "你好呀", 0, None, Some(&c));
        assert!(deco.units.is_empty(), "chat 直通不拆单元：{:?}", deco.units);
        assert!(deco.traces.iter().any(|t| t.detail.contains("闲聊")));
    }

    #[test]
    fn builds_units_with_traces() {
        let mut hot = graph();
        let deco = decompose(&mut hot, "创建一个项目,然后添加一个立方体,最后保存场景", 0, None, None);
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
        let deco = decompose(&mut hot, "列出资产,然后写入一个脚本文件", 0, None, None);
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
        let deco = decompose(&mut hot, "   ", 0, None, None);
        assert!(deco.units.is_empty());
    }

    #[test]
    fn chit_chat_unit_without_method() {
        let mut hot = graph();
        let deco = decompose(&mut hot, "你好呀", 0, None, None);
        assert_eq!(deco.units.len(), 1);
        assert!(deco.units[0].method.is_none(), "闲聊不应有方法预测");
    }

    #[test]
    fn classifies_direct_and_assist_units() {
        let mut hot = graph();
        // 绿色通道：死板过程命令（无参绿灯查询）→ direct，root 注入参数
        let deco = decompose(&mut hot, "列出资产", 0, Some("P:/proj"), None);
        let u = &deco.units[0];
        assert_eq!(u.exec, ExecMode::Direct);
        assert_eq!(u.params["root"], "P:/proj");
        // 带参/写操作原子任务 → 助手转换（大脑建议参数随单元下发）
        let deco2 = decompose(&mut hot, "写入一个脚本文件", 0, None, None);
        assert_eq!(deco2.units[0].exec, ExecMode::Assist);
        assert!(deco2.units[0].params.is_null(), "无可提取参数不给建议");
        // 参数可提取 → assist + 建议参数（助手校验后转换）
        let deco3 = decompose(&mut hot, "读取 src/TweenMotion.ts", 0, None, None);
        assert_eq!(deco3.units[0].exec, ExecMode::Assist);
        assert_eq!(deco3.units[0].params["path"], "src/TweenMotion.ts");
        // 无方法预测 → assist 无建议
        let deco4 = decompose(&mut hot, "你好呀", 0, None, None);
        assert_eq!(deco4.units[0].exec, ExecMode::Assist);
        assert!(deco4.units[0].params.is_null());
    }

    #[test]
    fn inserts_project_open_before_node_directs() {
        // 用户原话场景——「创建项目名为 aixosp,在项目中添加天空盒/平面/
        // 方向光/环境光」缺"打开项目"动作,自动补 project.open 模糊单元
        let mut hot = graph();
        let deco = decompose(
            &mut hot,
            "创建一个3D项目,项目名为:aixosp,在项目中添加一个天空盒,放置一个平面作为地面,添加一个方向光,一个环境光",
            0,
            None,
            None,
        );
        let methods: Vec<&str> = deco
            .units
            .iter()
            .map(|u| u.method.as_deref().unwrap_or("?"))
            .collect();
        // 整段一个模糊单元：助手一轮内并行转换全部精准命令（建/开/加节点）
        assert_eq!(deco.units.len(), 1, "{:?}", deco.units);
        assert_eq!(methods[0], "project.create");
        assert_eq!(deco.units[0].params["name"], "aixosp");
        // 无 create：open 建议用当前工作区路径
        let deco2 = decompose(&mut hot, "添加一个天空盒", 0, Some("P:/proj"), None);
        assert_eq!(deco2.units[0].method.as_deref(), Some("project.open"));
        assert_eq!(deco2.units[0].params["path"], "P:/proj");
    }

    #[test]
    fn knowledge_hits_exclude_token_fragments() {
        // 回归：词元锚点概念（"用""本"这类单字节点）混进知识命中，
        // 注入文本出现碎片。只有技能/docs/工坊资源算知识。
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
                id: "concept:repos:code/Rotator.ts".into(),
                kind: NodeKind::Concept,
                label: "Rotator".into(),
                score: 0.6,
            },
            route::RouteHit {
                id: "cmd:node.add".into(),
                kind: NodeKind::Command,
                label: "node.add".into(),
                score: 0.5,
            },
        ];
        let refs = knowledge_hits(&hits);
        assert_eq!(refs.len(), 2, "词元与命令都应被过滤：{:?}", refs);
        assert_eq!(refs[0].id, "concept:doc:sdk/tween.md");
        assert_eq!(refs[1].id, "concept:repos:code/Rotator.ts");
    }

    #[test]
    fn knowledge_hits_reserve_slots_for_repos() {
        // 工坊资源保底名额：技能/文档把高分名额占满时，排在后面的 repos
        // 命中仍应拿到名额（原型参考是任务高价值知识）
        let mk = |id: &str, score: f32| route::RouteHit {
            id: id.to_string(),
            kind: NodeKind::Concept,
            label: id.to_string(),
            score,
        };
        let hits = vec![
            route::RouteHit {
                id: "skill:tve-sdk-scripting".into(),
                kind: NodeKind::Skill,
                label: "脚本".into(),
                score: 0.95,
            },
            mk("concept:doc:sdk/api.md", 0.9),
            mk("concept:doc:editor/scene.md", 0.85),
            mk("concept:doc:sdk/ui.md", 0.8),
            mk("concept:repos:code/TweenDemo.ts", 0.6),
            mk("concept:repos:code/Rotator.ts", 0.55),
        ];
        let refs = knowledge_hits(&hits);
        let ids: Vec<&str> = refs.iter().map(|r| r.id.as_str()).collect();
        assert!(ids.contains(&"concept:repos:code/TweenDemo.ts"), "repos 应有保底名额：{:?}", ids);
        assert_eq!(refs.len(), 4, "总名额仍为 4：{:?}", ids);
        // 名额保底不等于无中生有：候选里没有 repos 时不注入
        let none = knowledge_hits(&hits[..3]);
        assert!(none.iter().all(|r| !r.id.starts_with("concept:repos:")));
    }
}
