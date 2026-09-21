// ---------------------------------------------------------------------------
// 冷层：情景记忆的磁盘归档（gzip 压缩 JSON，flate2 纯 Rust 后端）。
// - 惰性装载：首次 demote/promote 才读盘解压；
// - 内存只留解压后的条目表，flush 时整体重写归档（归档小，重写代价可忽略）；
// - promote_by_id：观测命中已冷却的任务时按 id 精确提升回热层。
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::PathBuf;

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};

use crate::brain::model::Snapshot;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ColdEntry {
    node: crate::brain::model::NodeRecord,
    vectors: Vec<(String, crate::brain::vector::QuantVec)>,
    edges: Vec<crate::brain::model::EdgeRecord>,
}

#[derive(Debug, Default)]
pub struct ColdTier {
    path: Option<PathBuf>,
    /// node_id → 归档条目（None = 尚未装载）
    entries: Option<HashMap<String, ColdEntry>>,
}

impl ColdTier {
    pub fn new(path: Option<PathBuf>) -> ColdTier {
        ColdTier { path, entries: None }
    }

    pub fn len(&self) -> usize {
        self.entries.as_ref().map(|e| e.len()).unwrap_or(0)
    }

    /// 从归档文件装载（文件不存在 = 空冷层；损坏视为空并保留现场以便排查）
    fn ensure_loaded(&mut self) -> &mut HashMap<String, ColdEntry> {
        if self.entries.is_none() {
            let map = self
                .path
                .as_ref()
                .and_then(|p| fs::File::open(p).ok())
                .and_then(|f| read_gz(f).ok())
                .unwrap_or_default();
            self.entries = Some(map);
        }
        self.entries.as_mut().expect("entries 已装载")
    }

    /// 热层记录整条下沉（节点 + 关联向量 + 关联边）
    pub fn demote(
        &mut self,
        node: crate::brain::model::NodeRecord,
        vectors: Vec<(String, crate::brain::vector::QuantVec)>,
        edges: Vec<crate::brain::model::EdgeRecord>,
    ) {
        let id = node.id.clone();
        self.ensure_loaded().insert(id, ColdEntry { node, vectors, edges });
    }

    /// 按 id 提升回热层；命中返回（节点, 向量, 边）并从冷层移除
    pub fn promote_by_id(
        &mut self,
        id: &str,
    ) -> Option<(
        crate::brain::model::NodeRecord,
        Vec<(String, crate::brain::vector::QuantVec)>,
        Vec<crate::brain::model::EdgeRecord>,
    )> {
        self.ensure_loaded().remove(id).map(|e| (e.node, e.vectors, e.edges))
    }

    /// 整体重写归档（无路径 = 测试/内存模式，静默跳过）
    pub fn flush(&mut self) -> Result<(), String> {
        let Some(path) = self.path.clone() else { return Ok(()) };
        let map = self.ensure_loaded();
        let parent = path.parent().map(|p| p.to_path_buf());
        if let Some(parent) = parent {
            fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        }
        // 原子写：先写临时文件再改名，避免中途崩溃留下半截归档
        let tmp = path.with_extension("gz.tmp");
        let file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut enc = GzEncoder::new(file, Compression::fast());
        serde_json::to_writer(&mut enc, &map).map_err(|e| e.to_string())?;
        enc.finish().map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }
}

fn read_gz(file: fs::File) -> Result<HashMap<String, ColdEntry>, String> {
    let mut dec = GzDecoder::new(file);
    let mut buf = String::new();
    dec.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    serde_json::from_str(&buf).map_err(|e| e.to_string())
}

/// 快照（热层持久化）写入：gzip + 原子替换
pub fn save_snapshot(path: &std::path::Path, snap: &Snapshot) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    let file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut enc = GzEncoder::new(file, Compression::fast());
    serde_json::to_writer(&mut enc, snap).map_err(|e| e.to_string())?;
    enc.finish().map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 快照读取（不存在 → None；损坏 → Err 交由调用方记日志后按新库处理）
pub fn load_snapshot(path: &std::path::Path) -> Result<Option<Snapshot>, String> {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let mut dec = GzDecoder::new(file);
    let mut buf = String::new();
    dec.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    serde_json::from_str(&buf)
        .map(Some)
        .map_err(|e| format!("快照解析失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain::model::{NodeKind, NodeRecord};
    use crate::brain::vector::QuantVec;

    fn temp_path(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "tve-brain-test-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&d);
        d.join("cold.json.gz")
    }

    fn sample(id: &str) -> (NodeRecord, Vec<(String, QuantVec)>, Vec<crate::brain::model::EdgeRecord>) {
        let node = NodeRecord {
            id: id.to_string(),
            kind: NodeKind::Task,
            label: id.to_string(),
            text: String::new(),
            hits: 1,
            last_hit: 1,
            created_at: 1,
        };
        (node, vec![], vec![])
    }

    #[test]
    fn demote_flush_promote_roundtrip() {
        let path = temp_path("roundtrip");
        let mut cold = ColdTier::new(Some(path.clone()));
        let (node, vectors, edges) = sample("task:abc");
        cold.demote(node, vectors, edges);
        cold.flush().expect("flush 应成功");

        let mut cold2 = ColdTier::new(Some(path.clone()));
        let (n, _, _) = cold2.promote_by_id("task:abc").expect("应能按 id 提升");
        assert_eq!(n.id, "task:abc");
        assert!(cold2.promote_by_id("task:abc").is_none(), "提升后冷层应移除");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn missing_archive_is_empty_cold_tier() {
        let mut cold = ColdTier::new(Some(temp_path("missing")));
        assert!(cold.promote_by_id("task:nope").is_none());
        cold.flush().expect("空冷层 flush 也应成功");
    }
}
