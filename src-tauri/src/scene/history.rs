// ---------------------------------------------------------------------------
// 撤销/重做（后端权威）：命令枚举 + 双栈。语义移植自前端 command/commands.ts
// 与 history/CommandStack.ts——Remove 批量捕获子树、undo 逆序重挂、
// Reparent 首次执行记录旧位、Transform/属性补丁按 before/after 快照。
// ---------------------------------------------------------------------------

use super::graph::{Graph, GraphChange};
use super::model::{NodeData, TransformData};

/// 批量重挂目标（多选拖拽一次撤销）
#[derive(Clone, Debug)]
pub struct MoveTarget {
    pub id: String,
    pub new_parent_id: Option<String>,
    pub new_index: i64,
}

/// 一次可撤销的场景命令（label 供历史面板展示）
#[derive(Clone, Debug)]
pub struct SceneCmd {
    pub label: String,
    pub kind: CmdKind,
}

#[derive(Clone, Debug)]
pub enum CmdKind {
    /// 新增节点（node.parent_id 已指向目标父节点）
    Add { node: NodeData },
    /// 批量删除（首次执行捕获子树；redo 重新摘除）
    RemoveNodes {
        ids: Vec<String>,
        captured: Vec<Vec<NodeData>>,
        done: bool,
    },
    /// 批量重挂（首次执行记录旧位置）
    ReparentNodes {
        moves: Vec<MoveTarget>,
        olds: Vec<(String, Option<String>, i64)>,
        done: bool,
    },
    Rename {
        id: String,
        old_name: String,
        new_name: String,
    },
    SetTransform {
        id: String,
        before: TransformData,
        after: TransformData,
    },
    /// 整节点属性补丁（before/after 为完整节点快照）
    PatchNode {
        id: String,
        before: NodeData,
        after: NodeData,
    },
}

impl SceneCmd {
    /// 执行（redo）并返回图变更序列
    pub fn execute(&mut self, graph: &mut Graph) -> Vec<GraphChange> {
        match &mut self.kind {
            CmdKind::Add { node } => graph
                .add_node(node.clone())
                .map(|c| vec![c])
                .unwrap_or_default(),
            CmdKind::RemoveNodes { ids, captured, done } => {
                let mut changes = Vec::new();
                if !*done {
                    for id in ids.clone() {
                        // 跳过根节点与不存在的节点（多选兜底，与 TS 行为一致）
                        if graph.root_id.as_deref() == Some(id.as_str()) {
                            continue;
                        }
                        if let Some((sub, change)) = graph.remove_subtree(&id) {
                            captured.push(sub);
                            changes.push(change);
                        }
                    }
                    *done = true;
                } else {
                    for cap in captured.clone() {
                        if let Some(id) = cap.first().map(|n| n.id.clone()) {
                            if let Some((_, change)) = graph.remove_subtree(&id) {
                                changes.push(change);
                            }
                        }
                    }
                }
                changes
            }
            CmdKind::ReparentNodes { moves, olds, done } => {
                let mut changes = Vec::new();
                if !*done {
                    for m in moves.clone() {
                        let Some(node) = graph.get(&m.id).cloned() else {
                            continue;
                        };
                        let old_index = node
                            .parent_id
                            .as_ref()
                            .and_then(|pid| graph.get(pid))
                            .map(|p| p.child_ids.iter().position(|c| c == &m.id))
                            .flatten()
                            .map(|i| i as i64)
                            .unwrap_or(0);
                        olds.push((m.id.clone(), node.parent_id.clone(), old_index));
                        if let Some(c) =
                            graph.reparent(&m.id, m.new_parent_id.as_deref(), m.new_index)
                        {
                            changes.push(c);
                        }
                    }
                    *done = true;
                } else {
                    for m in moves.clone() {
                        if let Some(c) =
                            graph.reparent(&m.id, m.new_parent_id.as_deref(), m.new_index)
                        {
                            changes.push(c);
                        }
                    }
                }
                changes
            }
            CmdKind::Rename { id, new_name, .. } => graph
                .rename(id, new_name)
                .map(|c| vec![c])
                .unwrap_or_default(),
            CmdKind::SetTransform { id, after, .. } => graph
                .set_transform(id, after)
                .map(|c| vec![c])
                .unwrap_or_default(),
            CmdKind::PatchNode { id, after, .. } => graph
                .patch_node(id, after.clone())
                .map(|c| vec![c])
                .unwrap_or_default(),
        }
    }

