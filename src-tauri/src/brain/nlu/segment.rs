// ---------------------------------------------------------------------------
// 语义分段：把一句任务文本拆成有序的语义段（拆解的起点）。纯规则、确定性：
// 先按标点/换行粗切，再按中文连接词与序号细切。段是"单元任务"的雏形，
// 后续经神经图检索与命令预测升级成单元。
// ---------------------------------------------------------------------------

/// 显式分隔符：换行 / 句号 / 分号 / 问号 / 顿号串
const HARD_SEPS: &[char] = &['\n', '\r', '。', '；', ';', '？', '?', '！', '!'];

/// 连接词（按长度降序匹配，避免"之后"被"后"截胡之类）。
/// 单字"再/并"在任务描述里几乎总是连接语义，误切的代价有界（段只是预测建议）。
const CONJ: &[&str] = &[
    "然后", "接着", "随后", "之后", "最后", "并且", "再", "并", "以及",
];

/// 上限：超过取前 N 段——拆解是预测辅助，碎片化反而稀释注意力
pub const MAX_SEGMENTS: usize = 8;

/// 任务文本 → 语义段（去空、去相邻重复、封顶 MAX_SEGMENTS）
pub fn segment_text(task: &str) -> Vec<String> {
    let mut segs: Vec<String> = Vec::new();
    for chunk in split_hard(task) {
        for piece in split_conj(&chunk) {
            push_seg(&mut segs, piece);
        }
    }
    segs.truncate(MAX_SEGMENTS);
    segs
}

fn split_hard(task: &str) -> Vec<String> {
    task.split(|c: char| HARD_SEPS.contains(&c))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 连接词切分："建项目然后打开它" → ["建项目", "打开它"]。
/// 先做序号剥离（"1. xxx" → "xxx"），命中即整段返回（序号本身就是分界）。
fn split_conj(chunk: &str) -> Vec<String> {
    let s = strip_index(chunk);
    let mut parts: Vec<String> = vec![String::new()];
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    'scan: while i < chars.len() {
        for word in CONJ {
            let wc: Vec<char> = word.chars().collect();
            if chars[i..].starts_with(&wc[..]) {
                parts.push(String::new());
                i += wc.len();
                continue 'scan;
            }
        }
        parts.last_mut().expect("parts 非空").push(chars[i]);
        i += 1;
    }
    parts
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

/// 剥离行首序号："1. " "2、" "3) " "第1步 " → 剩余内容；无序号原样返回
fn strip_index(s: &str) -> String {
    let t = s.trim_start();
    let bytes = t.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i > 0 && i < t.len() {
        let rest = &t[i..];
        for sep in ['.', '、', ')', '）', ':', '：', ' '] {
            if let Some(after) = rest.strip_prefix(sep) {
                return after.trim_start().to_string();
            }
        }
    }
    if let Some(rest) = t.strip_prefix("第") {
        let mut j = 0;
        let rs: Vec<char> = rest.chars().collect();
        while j < rs.len() && (rs[j].is_ascii_digit() || rs[j] == '一' || rs[j] == '二' || rs[j] == '三') {
            j += 1;
        }
        if j > 0 && j < rs.len() && (rs[j] == '步' || rs[j] == '、') {
            let after = rs[j..]
                .iter()
                .collect::<String>()
                .trim_start_matches(['步', '、', '：', ':', ' '])
                .to_string();
            if !after.is_empty() {
                return after;
            }
        }
    }
    t.to_string()
}

fn push_seg(segs: &mut Vec<String>, seg: String) {
    let s = seg.trim().to_string();
    if s.is_empty() {
        return;
    }
    if segs.last().map(|last| last == &s).unwrap_or(false) {
        return;
    }
    segs.push(s);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_conjunctions_and_punct() {
        let segs = segment_text("创建一个项目。然后打开它；再添加一个立方体");
        assert_eq!(segs, vec!["创建一个项目", "打开它", "添加一个立方体"]);
    }

    #[test]
    fn splits_on_index_prefix() {
        let segs = segment_text("1. 新建项目\n2、写一个旋转脚本\n3) 保存场景");
        assert_eq!(segs, vec!["新建项目", "写一个旋转脚本", "保存场景"]);
    }

    #[test]
    fn chinese_step_prefix() {
        let segs = segment_text("第一步 打开项目 然后第二步添加灯光");
        // 只有行首的「第N步」被剥离；段内再出现的「第二步」不切（连接词仍切）
        assert_eq!(segs, vec!["打开项目", "第二步添加灯光"]);
    }

    #[test]
    fn caps_and_dedups() {
        let long = (0..20).map(|i| format!("第{}步做一点事然后", i + 1)).collect::<String>();
        let segs = segment_text(&long);
        assert_eq!(segs.len(), MAX_SEGMENTS);
        assert_eq!(segment_text("做A然后做A"), vec!["做A"], "相邻重复段去重");
        assert_eq!(
            segment_text("做A然后做B然后做A"),
            vec!["做A", "做B", "做A"],
            "非相邻重复保留"
        );
    }

    #[test]
    fn empty_and_single() {
        assert!(segment_text("   ").is_empty());
        assert_eq!(segment_text("建个项目"), vec!["建个项目"]);
    }
}
