// ---------------------------------------------------------------------------
// 观测台账：每个命令方法的历史执行统计（次数/成功/耗时/能耗当量）。
// 效能比与正确率先验的数据源；快照可序列化，随大脑快照一起持久化。
// ---------------------------------------------------------------------------

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::brain::policy::budget;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyStat {
    pub attempts: u64,
    pub successes: u64,
    pub total_ms: u64,
    pub total_energy: f64,
}

impl StrategyStat {
    /// 拉普拉斯平滑正确率
    pub fn accuracy(&self, prior_w: f64, prior_p: f64) -> f64 {
        (self.successes as f64 + prior_w * prior_p) / (self.attempts as f64 + prior_w)
    }

    pub fn avg_ms(&self) -> f64 {
        if self.attempts == 0 {
            0.0
        } else {
            self.total_ms as f64 / self.attempts as f64
        }
    }

    pub fn record(&mut self, ok: bool, ms: u64, energy: f64) {
        self.attempts += 1;
        if ok {
            self.successes += 1;
        }
        self.total_ms += ms;
        self.total_energy += energy;
    }
}

/// 序列化形态（BTreeMap 的键是字符串，可直接进 JSON 快照）
pub type LedgerSnapshot = BTreeMap<String, StrategyStat>;

#[derive(Debug, Default)]
pub struct OutcomeLedger {
    pub by_method: LedgerSnapshot,
    pub decisions: Decisions,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decisions {
    pub auto_execute: u64,
    pub need_confirm: u64,
    pub denied: u64,
}

impl OutcomeLedger {
    pub fn stat(&self, method: &str) -> Option<&StrategyStat> {
        self.by_method.get(method)
    }

    pub fn record(&mut self, method: &str, ok: bool, ms: u64) -> f64 {
        let energy = budget::energy_units(method, ms as f64);
        self.by_method
            .entry(method.to_string())
            .or_default()
            .record(ok, ms, energy);
        energy
    }

    /// 全局正确率（拉普拉斯平滑；无记录 → 先验）
    pub fn global_accuracy(&self, prior_w: f64, prior_p: f64) -> f64 {
        let mut attempts = 0u64;
        let mut successes = 0u64;
        for s in self.by_method.values() {
            attempts += s.attempts;
            successes += s.successes;
        }
        (successes as f64 + prior_w * prior_p) / (attempts as f64 + prior_w)
    }

    pub fn total_energy(&self) -> f64 {
        self.by_method.values().map(|s| s.total_energy).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_accumulates_and_charges_energy() {
        let mut ledger = OutcomeLedger::default();
        ledger.record("asset.read", true, 100);
        ledger.record("asset.read", false, 300);
        let s = ledger.stat("asset.read").unwrap();
        assert_eq!(s.attempts, 2);
        assert_eq!(s.successes, 1);
        assert_eq!(s.total_ms, 400);
        assert!(s.total_energy > 0.0, "能耗当量应累计");
    }

    #[test]
    fn global_accuracy_smoothed() {
        let mut ledger = OutcomeLedger::default();
        assert!((ledger.global_accuracy(40.0, 0.995) - 0.995).abs() < 1e-9, "无记录取先验");
        ledger.record("asset.read", true, 10);
        let acc = ledger.global_accuracy(40.0, 0.995);
        assert!(acc > 0.99 && acc < 1.0, "一条成功记录应在先验之上、1 之下（{acc}）");
    }

    #[test]
    fn avg_ms_guard_against_zero_division() {
        let s = StrategyStat::default();
        assert_eq!(s.avg_ms(), 0.0);
    }
}
