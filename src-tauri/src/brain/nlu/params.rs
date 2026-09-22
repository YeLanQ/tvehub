// ---------------------------------------------------------------------------
// 准确性原子任务的参数构造：方法 → 从语义段确定性提取参数。提取成功 = 准确
// （大脑直执行）；提取失败 = 模糊（助手细化）。写操作直执行走决策中心门控时，
// 用户明确指令即授权（needConfirm 仅弹一次，批准覆盖同任务）。
// 支持链式依赖："$prev" / "$prev.<key>" 占位引用上一个直执行单元的结果，
// 由执行方（前端）解析——创建项目 → 打开项目 → 加节点 的编排基础。
// ---------------------------------------------------------------------------

use serde_json::{json, Value};

/// 实体词 → node.add 的 kind/subtype（中文建造语汇 → 场景图命令参数）
const ENTITIES: &[(&str, &str, Option<&str>)] = &[
    ("天空盒", "skybox", None),
    ("天空", "skybox", None),
    ("平面", "mesh", Some("plane")),
    ("地面", "mesh", Some("plane")),
    ("地板", "mesh", Some("plane")),
    ("立方体", "mesh", Some("box")),
    ("方块", "mesh", Some("box")),
    ("球体", "mesh", Some("sphere")),
    ("小球", "mesh", Some("sphere")),
    ("方向光", "light", Some("directional")),
    ("平行光", "light", Some("directional")),
    ("环境光", "light", Some("ambient")),
    ("点光源", "light", Some("point")),
    ("点光", "light", Some("point")),
    ("聚光灯", "light", Some("spot")),
    ("相机", "camera", None),
    ("粒子", "particle", None),
    ("地形", "terrain", None),
    ("雾", "fog", None),
    ("音频", "audio", None),
];

/// 段内命中的实体列表（保持出现顺序；同段多个实体 → 多个直执行单元）
pub fn match_entities(seg: &str) -> Vec<(&'static str, Option<&'static str>)> {
    let mut out = Vec::new();
    for (word, kind, subtype) in ENTITIES {
        if seg.contains(word) && !out.iter().any(|(k, s)| *k == *kind && *s == *subtype) {
            out.push((*kind, *subtype));
        }
    }
    out
}

/// 项目/实体名提取：「xxx」 “xxx” "xxx" 引号优先，再 "名为：xxx" "叫xxx" 句式
pub fn extract_name(seg: &str) -> Option<String> {
    for (open, close) in [("「", "」"), ("“", "”"), ("\"", "\""), ("'", "'")] {
        if let Some(i) = seg.find(open) {
            if let Some(j) = seg[i + open.len()..].find(close) {
                let n = seg[i + open.len()..i + open.len() + j].trim();
                if !n.is_empty() {
                    return Some(n.to_string());
                }
            }
        }
    }
    for kw in ["项目名为", "项目名", "名字为", "名为", "名字叫", "叫"] {
        if let Some(i) = seg.find(kw) {
            let rest = seg[i + kw.len()..].trim_start_matches([':', '：', ' ']);
            let end = rest.find(['，', '。', '；', '！', '？', '，']).unwrap_or(rest.len());
            let n = rest[..end].trim().trim_end_matches(['的', '了']).trim();
            if !n.is_empty() {
                return Some(n.to_string());
            }
        }
    }
    None
}

/// 文件路径提取：@前缀 / 引号内 / 带扩展名的 token
pub fn extract_path(seg: &str) -> Option<String> {
    for raw in seg.split(|c: char| {
        c.is_whitespace() || matches!(c, '"' | '\'' | '“' | '”' | '「' | '」' | '，' | '。' | '、' | '，')
    }) {
        let token = raw.strip_prefix('@').unwrap_or(raw);
        if token.is_empty() || !token.contains('.') {
            continue;
        }
        let ext = token.rsplit('.').next().unwrap_or("");
        if !ext.is_empty()
            && ext.len() <= 5
            && ext.chars().all(|c| c.is_ascii_alphanumeric())
            && token.len() > ext.len() + 1
        {
            return Some(token.to_string());
        }
    }
    None
}

/// 目录/绝对路径提取（project.open 用）：含盘符冒号或路径分隔的 token。
/// 与 extract_path（扩展名启发）互补——"D:/work/demo" 无扩展名。
pub fn extract_dir_path(seg: &str) -> Option<String> {
    for raw in seg.split(|c: char| {
        c.is_whitespace() || matches!(c, '"' | '\'' | '“' | '”' | '「' | '」' | '，' | '。' | '、')
    }) {
        let token = raw.trim_end_matches(['.', '，', '。']);
        let has_sep = token.contains(':') || token.contains('/') || token.contains('\\');
        if has_sep && token.chars().any(|c| c.is_ascii_alphanumeric()) {
            return Some(token.to_string());
        }
    }
    None
}

/// project.open 的路径：段内有路径用之；没有则引用上一个直执行结果
/// （"创建项目…然后打开"——unit_index > 1 才有前序可引用）
pub fn open_params(seg: &str, unit_index: usize) -> Option<Value> {
    if let Some(p) = extract_dir_path(seg).or_else(|| extract_path(seg)) {
        return Some(json!({ "path": p }));
    }
    (unit_index > 1).then(|| json!({ "path": "$prev.path" }))
}

/// node.add 参数：单实体段（多实体由 decompose 展开为多单元）
pub fn node_params(kind: &str, subtype: Option<&str>) -> Value {
    json!({ "kind": kind, "subtype": subtype })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_names_from_common_phrases() {
        assert_eq!(
            extract_name("在当前项目下，项目名为：Demo 3D").as_deref(),
            Some("Demo 3D")
        );
        assert_eq!(extract_name("创建一个项目「测试」").as_deref(), Some("测试"));
        assert_eq!(extract_name("建个项目叫ABC"), Some("ABC".to_string()));
        assert!(extract_name("创建一个项目").is_none(), "无名字信号不硬提");
    }

    #[test]
    fn matches_entities_in_order() {
        let ents = match_entities("添加一个方向光，一个环境光");
        assert_eq!(ents, vec![("light", Some("directional")), ("light", Some("ambient"))]);
        assert!(match_entities("写一个脚本").is_empty(), "无实体不误配");
    }

    #[test]
    fn open_falls_back_to_prev_reference() {
        assert_eq!(
            open_params("打开项目", 3).unwrap()["path"],
            "$prev.path"
        );
        assert_eq!(
            open_params("打开项目 D:/work/demo", 9).unwrap()["path"],
            "D:/work/demo"
        );
        assert!(open_params("打开项目", 1).is_none(), "首单元无前序不给占位");
    }
}

#[cfg(test)]
mod diag {
    use super::*;
    #[test]
    fn diag_extract() {
        println!("p1={:?}", extract_path("读取 src/TweenMotion.ts"));
        println!("p2={:?}", extract_dir_diag("打开项目 D:/work/demo"));
    }
    fn extract_dir_diag(seg: &str) -> Option<String> {
        for raw in seg.split(' ') {
            println!("tok={raw} has_dot={} has_slash={}", raw.contains('.'), raw.contains('/'));
        }
        None
    }
}
