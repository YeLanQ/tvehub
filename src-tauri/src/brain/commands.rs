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

/// 语义单元化（自然语义处理层）：任务文本 →（分段 → 神经图检索 → 命令预测）
/// → 单元任务 + 处理轨迹。前端把轨迹与单元上屏过程容器，并把单元逐个转发
/// 助手推进小循环；单元内的工具决策仍经 brain_execute 决策中心门控执行。
#[tauri::command]
pub fn brain_decompose(
    state: State<'_, Brain>,
    task: String,
) -> Result<super::nlu::Decomposition, String> {
    Ok(state.decompose(&task))
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
        Ok(brain.execute(&app, args))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 登记任务审批会话：用户批准后调用，该任务的黄灯方法在有效期内直接放行
#[tauri::command]
pub fn brain_approve(state: State<'_, Brain>, task: String) -> Result<(), String> {
    state.approve_task(&task);
    Ok(())
}
