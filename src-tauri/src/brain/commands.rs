// ---------------------------------------------------------------------------
// 大脑 Tauri 命令面：语义检索 / 策略规划 / 观测回写 / 状态报表 / 手动维护。
// 全部同步命令（微秒级内存操作，不占异步线程）；入参出参 camelCase 对齐前端。
// ---------------------------------------------------------------------------

use tauri::State;

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
