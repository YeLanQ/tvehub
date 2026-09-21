// ---------------------------------------------------------------------------
// i8 对称量化：f32 归一向量 → i8 桶值 + 预存模长。
// 每向量 64×4B(f32) → 64B(i8)+8B(norm)，压缩约 3.5×；余弦用 i32 点积，
// 量化噪声 < 0.01，对路由排序无感。这是"向量自压缩"的第一级。
// ---------------------------------------------------------------------------

use crate::brain::vector::embed::EMBED_DIM;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuantVec {
    pub dims: Vec<i8>,
    /// i8 向量的 L2 模长（编码时缓存，cos = dot/(na·nb)）
    pub norm: f32,
    /// 原始特征数（路由显著性阈值用：cos ≥ 3/√(n_q·n_v) 视为有效命中）
    pub features: u32,
}

impl QuantVec {
    /// 量化编码（输入应为 L2 归一后的向量；按最大绝对值对称缩放）
    pub fn encode(v: &[f32], features: u32) -> QuantVec {
        debug_assert_eq!(v.len(), EMBED_DIM);
        let max_abs = v.iter().fold(0f32, |m, &x| m.max(x.abs()));
        let scale = if max_abs < f32::EPSILON { 1.0 } else { 127.0 / max_abs };
        let dims: Vec<i8> = v.iter().map(|&x| (x * scale).round().clamp(-127.0, 127.0) as i8).collect();
        let norm = (|| {
            let s: i64 = dims.iter().map(|&d| i64::from(d) * i64::from(d)).sum();
            (s as f32).sqrt()
        })();
        QuantVec { dims, norm, features }
    }

    /// 与另一量化向量的余弦相似度（任一为零向量 → 0）
    pub fn cosine(&self, other: &QuantVec) -> f32 {
        if self.norm < f32::EPSILON || other.norm < f32::EPSILON {
            return 0.0;
        }
        let dot: i64 = self
            .dims
            .iter()
            .zip(&other.dims)
            .map(|(a, b)| i64::from(*a) * i64::from(*b))
            .sum();
        dot as f32 / (self.norm * other.norm)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain::vector::embed::embed;

    fn counted(text: &str) -> QuantVec {
        let (v, n) = embed(text);
        QuantVec::encode(&v, n)
    }

    #[test]
    fn roundtrip_cosine_close_to_f32() {
        let (a, na) = embed("写一个旋转脚本");
        let (b, nb) = embed("帮我写旋转脚本组件");
        let (c, nc) = embed("局域网共享设置");
        let (qa, qb, qc) = (
            QuantVec::encode(&a, na),
            QuantVec::encode(&b, nb),
            QuantVec::encode(&c, nc),
        );
        let f32_cos = |x: &[f32], y: &[f32]| -> f32 {
            x.iter().zip(y).map(|(p, q)| p * q).sum()
        };
        assert!((qa.cosine(&qb) - f32_cos(&a, &b)).abs() < 0.03, "量化余弦漂移过大");
        assert!(qa.cosine(&qb) > qa.cosine(&qc), "相似性排序应保持");
    }

    #[test]
    fn zero_vector_cosine_is_zero() {
        let z = QuantVec::encode(&vec![0.0; EMBED_DIM], 0);
        let q = counted("anything");
        assert_eq!(z.cosine(&q), 0.0);
        assert_eq!(z.norm, 0.0);
    }

    #[test]
    fn encode_preserves_feature_count() {
        let q = counted("写一个旋转脚本");
        assert_eq!(q.features, embed("写一个旋转脚本").1);
        assert!(q.features > 0);
    }
}
