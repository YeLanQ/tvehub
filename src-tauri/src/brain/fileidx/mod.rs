// ---------------------------------------------------------------------------
// 文件内模块索引：@ 引用的大文本文件不再整包进 LLM 上下文——决策中心先建
// 索引（切分 → 抽取式摘要 → 量化向量 → gzip 落盘），发送时只注入"文件摘要 +
// 模块目录"，模型按需 file.search 语义模糊匹配取相关段落（带行号摘录）。
// 索引按内容哈希缓存（文件未变零重建），不存正文（检索时重读磁盘切片）。
// ---------------------------------------------------------------------------

pub mod search;
pub mod split;
pub mod store;

use std::collections::HashMap;
use std::path::PathBuf;

use search::ModuleHit;
use split::RawModule;
use store::{FileIndexMap, PersistFileIndex, PersistModule};

use crate::brain::model::{fnv1a64, now_ms};
use crate::brain::vector::embed::embed;
use crate::brain::vector::QuantVec;

/// 单文件索引上限（asset.read 的 512KB 不适用：索引从不整包注入）
const MAX_INDEX_BYTES: u64 = 2 * 1024 * 1024;
/// 最多保留的文件索引数（按最近索引时刻 LRU 淘汰）
const MAX_ENTRIES: usize = 64;
/// brief 模块目录条数上限（注入上下文的目录截断；module_count 报全量）
pub const MAX_TOC_ENTRIES: usize = 40;
/// 模块/整文件抽取式摘要的字符上限
const SUMMARY_CHARS: usize = 120;
const FILE_SUMMARY_CHARS: usize = 200;
/// search 的 top_k 缺省与上限；摘录字符上限（与前端工具结果 4000 字截断匹配）
const DEFAULT_TOP_K: usize = 2;
const MAX_TOP_K: usize = 5;
const MAX_EXCERPT_CHARS: usize = 1800;

/// 注入用目录条目（不含向量）
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefModule {
    pub title: String,
    pub summary: String,
    pub line_start: usize,
    pub line_end: usize,
}

/// 索引回执（file.index 结果）：摘要 + 模块目录
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexBrief {
    pub path: String,
    pub summary: String,
    pub module_count: usize,
    pub modules: Vec<BriefModule>,
}

/// 惰性装载的文件索引表门面（自有锁，不与 BrainCore 竞争）
pub struct FileIndexStore {
    path: Option<PathBuf>,
    map: Option<FileIndexMap>,
}

impl FileIndexStore {
    pub fn new(path: Option<PathBuf>) -> FileIndexStore {
        FileIndexStore { path, map: None }
    }

    fn map(&mut self) -> &mut FileIndexMap {
        if self.map.is_none() {
            self.map = Some(store::load(self.path.as_deref()).unwrap_or_else(|e| {
                eprintln!("[brain] fileidx 装载失败，按空表处理: {e}");
                HashMap::new()
            }));
        }
        self.map.as_mut().expect("map 已装载")
    }

    /// 建/刷新索引（哈希命中直接回缓存 brief），落盘失败只记日志不回滚
    pub fn index(&mut self, root: &str, rel: &str, now: u64) -> Result<FileIndexBrief, String> {
        let (content, size) = read_workspace_file(root, rel)?;
        let hash = fnv1a64(&content);
        let key = store::index_key(root, rel);
        if let Some(idx) = self.map().get(&key) {
            if idx.hash == hash {
                return Ok(brief(idx));
            }
        }
        let idx = build_index(&content, rel, hash, size, now);
        let out = brief(&idx);
        let disk = self.path.clone();
        let map = self.map();
        map.insert(key, idx);
        evict_lru(map);
        if let Err(e) = store::save(disk.as_deref(), map) {
            eprintln!("[brain] fileidx 落盘失败: {e}");
        }
        Ok(out)
    }

    /// 文件内检索：索引缺失/失效自动重建后打分切片
    pub fn search(
        &mut self,
        root: &str,
        rel: &str,
        query: &str,
        top_k: usize,
        now: u64,
    ) -> Result<Vec<ModuleHit>, String> {
        let (content, size) = read_workspace_file(root, rel)?;
        let hash = fnv1a64(&content);
        let key = store::index_key(root, rel);
        let fresh = self.map().get(&key).is_some_and(|i| i.hash == hash);
        if !fresh {
            let idx = build_index(&content, rel, hash, size, now);
            let disk = self.path.clone();
            let map = self.map();
            map.insert(key.clone(), idx);
            evict_lru(map);
            if let Err(e) = store::save(disk.as_deref(), map) {
                eprintln!("[brain] fileidx 落盘失败: {e}");
            }
        }
        let idx = self.map().get(&key).expect("刚确保存在");
        let k = if top_k == 0 { DEFAULT_TOP_K } else { top_k.min(MAX_TOP_K) };
        let lines: Vec<&str> = content.lines().collect();
        Ok(search::search_modules(&idx.modules, &lines, query, k, MAX_EXCERPT_CHARS))
    }
}

