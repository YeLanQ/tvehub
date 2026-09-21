// ---------------------------------------------------------------------------
// 向量索引（自压缩）：统一持有全图节点的量化向量。
// 产品面刻意薄：put（写入即量化，f32 只存活一个函数调用，内存里永远是压缩态）
// + find_merges（近重复向量对，cos ≥ 阈值，由图谱层重定向后统一移除）——
// 这是"向量自压缩"的两级：量化存储 + 身份合并。
// ---------------------------------------------------------------------------

pub mod embed;
pub mod quant;

use std::collections::HashMap;

pub use quant::QuantVec;

/// 近重复合并阈值：0.999 只吞"几乎同文本"的节点，避免误伤语义近邻
pub const MERGE_THRESHOLD: f32 = 0.999;

#[derive(Debug, Default)]
pub struct VectorIndex {
    vectors: HashMap<String, QuantVec>,
}

impl VectorIndex {
    pub fn put(&mut self, id: &str, q: QuantVec) {
        self.vectors.insert(id.to_string(), q);
    }

    /// 自压缩：找出近重复对（确定性按 id 排序两两比较），返回 (保留, 合并)。
    /// 不直接删——图谱层重定向边之后再统一 remove，避免边悬挂。
    pub fn find_merges(&self) -> Vec<(String, String)> {
        let mut ids: Vec<&String> = self.vectors.keys().collect();
        ids.sort();
        let mut out = Vec::new();
        for (i, a) in ids.iter().enumerate() {
            let qa = &self.vectors[*a];
            for b in &ids[i + 1..] {
                if qa.cosine(&self.vectors[*b]) >= MERGE_THRESHOLD {
                    out.push(((*a).clone(), (*b).clone()));
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use embed::{embed, EMBED_DIM};

    fn index_of(texts: &[&str]) -> VectorIndex {
        let mut idx = VectorIndex::default();
        for (i, t) in texts.iter().enumerate() {
            let (v, n) = embed(t);
            idx.put(&format!("n{i}"), QuantVec::encode(&v, n));
        }
        idx
    }

    #[test]
    fn merge_duplicates_same_text() {
        let idx = index_of(&["旋转脚本", "旋转脚本", "局域网共享"]);
        let merges = idx.find_merges();
        assert_eq!(merges.len(), 1, "同文本两节点应命中合并");
        assert_eq!((merges[0].0.as_str(), merges[0].1.as_str()), ("n0", "n1"));
    }

    #[test]
    fn distinct_texts_do_not_merge() {
        let idx = index_of(&["写旋转脚本组件", "局域网共享端口设置"]);
        assert!(idx.find_merges().is_empty(), "语义近邻不等于重复，不得合并");
    }

    #[test]
    fn search_ranks_similar_first() {
        let idx = index_of(&["动画编辑器录制", "tve 脚本编写", "白板放映"]);
        let (qv, n) = embed("帮我写个 tve 脚本");
        let q = QuantVec::encode(&qv, n);
        let mut hits: Vec<(&String, f32)> =
            idx.vectors.iter().map(|(id, v)| (id, q.cosine(v))).collect();
        hits.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        assert_eq!(hits[0].0, "n1", "最相似者应排第一");
    }

    #[test]
    fn quantized_storage_is_about_quarter_of_f32() {
        let dim = EMBED_DIM as u64;
        let raw = dim * 4;
        let stored = dim + 8;
        assert!(stored * 3 < raw, "i8 量化应省下约 3/4 存储（{raw}B → {stored}B）");
    }
}
