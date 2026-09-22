// ---------------------------------------------------------------------------
// 文件内模块检索：查询嵌入 → 与模块向量余弦（共享特征显著性过滤，与图路由
// 同一口径）→ 命中不足时按词面重叠抢救中段候选 → top_k 按行号切片返回摘录。
// 纯函数，不触磁盘；正文由调用方从新鲜文件内容按行号切出。
// ---------------------------------------------------------------------------

use std::collections::HashSet;

use crate::brain::fileidx::store::PersistModule;
use crate::brain::vector::embed::{embed, features};
use crate::brain::vector::QuantVec;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleHit {
    pub title: String,
    pub summary: String,
    pub line_start: usize,
    pub line_end: usize,
    pub excerpt: String,
    pub score: f32,
}

/// 共享特征数下限：≈ cos×√(n_q·n_v)，与 route.rs 的 SEED_SIGNIFICANCE 同口径
const MIN_SHARED: f32 = 3.0;
/// 词面重叠奖励系数；无显著命中时的抢救门槛与弱信号余弦下限
const LEXICAL_BONUS: f32 = 0.15;
const RESCUE_OVERLAP: f32 = 0.2;
const WEAK_COS: f32 = 0.1;

/// 在单个文件的模块表内检索。lines 为该文件当前内容的行数组（索引新鲜时
/// 与建索引时一致）。
pub fn search_modules(
    modules: &[PersistModule],
    lines: &[&str],
    query: &str,
    top_k: usize,
    max_excerpt_chars: usize,
) -> Vec<ModuleHit> {
    if modules.is_empty() || query.trim().is_empty() {
        return Vec::new();
    }
    let (qv, qn) = embed(query);
    let qvec = QuantVec::encode(&qv, qn);
    let q_feats: HashSet<String> = features(query).into_iter().collect();

    let mut strong: Vec<(f32, usize)> = Vec::new();
    let mut weak: Vec<(usize, f32)> = Vec::new();
    for (i, m) in modules.iter().enumerate() {
        let cos = qvec.cosine(&m.vec);
        let shared = cos * ((qn as f32) * (m.vec.features as f32)).sqrt();
        if shared >= MIN_SHARED {
            strong.push((cos, i));
        } else if cos >= WEAK_COS {
            weak.push((i, cos));
        }
    }
    // 词面重叠只在候选上计算（避免整文件特征提取）；抢救显著命中不足的情况
    if strong.len() < top_k && !weak.is_empty() {
        let mut rescued: Vec<(f32, usize)> = weak
            .into_iter()
            .filter_map(|(i, cos)| {
                let overlap = lexical_overlap(&q_feats, &module_body(lines, modules[i].line_start, modules[i].line_end));
                (overlap > RESCUE_OVERLAP).then(|| (cos + LEXICAL_BONUS * overlap, i))
            })
            .collect();
        strong.append(&mut rescued);
    }
    strong.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
    strong
        .into_iter()
        .take(top_k)
        .map(|(score, i)| {
            let m = &modules[i];
            ModuleHit {
                title: m.title.clone(),
                summary: m.summary.clone(),
                line_start: m.line_start,
                line_end: m.line_end,
                excerpt: excerpt(lines, m.line_start, m.line_end, max_excerpt_chars),
                score,
            }
        })
        .collect()
}

fn module_body(lines: &[&str], line_start: usize, line_end: usize) -> String {
    lines[(line_start - 1).min(lines.len())..line_end.min(lines.len())].join("\n")
}

/// 查询特征在正文中的覆盖比例 |q∩body| / |q|
fn lexical_overlap(q_feats: &HashSet<String>, body: &str) -> f32 {
    if q_feats.is_empty() {
        return 0.0;
    }
    let body_feats: HashSet<String> = features(body).into_iter().collect();
    q_feats.iter().filter(|f| body_feats.contains(*f)).count() as f32 / q_feats.len() as f32
}

/// 模块正文摘录：按行号切片，超长按字符截断并标注
fn excerpt(lines: &[&str], line_start: usize, line_end: usize, max_chars: usize) -> String {
    let body = module_body(lines, line_start, line_end);
    if body.chars().count() <= max_chars {
        return body;
    }
    let mut cut: String = body.chars().take(max_chars).collect();
    cut.push_str("\n…（截断）");
    cut
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain::fileidx::store::PersistModule;

    fn module(title: &str, text: &str, line_start: usize) -> PersistModule {
        let (v, n) = embed(text);
        let lines: Vec<&str> = text.lines().collect();
        PersistModule {
            title: title.into(),
            summary: text.chars().take(40).collect(),
            line_start,
            line_end: line_start + lines.len() - 1,
            vec: QuantVec::encode(&v, n),
        }
    }

    const ROT: &str = "fn rotate(delta: f32) {\n    node.rotate_y(delta); // 每帧旋转自转\n}";
    const CAM: &str = "fn follow(target: &str) {\n    camera.look_at(target); // 相机跟随\n}";
    const CONTENT: &str = "fn rotate(delta: f32) {\n    node.rotate_y(delta); // 每帧旋转自转\n}\nfn follow(target: &str) {\n    camera.look_at(target); // 相机跟随\n}";

    fn fixture() -> (Vec<PersistModule>, Vec<&'static str>) {
        let lines: Vec<&str> = CONTENT.lines().collect();
        (vec![module("旋转模块", ROT, 1), module("相机模块", CAM, 4)], lines)
    }

    #[test]
    fn query_hits_relevant_module_with_line_range() {
        let (modules, lines) = fixture();
        let hits = search_modules(&modules, &lines, "旋转 自转 rotate", 2, 1800);
        assert!(!hits.is_empty(), "应命中旋转模块");
        assert_eq!(hits[0].title, "旋转模块");
        assert_eq!(hits[0].line_start, 1);
        assert_eq!(hits[0].line_end, 3);
        assert!(hits[0].excerpt.contains("rotate_y"));
    }

    #[test]
    fn unrelated_query_returns_empty() {
        let (modules, lines) = fixture();
        let hits = search_modules(&modules, &lines, "局域网共享端口设置", 2, 1800);
        assert!(hits.is_empty(), "完全无关的查询不应硬凑命中：{hits:?}");
    }

    #[test]
    fn excerpt_caps_at_char_budget_with_marker() {
        let text = "alpha beta keyword data\n".repeat(400);
        let modules = vec![module("长模块", &text, 1)];
        let lines: Vec<&str> = text.lines().collect();
        let hits = search_modules(&modules, &lines, "alpha beta keyword", 1, 1800);
        assert_eq!(hits.len(), 1, "查询词元与模块共享，应命中");
        assert!(hits[0].excerpt.chars().count() < 1900, "摘录应被截断");
        assert!(hits[0].excerpt.ends_with("…（截断）"));
    }

    #[test]
    fn empty_query_or_modules_yield_nothing() {
        let (modules, lines) = fixture();
        assert!(search_modules(&modules, &lines, "  ", 2, 1800).is_empty());
        assert!(search_modules(&[], &lines, "旋转", 2, 1800).is_empty());
    }
}
