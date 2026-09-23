// ---------------------------------------------------------------------------
// 大脑 Tauri 命令面：语义检索 / 策略规划 / 观测回写 / 状态报表 / 手动维护。
// 全部同步命令（微秒级内存操作，不占异步线程）；入参出参 camelCase 对齐前端。
// ---------------------------------------------------------------------------

use tauri::{Manager, State};

use super::execute::{ExecArgs, ExecOutcome};
use super::policy::strategy::Plan;
use super::{Brain, BrainStats, ObserveReport, TickReport};

#[tauri::command]
pub fn brain_query(
    state: State<'_, Brain>,
    text: String,
    top_k: Option<u32>,
) -> Result<Vec<super::graph::route::RouteHit>, String> {
    let hits = state.query(&text, top_k.unwrap_or(5).clamp(1, 20) as usize);
    Ok(hits)
}

#[tauri::command]
pub fn brain_plan(state: State<'_, Brain>, task: String) -> Result<Plan, String> {
    let plan = state.plan(&task);
    state.note_decision(plan.decision);
    Ok(plan)
}

/// 语义单元化（自然语义处理层 + 语言归一化前置层）：任务文本 →（归一化 spec
/// 可选：助手 LLM 结构化的类型/锚点/文件）→（分段 → 神经图检索 → 命令预测）
/// → 单元任务 + 处理轨迹。前端把轨迹与单元上屏过程容器，并把单元逐个转发
/// 助手推进小循环；单元内的工具决策仍经 brain_execute 决策中心门控执行。
#[tauri::command]
pub fn brain_decompose(
    state: State<'_, Brain>,
    task: String,
    root: Option<String>,
    spec: Option<super::nlu::NormSpec>,
) -> Result<super::nlu::Decomposition, String> {
    Ok(state.decompose(&task, root.as_deref(), spec.as_ref()))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserveArgs {
    pub task: String,
    pub method: String,
    pub ok: bool,
    /// 耗时毫秒（前端 performance.now 差值）
    pub ms: u64,
}

#[tauri::command]
pub fn brain_observe(state: State<'_, Brain>, args: ObserveArgs) -> Result<ObserveReport, String> {
    let task: String = args.task.chars().take(200).collect();
    Ok(state.observe(&task, &args.method, args.ok, args.ms))
}

#[tauri::command]
pub fn brain_stats(state: State<'_, Brain>) -> Result<BrainStats, String> {
    Ok(state.stats())
}

#[tauri::command]
pub fn brain_tick(state: State<'_, Brain>) -> Result<TickReport, String> {
    Ok(state.tick())
}

/// 大脑决策中心执行：门控（三区 + 任务审批会话 + 效能比）→ devtools 命令模式
/// 派发（权限门控 → Rust 直答 → 中控转发编辑器执行器）→ 观测回写。黄灯未批准
/// 时返回 needConfirm（未执行），前端请求用户批准（brain_approve）后重发即可。
/// 派发可阻塞至 60s（编辑器执行器回填），整段放阻塞线程池——异步命令线程属
/// tokio 运行时，不能直接跑阻塞段。
#[tauri::command]
pub async fn brain_execute(app: tauri::AppHandle, args: ExecArgs) -> Result<ExecOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let brain = app.state::<Brain>();
        brain.execute(&app, args)
    })
    .await
    .map_err(|e| e.to_string())
}

/// 登记任务审批会话：用户批准后调用，该任务的黄灯方法在有效期内直接放行
#[tauri::command]
pub fn brain_approve(state: State<'_, Brain>, task: String) -> Result<(), String> {
    state.approve_task(&task);
    Ok(())
}

/// 内嵌技能全文（load_skill 的后端兜底源）：前端技能注册表是硬编码的子集，
/// 助手按大脑注入的内嵌 id 深查时以此为准——技能单一事实源收口到构建链。
#[tauri::command]
pub fn brain_skill_get(id: String) -> Result<Option<super::skillsrc::SkillEntry>, String> {
    Ok(super::skillsrc::embedded_skills()
        .iter()
        .find(|s| s.id == id)
        .cloned())
}

/// 内嵌文档全文（load_doc 直答）：public/docs 手册内嵌进二进制，助手读官方
/// 文档不依赖编辑器会话与磁盘布局。只读无副作用，不走决策中心门控。
#[tauri::command]
pub fn docs_read(id: String) -> Result<Option<super::docsrc::DocEntry>, String> {
    Ok(super::docsrc::read(&id).cloned())
}

/// 内嵌文档目录（id+title+summary，不含正文）：load_doc 缺 id/未知 id 时回喂，
/// 让模型一轮内自选正确文档，省掉「先 brain.query 再重试」的往返。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocBrief {
    pub id: String,
    pub title: String,
    pub summary: String,
}

#[tauri::command]
pub fn docs_list() -> Result<Vec<DocBrief>, String> {
    Ok(super::docsrc::embedded_docs()
        .iter()
        .map(|d| DocBrief {
            id: d.id.clone(),
            title: d.title.clone(),
            summary: d.summary.clone(),
        })
        .collect())
}

/// 工坊资源全文（load_repo 直答）：public/repos 文本资产的运行时层——外部
/// repos 更新后读路径懒刷新自动对齐，不经决策中心门控（只读无副作用）。
#[tauri::command]
pub fn repos_doc_read(
    state: State<'_, Brain>,
    id: String,
) -> Result<Option<super::reposrc::RepoDoc>, String> {
    Ok(state.repos_doc_read(&id))
}

/// 工坊资源目录（id+title+summary，无正文）：load_repo 缺/错 id 时回喂，
/// 模型一轮内自选正确资源；与 repos_doc_read 同源，含同一次懒刷新。
#[tauri::command]
pub fn repos_doc_list(state: State<'_, Brain>) -> Result<Vec<super::reposrc::RepoBrief>, String> {
    Ok(state.repos_doc_briefs())
}

/// 手动刷新工坊资源层（跳过节流强制比对指纹）。一般无需调用——读路径自带
/// 节流懒刷新；工坊页大量改文件后想立即生效时可主动触发。
#[tauri::command]
pub fn brain_repos_refresh(
    state: State<'_, Brain>,
) -> Result<super::reposrc::ingest::ReposIngestReport, String> {
    Ok(state.refresh_repos())
}