    /// 撤销并返回图变更序列
    pub fn undo(&mut self, graph: &mut Graph) -> Vec<GraphChange> {
        match &mut self.kind {
            CmdKind::Add { node } => graph
                .remove_subtree(&node.id)
                .map(|(_, c)| vec![c])
                .unwrap_or_default(),
            CmdKind::RemoveNodes { captured, .. } => {
                let mut changes = Vec::new();
                for cap in captured.clone() {
                    if let Some(c) = graph.reattach(&cap) {
                        changes.push(c);
                    }
                }
                changes
            }
            CmdKind::ReparentNodes { olds, .. } => {
                let mut changes = Vec::new();
                for (id, old_parent, old_index) in olds.clone() {
                    if let Some(c) = graph.reparent(&id, old_parent.as_deref(), old_index) {
                        changes.push(c);
                    }
                }
                changes
            }
            CmdKind::Rename { id, old_name, .. } => graph
                .rename(id, old_name)
                .map(|c| vec![c])
                .unwrap_or_default(),
            CmdKind::SetTransform { id, before, .. } => graph
                .set_transform(id, before)
                .map(|c| vec![c])
                .unwrap_or_default(),
            CmdKind::PatchNode { id, before, .. } => graph
                .patch_node(id, before.clone())
                .map(|c| vec![c])
                .unwrap_or_default(),
        }
    }
}

/// 双栈命令历史（execute 压 undo 栈并清空 redo 栈）
#[derive(Default)]
pub struct History {
    undo_stack: Vec<SceneCmd>,
    redo_stack: Vec<SceneCmd>,
}

impl History {
    pub fn push(&mut self, cmd: SceneCmd) {
        self.undo_stack.push(cmd);
        self.redo_stack.clear();
    }

    pub fn undo(&mut self, graph: &mut Graph) -> Option<(String, Vec<GraphChange>)> {
        let mut cmd = self.undo_stack.pop()?;
        let changes = cmd.undo(graph);
        let label = cmd.label.clone();
        self.redo_stack.push(cmd);
        Some((label, changes))
    }

    pub fn redo(&mut self, graph: &mut Graph) -> Option<(String, Vec<GraphChange>)> {
        let mut cmd = self.redo_stack.pop()?;
        let changes = cmd.execute(graph);
        let label = cmd.label.clone();
        self.undo_stack.push(cmd);
        Some((label, changes))
    }

    pub fn clear(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    pub fn depth(&self) -> usize {
        self.undo_stack.len()
    }

    pub fn undo_label(&self) -> Option<&str> {
        self.undo_stack.last().map(|c| c.label.as_str())
    }

    pub fn redo_label(&self) -> Option<&str> {
        self.redo_stack.last().map(|c| c.label.as_str())
    }

    pub fn labels(&self) -> Vec<String> {
        self.undo_stack.iter().map(|c| c.label.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mesh_cmd(id: &str, parent: Option<&str>) -> SceneCmd {
        let node: NodeData = serde_json::from_value(json!({
            "type": "meshNode", "id": id, "name": id, "parentId": parent,
            "source": "primitive", "geometry": "box"
        }))
        .unwrap();
        SceneCmd {
            label: format!("Add {id}"),
            kind: CmdKind::Add { node },
        }
    }

    #[test]
    fn add_undo_redo() {
        let mut g = Graph::default();
        let mut h = History::default();

        h.push(mesh_cmd("root", None));
        h.undo_stack.last_mut().unwrap().execute(&mut g);
        h.push(mesh_cmd("a", Some("root")));
        h.undo_stack.last_mut().unwrap().execute(&mut g);
        assert!(g.contains("a"));

        h.undo(&mut g).unwrap();
        assert!(!g.contains("a") && g.contains("root"));

        h.redo(&mut g).unwrap();
        assert!(g.contains("a"));
        assert_eq!(g.get("a").unwrap().parent_id.as_deref(), Some("root"));
    }

    #[test]
    fn remove_batch_undo_restores_in_reverse() {
        let mut g = Graph::default();
        let mut h = History::default();
        for (id, parent) in [("root", None), ("a", Some("root")), ("b", Some("root"))] {
            h.push(mesh_cmd(id, parent));
            h.undo_stack.last_mut().unwrap().execute(&mut g);
        }

        let mut cmd = SceneCmd {
            label: "Remove".into(),
            kind: CmdKind::RemoveNodes {
                ids: vec!["a".into(), "b".into()],
                captured: vec![],
                done: false,
            },
        };
        cmd.execute(&mut g);
        assert!(!g.contains("a") && !g.contains("b"));
        h.push(cmd);

        h.undo(&mut g).unwrap();
        assert!(g.contains("a") && g.contains("b"));
        h.redo(&mut g).unwrap();
        assert!(!g.contains("a") && !g.contains("b"));
    }

    #[test]
    fn transform_undo_restores_before() {
        let mut g = Graph::default();
        let mut h = History::default();
        h.push(mesh_cmd("n", None));
        h.undo_stack.last_mut().unwrap().execute(&mut g);

        let before = g.get("n").unwrap().transform.clone();
        let after = TransformData {
            position: super::super::model::Vec3Data {
                x: 5.0,
                y: 0.0,
                z: 0.0,
            },
            ..before.clone()
        };
        h.push(SceneCmd {
            label: "Set Transform".into(),
            kind: CmdKind::SetTransform {
                id: "n".into(),
                before: before.clone(),
                after: after.clone(),
            },
        });
        h.undo_stack.last_mut().unwrap().execute(&mut g);
        assert_eq!(g.get("n").unwrap().transform.position.x, 5.0);

        h.undo(&mut g).unwrap();
        assert_eq!(g.get("n").unwrap().transform.position.x, before.position.x);
    }
}
