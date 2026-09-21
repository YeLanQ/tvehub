// ---------------------------------------------------------------------------
// 向量嵌入：字符级 n-gram 哈希 → 稠密 f32 向量（L2 归一）。
// 选型理由：助手路由只需要"任务文本 ↔ 技能描述"的粗粒度语义相似，哈希嵌入
// 零依赖、O(len) 级、结果确定（同文本必同向量），比拉一个本地 NN 模型省两个
// 数量级的能耗——正符合效能比 ≥ 0.99 的目标约束。
// 特征 = ASCII 词元 + CJK 二元组，FNV-1a 散到 EMBED_DIM 个桶（符号交替）。
// ---------------------------------------------------------------------------

use crate::brain::model::fnv1a64;

/// 嵌入维度：128 桶 × i8 量化 = 每向量 ~136B。维度取 128 是噪声权衡：
/// 桶越少随机碰撞越多（64 维会吃掉小文本约三成余弦），再大对检索精度增益趋零。
pub const EMBED_DIM: usize = 128;

/// 文本 → (L2 归一嵌入, 原始特征数)。
/// 特征数供路由做显著性阈值：cos × √(n_q·n_v) ≈ 共享特征数。
/// 空文本/无特征返回零向量（调用方按 cos=0 处理）。
pub fn embed(text: &str) -> (Vec<f32>, u32) {
    let feats = features(text);
    let count = feats.len() as u32;
    let mut v = vec![0f32; EMBED_DIM];
    for f in feats {
        let h = fnv1a64(&f);
        // 桶与符号各过一层 splitmix64 终结器：FNV 高位与输入长度/字节模式相关，
        // 直接取高位做符号会让等长特征（如全部 CJK 二元组）系统性相消。
        let bucket = mix64(h) % EMBED_DIM as u64;
        let sign = if mix64(h ^ 0x9E37_79B9_7F4A_7C15) >> 63 == 1 { 1.0 } else { -1.0 };
        v[bucket as usize] += sign;
    }
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm < f32::EPSILON {
        return (v, count);
    }
    (v.into_iter().map(|x| x / norm).collect(), count)
}

fn mix64(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x4E00..=0x9FFF | 0x3400..=0x4DBF)
}

/// 特征提取（公开：摄取/路由分词共用）：ASCII 词元 + CJK 单字与二元组。
pub fn features(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let mut out = Vec::new();
    let mut word = String::new();
    for &c in &chars {
        if c.is_ascii_alphanumeric() {
            word.push(c);
            continue;
        }
        flush_word(&mut word, &mut out);
    }
    flush_word(&mut word, &mut out);
    // CJK：单字 + 相邻二元组（"旋转脚本" → 旋/转/旋转/转脚/脚本）
    for i in 0..chars.len() {
        if is_cjk(chars[i]) {
            out.push(chars[i].to_string());
            if i + 1 < chars.len() && is_cjk(chars[i + 1]) {
                out.push(format!("{}{}", chars[i], chars[i + 1]));
            }
        }
    }
    out
}

fn flush_word(word: &mut String, out: &mut Vec<String>) {
    if word.len() >= 2 && !STOPWORDS.contains(&word.as_str()) {
        out.push(word.clone());
    }
    word.clear();
}

/// 高频虚词停用表（只滤英文；中文靠字/词级特征天然无此问题）
const STOPWORDS: &[&str] = &[
    "the", "a", "an", "of", "to", "and", "or", "in", "on", "for", "with", "is", "are", "be", "at",
    "by", "it", "as",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn cosine(a: &[f32], b: &[f32]) -> f32 {
        let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
        let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
        if na * nb < f32::EPSILON {
            0.0
        } else {
            dot / (na * nb)
        }
    }

    #[test]
    fn deterministic_and_normalized() {
        let (a, _) = embed("写一个旋转脚本 Rotator");
        let (b, _) = embed("写一个旋转脚本 Rotator");
        assert_eq!(a, b, "同文本必须同向量（确定性）");
        let n: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((n - 1.0).abs() < 1e-4, "应 L2 归一，实际 {n}");
    }

    #[test]
    fn similar_text_scores_higher_than_unrelated() {
        let (base, _) = embed("编写节点组件脚本 Component 属性");
        let (near, _) = embed("帮我写个组件脚本 component");
        let (far, _) = embed("局域网共享端口设置");
        assert!(cosine(&base, &near) > cosine(&base, &far) + 0.05);
    }

    #[test]
    fn empty_text_gives_zero_vector_and_no_features() {
        let (v, count) = embed("");
        assert!(v.iter().all(|&x| x == 0.0));
        assert_eq!(count, 0);
    }
}
