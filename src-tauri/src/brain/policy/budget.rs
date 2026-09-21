// ---------------------------------------------------------------------------
// 效能预算：能耗与"速度×正确率"的比值门控（目标 ≥ 0.99）。
//   效能比 ratio = 正确率 × 效率分，效率分 = 0.5×速度分 + 0.5×能耗分
//   - 正确率：拉普拉斯平滑（先验 0.995/权重 40），无历史 ≈ 0.995 → 可绿灯自跑；
//     20 次里错 1 次 → 0.98 < 0.99 → 降级为需确认。
//   - 速度分：预算毫秒 / 实际毫秒（封顶 1），预算按方法分级；
//   - 能耗分：能耗预算 / 实际能耗当量（ms/1000 × 区域权重，封顶 1）。
// 全部单调、确定、可测——门控回归即测试回归。
// ---------------------------------------------------------------------------

use serde::{Deserialize, Serialize};

use crate::brain::metrics::StrategyStat;
use crate::brain::policy::zones;

/// 自主执行门槛：效能比必须 ≥ 此值才允许绿灯自主执行
pub const AUTO_RATIO: f32 = 0.99;
/// 正确率先验：40 次虚拟成功 @ 0.995（无历史时 ≈ 0.995，避免冷启动全卡死）
const PRIOR_WEIGHT: f64 = 40.0;
const PRIOR_ACCURACY: f64 = 0.995;
/// 能耗预算当量：绿读 ≈ 50ms×1 = 0.05，写 ≈ 3 倍；预算给 5 当量（很宽松）
const ENERGY_BUDGET: f64 = 5.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreBreakdown {
    pub accuracy: f64,
    pub speed: f64,
    pub energy: f64,
    /// 效能比（0..1）
    pub ratio: f32,
}

/// 按历史统计 + 方法预算计算效能比。无历史（attempts=0）时速度/能耗取满分。
pub fn score(stat: Option<&StrategyStat>, method: &str) -> ScoreBreakdown {
    let (accuracy, avg_ms) = match stat {
        Some(s) if s.attempts > 0 => (s.accuracy(PRIOR_WEIGHT, PRIOR_ACCURACY), s.avg_ms()),
        _ => (PRIOR_ACCURACY, 0.0),
    };
    let speed = if avg_ms <= 0.0 {
        1.0
    } else {
        (zones::speed_budget_ms(method) as f64 / avg_ms).min(1.0)
    };
    let energy = if avg_ms <= 0.0 {
        1.0
    } else {
        (ENERGY_BUDGET / energy_units(method, avg_ms)).min(1.0)
    };
    ScoreBreakdown {
        accuracy,
        speed,
        energy,
        ratio: (accuracy * (0.5 * speed + 0.5 * energy)) as f32,
    }
}

/// 一次调用的能耗当量（毫秒 × 区域权重 / 1000）
pub fn energy_units(method: &str, ms: f64) -> f64 {
    ms / 1000.0 * zones::energy_weight(method)
}

/// 效能比是否达到自主执行门槛
pub fn auto_eligible(ratio: f32) -> bool {
    ratio >= AUTO_RATIO
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stat(attempts: u64, successes: u64, total_ms: u64) -> StrategyStat {
        StrategyStat {
            attempts,
            successes,
            total_ms,
            total_energy: 0.0,
        }
    }

    #[test]
    fn cold_start_passes_gate() {
        let s = score(None, "asset.read");
        assert!(
            auto_eligible(s.ratio),
            "无历史的绿灯操作应可自主执行（ratio={}）",
            s.ratio
        );
    }

    #[test]
    fn single_recent_failure_drops_below_gate() {
        let s = score(Some(&stat(20, 19, 20_000)), "asset.read");
        assert!(
            !auto_eligible(s.ratio),
            "20 次错 1 次（0.98）应降到需确认（ratio={}）",
            s.ratio
        );
    }

    #[test]
    fn clean_history_recovers_above_gate() {
        let s = score(Some(&stat(100, 99, 40_000)), "asset.read");
        assert!(s.accuracy >= 0.99, "长线高正确率应回到门槛之上（acc={}）", s.accuracy);
        assert!(auto_eligible(s.ratio));
    }

    #[test]
    fn slow_calls_shrink_speed_score() {
        let fast = score(Some(&stat(10, 10, 10_000)), "asset.read");
        let slow = score(Some(&stat(10, 10, 200_000)), "asset.read");
        assert!(slow.speed < fast.speed);
        assert!(slow.ratio < fast.ratio, "变慢必须拉低效能比");
    }

    #[test]
    fn ratio_never_exceeds_one() {
        let s = score(Some(&stat(10, 10, 1_000)), "asset.read");
        assert!(s.ratio <= 1.0 + 1e-6);
    }

    #[test]
    fn gate_boundary_is_inclusive() {
        assert!(auto_eligible(0.99));
        assert!(!auto_eligible(0.989_999));
    }
}
