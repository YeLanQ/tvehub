// ---------------------------------------------------------------------------
// 命令预测：语义段 → 最可能的 devtools 方法 + 任务阶段。预测是"建议"不是
// "指令"——前端把它作为单元的入口提示转给助手，助手按工具实际回执自纠。
// 优先级：神经图命中的命令节点（图说是） > 关键词词典（词频说是）。
// ---------------------------------------------------------------------------

use crate::brain::graph::route::RouteHit;
use crate::brain::model::NodeKind;

/// 任务阶段：调研（只读看状态）→ 执行（变更操作）→ 验证（预览/截图确认）
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Inspect,
    Act,
    Verify,
}

/// 关键词 → 方法（命中词越长权重越高；按加权分选方法）
const LEXICON: &[(&str, &str)] = &[
    ("新建项目", "project.create"),
    ("创建项目", "project.create"),
    ("新项目", "project.create"),
    ("建项目", "project.create"),
    ("建一个项目", "project.create"),
    ("新建", "project.create"),
    ("创建", "project.create"),
    ("打开项目", "project.open"),
    ("载入项目", "project.open"),
    ("打开", "project.open"),
    ("关闭项目", "project.close"),
    ("列出场景", "scene.list"),
    ("场景列表", "scene.list"),
    ("哪些场景", "scene.list"),
    ("打开场景", "scene.open"),
    ("保存场景", "scene.save"),
    ("保存", "scene.save"),
    ("场景树", "scene.tree"),
    ("添加节点", "node.add"),
    ("加一个", "node.add"),
    ("加个", "node.add"),
    ("添加", "node.add"),
    ("立方体", "node.add"),
    ("球体", "node.add"),
    ("灯光", "node.add"),
    ("相机", "node.add"),
    ("粒子", "node.add"),
    ("地形", "node.add"),
    ("删除节点", "node.remove"),
    ("移除", "node.remove"),
    ("删除", "asset.delete"),
    ("重命名", "node.rename"),
    ("改名", "node.rename"),
    ("选中", "node.select"),
    ("编辑器状态", "editor.state"),
    ("列出资产", "asset.list"),
    ("资产列表", "asset.list"),
    ("哪些资产", "asset.list"),
    ("读取文件", "asset.read"),
    ("文件内容", "asset.read"),
    ("读取", "asset.read"),
    ("写文件", "asset.write"),
    ("写入", "asset.write"),
    ("写脚本", "asset.write"),
    ("生成脚本", "asset.write"),
    ("预览", "preview.open"),
    ("运行效果", "preview.open"),
    ("试玩", "preview.open"),
    ("截图", "preview.screenshot"),
    ("启动预览服务", "preview.start"),
];

/// 调研语（出现即判 Inspect，优先于验证语）
const INSPECT_WORDS: &[&str] = &[
    "列出", "查看", "读取", "看看", "检查", "状态", "哪些", "什么", "多少", "有哪些",
];
/// 验证语
const VERIFY_WORDS: &[&str] = &["预览", "截图", "验证", "确认效果", "试玩", "测试运行"];

/// 预测一个段的方法：图命中命令节点取最高分；否则词典加权（命中词长平方累加）。
/// 返回 (方法, 来源："graph" | "lexicon")
pub fn predict_method(seg: &str, hits: &[RouteHit]) -> Option<(String, &'static str)> {
    if let Some(hit) = hits.iter().find(|h| h.kind == NodeKind::Command) {
        if let Some(method) = hit.id.strip_prefix("cmd:") {
            return Some((method.to_string(), "graph"));
        }
    }
    lexicon_predict(seg)
}

fn lexicon_predict(seg: &str) -> Option<(String, &'static str)> {
    let mut best: Option<(f32, &str)> = None;
    for (word, method) in LEXICON {
        if seg.contains(word) {
            let w = word.chars().count() as f32;
            let score = w * w;
            if best.as_ref().map_or(true, |(b, _)| score > *b) {
                best = Some((score, method));
            }
        }
    }
    best.map(|(_, m)| (m.to_string(), "lexicon"))
}

/// 阶段推断：调研语 > 验证语 > 执行（默认）
pub fn phase_of(seg: &str) -> Phase {
    if INSPECT_WORDS.iter().any(|w| seg.contains(w)) {
        return Phase::Inspect;
    }
    if VERIFY_WORDS.iter().any(|w| seg.contains(w)) {
        return Phase::Verify;
    }
    Phase::Act
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain::model::NodeKind;

    fn hit(id: &str, kind: NodeKind, score: f32) -> RouteHit {
        RouteHit { id: id.to_string(), kind, label: id.to_string(), score }
    }

    #[test]
    fn graph_command_beats_lexicon() {
        let hits = [hit("cmd:scene.save", NodeKind::Command, 0.9)];
        let (m, src) = predict_method("保存场景", &hits).expect("应有预测");
        assert_eq!(m, "scene.save");
        assert_eq!(src, "graph");
    }

    #[test]
    fn non_command_hits_fall_through() {
        let hits = [hit("skill:script", NodeKind::Skill, 0.9)];
        let (m, src) = predict_method("写一个旋转脚本然后保存", &hits).expect("词典兜底");
        assert_eq!(src, "lexicon");
        assert!(m == "asset.write" || m == "scene.save", "实际得到 {m}");
    }

    #[test]
    fn lexicon_weights_longer_word() {
        let (m, _) = predict_method("创建一个项目", &[]).expect("应有预测");
        assert_eq!(m, "project.create");
    }

    #[test]
    fn no_prediction_for_chit_chat() {
        assert!(predict_method("你好呀", &[]).is_none());
    }

    #[test]
    fn phases() {
        assert_eq!(phase_of("列出项目资产"), Phase::Inspect);
        assert_eq!(phase_of("预览一下效果"), Phase::Verify);
        assert_eq!(phase_of("添加一个立方体"), Phase::Act);
    }
}