/// 读工作区文本文件（路径安全化复用 devtools 规则；2MB 上限；拒二进制）
fn read_workspace_file(root: &str, rel: &str) -> Result<(String, u64), String> {
    let abs = crate::devtools::workspace_path_of(root, rel)?;
    let meta = std::fs::metadata(&abs).map_err(|_| "文件不存在".to_string())?;
    if !meta.is_file() {
        return Err("不是文件（目录请用 asset.list 浏览）".to_string());
    }
    if meta.len() > MAX_INDEX_BYTES {
        return Err(format!("文件超过 {}MB，暂不支持索引", MAX_INDEX_BYTES / 1024 / 1024));
    }
    let bytes = std::fs::read(&abs).map_err(|e| format!("读取失败: {e}"))?;
    let content = String::from_utf8(bytes).map_err(|_| "二进制文件不支持索引".to_string())?;
    Ok((content, meta.len()))
}

/// 全量重建：切分 → 抽取式摘要 → 标题+摘要+正文全量嵌入（哈希伪嵌入 O(len)）
fn build_index(content: &str, rel: &str, hash: u64, size: u64, now: u64) -> PersistFileIndex {
    let ext = rel.rsplit('.').next().unwrap_or("").to_lowercase();
    let ext = if ext == rel { String::new() } else { ext };
    let modules: Vec<PersistModule> = split::split_modules(content, &ext)
        .iter()
        .map(|m| {
            let (v, n) = embed(&format!("{}\n{}", m.title, m.body));
            PersistModule {
                title: m.title.clone(),
                summary: module_summary(m),
                line_start: m.line_start,
                line_end: m.line_end,
                vec: QuantVec::encode(&v, n),
            }
        })
        .collect();
    let summary = file_summary(&modules);
    PersistFileIndex { path: rel.to_string(), hash, size, summary, updated_at: now, modules }
}

/// 抽取式模块摘要：正文首个非空且不与标题重复的行，封顶 SUMMARY_CHARS
fn module_summary(m: &RawModule) -> String {
    let title = m.title.trim();
    m.body
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !title.contains(l) && !l.starts_with('#'))
        .next()
        .map(|l| l.chars().take(SUMMARY_CHARS).collect())
        .unwrap_or_else(|| title.trim_start_matches("声明 ").to_string())
}

/// 整文件摘要：前 3 个模块摘要串接
fn file_summary(modules: &[PersistModule]) -> String {
    modules
        .iter()
        .filter_map(|m| {
            let s = m.summary.trim();
            (!s.is_empty()).then(|| s.to_string())
        })
        .take(3)
        .collect::<Vec<_>>()
        .join("；")
        .chars()
        .take(FILE_SUMMARY_CHARS)
        .collect()
}

fn brief(idx: &PersistFileIndex) -> FileIndexBrief {
    FileIndexBrief {
        path: idx.path.clone(),
        summary: idx.summary.clone(),
        module_count: idx.modules.len(),
        modules: idx
            .modules
            .iter()
            .take(MAX_TOC_ENTRIES)
            .map(|m| BriefModule {
                title: m.title.clone(),
                summary: m.summary.clone(),
                line_start: m.line_start,
                line_end: m.line_end,
            })
            .collect(),
    }
}

fn evict_lru(map: &mut FileIndexMap) {
    while map.len() > MAX_ENTRIES {
        let Some(oldest) = map
            .iter()
            .min_by_key(|(_, v)| v.updated_at)
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        map.remove(&oldest);
    }
}

impl crate::brain::Brain {
    /// 建文件索引（file.index，只读绿灯）
    pub fn fileidx_index(&self, root: &str, rel: &str) -> Result<FileIndexBrief, String> {
        self.fileidx.lock().expect("fileidx 锁").index(root, rel, now_ms())
    }

