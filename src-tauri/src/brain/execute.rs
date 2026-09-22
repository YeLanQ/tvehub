// ---------------------------------------------------------------------------
// 大脑决策中心：前端助手只发起"决策"（调哪个工具 + 参数），执行权在本地
// 后端。本模块做门控决策（行动边界三区 + 任务审批会话），然后按命令模式
// 派发——复用 devtools 内部通道（require_tool 权限门控 → Rust 直答 → 中控
// 转发活跃编辑器执行器），不另建执行面；执行后观测回写（台账 + 因果链 +
// 自动 tick），取代原先前端的 fire-and-forget 上报。
// ---------------------------------------------------------------------------

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use super::dto::ObserveReport;
use super::model::now_ms;
use super::policy::budget;
use super::policy::strategy::Decision;
use super::policy::zones::{self, Zone};
use super::Brain;

/// 任务审批会话有效期：批准一次覆盖该任务的黄灯调用，超时自动失效
pub const APPROVAL_TTL_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecArgs {
    /// 所属任务（前端当前用户指令；观测记账与审批会话的键）
    pub task: String,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecStatus {
    /// 已执行（结果在 result；工具失败以 result.error 表达，回喂模型自纠）
    Ok,
    /// 黄灯且任务未获批：未执行，前端应请求用户批准后重发
    NeedConfirm,
    /// 拒绝执行
    Denied,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutcome {
    pub status: ExecStatus,
    pub decision: Decision,
    pub zone: Zone,
    pub reason: String,
    /// 该方法当前效能比（历史正确率/速度/能耗综合；冷启动为满分）
    pub ratio: f32,
    pub result: Option<Value>,
    /// 观测回执（needConfirm/denied 未执行，无观测）
    pub observe: Option<ObserveReport>,
}

/// 单调用门控（纯函数便于单测）：绿灯直接放行；黄灯须任务已获批准；
/// 红灯拒绝（当前区域表无红灯项，未知方法兜底黄灯——宁可多问，不可擅动）。
pub(crate) fn gate(zone: Zone, approved: bool) -> (Decision, String) {
    match zone {
        Zone::Red => (Decision::Deny, "红灯操作，禁止自主执行".to_string()),
        Zone::Green => (Decision::AutoExecute, "只读绿灯操作，直接执行".to_string()),
        Zone::Yellow if approved => (
            Decision::AutoExecute,
            "写操作（黄灯），任务已获用户批准".to_string(),
        ),
        Zone::Yellow => (
            Decision::NeedConfirm,
            "写操作（黄灯区）：需用户批准后才执行，批准一次即覆盖本任务的后续调用".to_string(),
        ),
    }
}

impl Brain {
    /// 执行一个工具调用。阻塞：内部派发可等待编辑器回填至 60s，调用方须放
    /// 阻塞线程池（与 devtools_internal_call 同规约）。三段式持锁：门控（锁）
    /// → 命令派发（无锁，可长阻塞）→ 观测回写（锁），大脑锁不跨派发持有。
    pub fn execute(&self, app: &AppHandle, args: ExecArgs) -> ExecOutcome {
        let task: String = args.task.chars().take(200).collect();
        let method = args.method.trim().to_string();
        let params = args.params.unwrap_or(Value::Null);

        // ① 门控决策：三区 + 审批会话 + 效能比 + 决策入账
        let (decision, reason, ratio, zone) = {
            let mut core = self.core.lock().expect("brain 锁");
            let now = now_ms();
            let approved = core.approved_at(&task).is_some_and(|exp| exp > now);
            let zone = zones::zone_of(&method);
            let score = budget::score(core.ledger.stat(&method), &method);
            let (d, r) = gate(zone, approved);
            match d {
                Decision::AutoExecute => core.ledger.decisions.auto_execute += 1,
                Decision::NeedConfirm => core.ledger.decisions.need_confirm += 1,
                Decision::Deny => core.ledger.decisions.denied += 1,
            }
            (d, r, score.ratio, zone)
        };
        if decision != Decision::AutoExecute {
            let status = if decision == Decision::NeedConfirm {
                ExecStatus::NeedConfirm
            } else {
                ExecStatus::Denied
            };
            return ExecOutcome {
                status,
                decision,
                zone,
                reason,
                ratio,
                result: None,
                observe: None,
            };
        }

        // ② 命令模式派发：与外部控制端同一 devtools 内部通道（含工具权限门控）
        let started = std::time::Instant::now();
        let res = crate::devtools::internal_call_blocking(app, method.clone(), params);
        let ms = started.elapsed().as_millis() as u64;
        let ok = res.is_ok();
        let result = Some(match res {
            Ok(v) => v,
            Err(e) => serde_json::json!({ "error": e }),
        });

        // ③ 观测回写：台账 + 因果链进化 + 达间隔自动 tick（自压缩/持久化）
        let observe = self.observe(&task, &method, ok, ms);
        ExecOutcome {
            status: ExecStatus::Ok,
            decision,
            zone,
            reason,
            ratio,
            result,
            observe: Some(observe),
        }
    }

    /// 任务审批会话：用户批准后登记，有效期内该任务的黄灯调用直接放行
    pub fn approve_task(&self, task: &str) {
        let task: String = task.chars().take(200).collect();
        let mut core = self.core.lock().expect("brain 锁");
        core.approvals.insert(task, now_ms() + APPROVAL_TTL_MS);
    }

    /// 审批会话是否在 now 时刻有效（now 参数化便于单测过期语义；仅供测试断言，
    /// 执行路径在持锁段内直接查 core.approved_at，避免二次加锁）
    #[cfg(test)]
    pub fn approval_valid(&self, task: &str, now: u64) -> bool {
        let task: String = task.chars().take(200).collect();
        let core = self.core.lock().expect("brain 锁");
        core.approved_at(&task).is_some_and(|exp| exp > now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_green_auto_yellow_needs_approval_red_denies() {
        let (d, _) = gate(Zone::Green, false);
        assert_eq!(d, Decision::AutoExecute, "绿灯只读直接执行");
        let (d, _) = gate(Zone::Yellow, false);
        assert_eq!(d, Decision::NeedConfirm, "黄灯未批准必须确认");
        let (d, _) = gate(Zone::Yellow, true);
        assert_eq!(d, Decision::AutoExecute, "黄灯获批后放行");
        let (d, _) = gate(Zone::Red, true);
        assert_eq!(d, Decision::Deny, "红灯即使获批也拒绝");
    }

    #[test]
    fn approval_session_covers_task_then_expires() {
        let brain = Brain::new(None);
        assert!(!brain.approval_valid("建个场景", now_ms()), "未批准不生效");
        brain.approve_task("建个场景");
        assert!(brain.approval_valid("建个场景", now_ms()));
        assert!(
            !brain.approval_valid("另一个任务", now_ms()),
            "只覆盖被批准的任务"
        );
        assert!(
            !brain.approval_valid("建个场景", now_ms() + APPROVAL_TTL_MS + 1),
            "超时后失效"
        );
    }

    #[test]
    fn every_known_method_gates_consistently_with_zone() {
        // 前端工具目录与后端区域表同源：绿灯自动执行、黄灯须批准、红灯拒绝
        for m in zones::known_methods() {
            let zone = zones::zone_of(m);
            let (d, _) = gate(zone, false);
            assert_eq!(
                d == Decision::AutoExecute,
                zone == Zone::Green,
                "{m} 门控与区域不一致"
            );
        }
    }
}
