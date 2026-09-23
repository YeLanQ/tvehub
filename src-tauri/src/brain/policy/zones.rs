// ---------------------------------------------------------------------------
// 行动边界三区：把 .agents/skills/tve-agent-autonomy 的"绿灯直接做 / 黄灯先
// 确认 / 红灯不做"编码成机器可判定的区域表。策略引擎据此决定自主执行还是
// 上报确认；未登记的方法一律按黄灯处理（宁可多问，不可擅动）。
// ---------------------------------------------------------------------------

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Zone {
    /// 绿灯：只读/无副作用，效能比达标即可自主执行
    Green,
    /// 黄灯：有副作用（写/建/删/开窗），必须先向用户确认
    Yellow,
    /// 红灯：禁止自主执行（当前目录为空，保留语义；未知方法按黄灯兜底）
    Red,
}

/// 只读方法 → 绿灯
const GREEN_METHODS: &[&str] = &[
    "editor.state",
    "state.snapshot",
    "project.list",
    "scene.list",
    "scene.tree",
    "node.select",
    "asset.list",
    "asset.read",
    "asset.select",
    "preview.screenshot",
    "file.index",
    "file.search",
    "file.module",
];

/// 登记过的全部方法（摄取时用于识别技能正文中的命令）
pub fn known_methods() -> &'static [&'static str] {
    ALL_METHODS
}

/// 方法是否在区域表登记（门控用：未登记方法不吃审批豁免，见 execute::gate）
pub fn is_known(method: &str) -> bool {
    ALL_METHODS.contains(&method)
}

pub fn zone_of(method: &str) -> Zone {
    if GREEN_METHODS.contains(&method) {
        return Zone::Green;
    }
    Zone::Yellow // 已登记写操作与未登记方法一律黄灯（宁可多问，不可擅动）
}

/// devtools 方法全量登记（与前端 tools.ts CATALOG 同集；新增方法两处同步）
const ALL_METHODS: &[&str] = &[
    "editor.state",
    "state.snapshot",
    "project.list",
    "project.create",
    "project.open",
    "project.close",
    "scene.list",
    "scene.open",
    "scene.save",
    "scene.tree",
    "node.select",
    "node.add",
    "node.remove",
    "node.rename",
    "node.set",
    "preview.open",
    "preview.close",
    "preview.start",
    "preview.stop",
    "preview.screenshot",
    "asset.list",
    "asset.read",
    "asset.write",
    "asset.create",
    "asset.select",
    "asset.delete",
    "asset.rename",
    "file.index",
    "file.search",
    "file.module",
];

/// 能耗权重：按副作用强度估算每次调用的相对能耗（速度分与能耗分都基于它）
pub fn energy_weight(method: &str) -> f64 {
    match zone_of(method) {
        Zone::Green => 1.0,
        _ => 3.0,
    }
}

/// 速度预算（毫秒）：超过预算的速度分开始衰减；重操作放宽
pub fn speed_budget_ms(method: &str) -> u64 {
    match method {
        "preview.start" | "preview.open" | "project.create" | "project.open" => 15_000,
        m if zone_of(m) == Zone::Green => 2_000,
        _ => 5_000,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readonly_is_green_mutating_is_yellow() {
        assert_eq!(zone_of("asset.read"), Zone::Green);
        assert_eq!(zone_of("scene.list"), Zone::Green);
        assert_eq!(zone_of("asset.write"), Zone::Yellow);
        assert_eq!(zone_of("node.remove"), Zone::Yellow);
    }

    #[test]
    fn unknown_method_falls_back_to_yellow() {
        assert_eq!(zone_of("system.format_disk"), Zone::Yellow);
        assert!(!known_methods().contains(&"system.format_disk"));
    }

    #[test]
    fn every_registered_method_has_zone_and_budget() {
        for m in known_methods() {
            let _ = zone_of(m);
            assert!(speed_budget_ms(m) >= 2_000, "{m} 应有速度预算");
            assert!(energy_weight(m) >= 1.0);
        }
    }

    #[test]
    fn heavy_operations_get_wider_budget() {
        assert!(speed_budget_ms("preview.start") > speed_budget_ms("asset.read"));
    }
}
