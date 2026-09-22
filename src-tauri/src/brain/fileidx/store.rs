// ---------------------------------------------------------------------------
// 文件索引持久化：<brain 目录>/fileidx.json.gz（gzip JSON，原子替换写，
// 仿 cold-snapshot 模式）。只存摘要/标题/行号/量化向量，不存正文——检索时
// 重读磁盘文件切片，索引体积与被索引文件数量解耦。
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};

use crate::brain::vector::QuantVec;

/// 单文件的持久化索引
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistFileIndex {
    /// 工作区相对路径
    pub path: String,
    /// 内容指纹（fnv1a64），失效判定唯一依据
    pub hash: u64,
    pub size: u64,
    /// 整文件抽取式摘要
    pub summary: String,
    /// 最近索引时刻（LRU 淘汰依据）
    pub updated_at: u64,
    pub modules: Vec<PersistModule>,
}

/// 单模块的持久化条目（正文不入库）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistModule {
    pub title: String,
    pub summary: String,
    pub line_start: usize,
    pub line_end: usize,
    pub vec: QuantVec,
}

/// 键 = root + \u{0} + rel_path（不同工作区同名文件互不串扰）
pub type FileIndexMap = HashMap<String, PersistFileIndex>;

pub fn index_key(root: &str, path: &str) -> String {
    format!("{root}\u{0}{}", path.trim_start_matches('/'))
}

/// 装载（不存在/损坏 → 空表；损坏保留现场交调用方记日志）
pub fn load(path: Option<&Path>) -> Result<FileIndexMap, String> {
    let Some(p) = path else { return Ok(HashMap::new()) };
    let file = match fs::File::open(p) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut dec = GzDecoder::new(file);
    let mut buf = String::new();
    dec.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    serde_json::from_str(&buf).map_err(|e| format!("fileidx 解析失败: {e}"))
}

/// 整表重写（原子写：临时文件 + 改名；无路径 = 内存模式静默跳过）
pub fn save(path: Option<&Path>, map: &FileIndexMap) -> Result<(), String> {
    let Some(p) = path else { return Ok(()) };
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("gz.tmp");
    let file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut enc = GzEncoder::new(file, Compression::fast());
    serde_json::to_writer(&mut enc, map).map_err(|e| e.to_string())?;
    enc.finish().map_err(|e| e.to_string())?;
    fs::rename(&tmp, p).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain::vector::embed::{embed, EMBED_DIM};

    fn temp_path(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tve-fileidx-{tag}-{}", std::process::id()));
        let _ = fs::create_dir_all(&d);
        d.join("fileidx.json.gz")
    }

    fn sample() -> PersistFileIndex {
        let (v, n) = embed("旋转脚本 Rotator");
        PersistFileIndex {
            path: "src/Rotator.ts".into(),
            hash: 0xABCD,
            size: 128,
            summary: "旋转组件".into(),
            updated_at: 42,
            modules: vec![PersistModule {
                title: "声明 class Rotator".into(),
                summary: "旋转组件：每帧自转".into(),
                line_start: 10,
                line_end: 40,
                vec: QuantVec::encode(&v, n),
            }],
        }
    }

    #[test]
    fn save_load_roundtrip_preserves_vectors() {
        let path = temp_path("roundtrip");
        let mut map = FileIndexMap::new();
        map.insert(index_key("C:/ws", "src/Rotator.ts"), sample());
        save(Some(&path), &map).expect("save 应成功");

        let loaded = load(Some(&path)).expect("load 应成功");
        let idx = loaded.get(&index_key("C:/ws", "src/Rotator.ts")).expect("键应还原");
        assert_eq!(idx.hash, 0xABCD);
        assert_eq!(idx.modules.len(), 1);
        assert_eq!(idx.modules[0].vec.dims.len(), EMBED_DIM);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn missing_and_none_paths_are_empty_maps() {
        assert!(load(Some(&temp_path("missing"))).expect("不存在视为空").is_empty());
        assert!(load(None).expect("内存模式视为空").is_empty());
        save(None, &FileIndexMap::new()).expect("内存模式 save 静默跳过");
    }
}