    /// 文件内语义检索（file.search，只读绿灯；索引失效自动重建）
    pub fn fileidx_search(
        &self,
        root: &str,
        rel: &str,
        query: &str,
        top_k: usize,
    ) -> Result<Vec<ModuleHit>, String> {
        self.fileidx
            .lock()
            .expect("fileidx 锁")
            .search(root, rel, query, top_k, now_ms())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(tag: &str) -> String {
        let d = std::env::temp_dir().join(format!("tve-fileidx-ws-{tag}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        d.to_string_lossy().replace('\\', "/")
    }

    const SAMPLE: &str = "fn rotate(delta: f32) {\n    node.rotate_y(delta); // 每帧旋转自转\n}\n\nfn follow(target: &str) {\n    camera.look_at(target); // 相机跟随\n}\n";

    #[test]
    fn index_then_search_roundtrip() {
        let root = ws("roundtrip");
        std::fs::write(format!("{root}/Rotator.ts"), SAMPLE).unwrap();
        let mut st = FileIndexStore::new(None);
        let brief = st.index(&root, "Rotator.ts", 10).expect("索引应成功");
        assert_eq!(brief.module_count, 2, "两个 fn 两模块：{brief:?}");
        assert!(!brief.summary.is_empty());

        let hits = st.search(&root, "Rotator.ts", "旋转 自转 rotate", 2, 11).expect("检索应成功");
        assert!(!hits.is_empty());
        assert!(hits[0].title.contains("rotate"), "应命中旋转模块：{hits:?}");
        assert_eq!(hits[0].line_start, 1);
    }

    #[test]
    fn stale_file_auto_rebuilds_on_search() {
        let root = ws("stale");
        let file = format!("{root}/Doc.md");
        std::fs::write(&file, "# 旋转\n旋转内容\n").unwrap();
        let mut st = FileIndexStore::new(None);
        st.index(&root, "Doc.md", 10).expect("首次索引");

        std::fs::write(&file, "# 旋转\n旋转内容\n\n# 网络同步\nnet sync 状态同步\n").unwrap();
        let hits = st.search(&root, "Doc.md", "网络同步 sync", 1, 11).expect("检索应成功");
        assert!(!hits.is_empty(), "改写后检索应触发重建并命中新模块：{hits:?}");
        assert!(hits[0].title.contains("网络同步"));
    }

    #[test]
    fn brief_caps_toc_but_reports_full_count() {
        let root = ws("toc");
        let mut content = String::from("# 导语\nintro\n");
        for i in 0..45 {
            content.push_str(&format!("## 章节{i}\n内容 c{i}\n"));
        }
        std::fs::write(format!("{root}/Big.md"), &content).unwrap();
        let mut st = FileIndexStore::new(None);
        let brief = st.index(&root, "Big.md", 10).expect("索引应成功");
        assert_eq!(brief.module_count, 46, "导语 + 45 章节");
        assert_eq!(brief.modules.len(), MAX_TOC_ENTRIES, "目录注入截断到上限");
    }

    #[test]
    fn oversize_and_binary_files_are_rejected() {
        let root = ws("reject");
        std::fs::write(format!("{root}/Big.txt"), "a".repeat(MAX_INDEX_BYTES as usize + 1)).unwrap();
        std::fs::write(format!("{root}/Bin.txt"), [0xFFu8, 0xFE, 0x00, 0xD8]).unwrap();
        let mut st = FileIndexStore::new(None);
        let e = st.index(&root, "Big.txt", 10).unwrap_err();
        assert!(e.contains("超过"), "超大文件应拒绝：{e}");
        let e = st.index(&root, "Bin.txt", 10).unwrap_err();
        assert!(e.contains("二进制"), "非 UTF-8 应拒绝：{e}");
    }

    #[test]
    fn top_k_zero_uses_default_two() {
        let root = ws("topk");
        let mut content = String::new();
        for i in 0..4 {
            content.push_str(&format!("## 旋转模块{i}\n旋转自转 rotate {i}\n"));
        }
        std::fs::write(format!("{root}/R.md"), &content).unwrap();
        let mut st = FileIndexStore::new(None);
        st.index(&root, "R.md", 10).expect("索引应成功");
        let hits = st.search(&root, "R.md", "旋转 自转", 0, 11).expect("检索应成功");
        assert_eq!(hits.len(), DEFAULT_TOP_K, "缺省 topK 应取默认值 2：{hits:?}");
    }

    #[test]
    fn lru_evicts_oldest_beyond_capacity() {
        let root = ws("lru");
        for i in 0..=MAX_ENTRIES {
            std::fs::write(format!("{root}/f{i}.txt"), format!("内容 {i}")).unwrap();
        }
        let mut st = FileIndexStore::new(None);
        for i in 0..=MAX_ENTRIES {
            st.index(&root, &format!("f{i}.txt"), 100 + i as u64).expect("索引应成功");
        }
        assert_eq!(st.map().len(), MAX_ENTRIES, "超出应淘汰最旧");
        assert!(!st.map().contains_key(&store::index_key(&root, "f0.txt")), "最早索引应被淘汰");
    }
}
