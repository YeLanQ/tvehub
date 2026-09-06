// ---------------------------------------------------------------------------
// 场景图（后端权威状态）：平铺 id → 节点 + rootId，父子链经 parent_id/child_ids
// 表达。操作语义移植自前端 SceneGraph.ts（remove 捕获子树供 undo 重挂、
// reparent 防环等），前端镜像只读消费变更事件。
// ---------------------------------------------------------------------------

use std::collections::HashMap;

use super::model::{NodeData, TransformData};

/// 单次图变更（会话层据此组装 scene:changed 事件）
pub struct GraphChange {
    pub kind: &'static str,
    pub node_id: String,
    /// 需随事件下发的节点快照（含因 childIds 变化受影响的父节点）
    pub snapshots: Vec<NodeData>,
}

#[derive(Default)]
pub struct Graph {
    pub nodes: HashMap<String, NodeData>,
    pub root_id: Option<String>,
}

impl Graph {
    pub fn get(&self, id: &str) -> Option<&NodeData> {
        self.nodes.get(id)
    }

    pub fn contains(&self, id: &str) -> bool {
        self.nodes.contains_key(id)
    }

    // root/parent_of/all/move_within_parent 为图 API 完整面：与前端 SceneClient
    // 读接口对齐、供命令层扩展与测试使用，暂未被命令调用
    #[allow(dead_code)]
    pub fn root(&self) -> Option<&NodeData> {
        self.root_id.as_ref().and_then(|id| self.nodes.get(id))
    }

    #[allow(dead_code)]
    pub fn parent_of(&self, id: &str) -> Option<&NodeData> {
        let node = self.nodes.get(id)?;
        node.parent_id.as_ref().and_then(|pid| self.nodes.get(pid))
    }

    #[allow(dead_code)]
    pub fn all(&self) -> Vec<&NodeData> {
        self.nodes.values().collect()
    }

    /// 祖先链上是否包含 maybe_ancestor（防环判定用）
    pub fn is_descendant(&self, maybe_ancestor: Option<&str>, id: &str) -> bool {
        let Some(ancestor) = maybe_ancestor else {
            return false;
        };
        let mut cur = self.nodes.get(id).and_then(|n| n.parent_id.clone());
        while let Some(pid) = cur {
            if pid == ancestor {
                return true;
            }
            cur = self.nodes.get(&pid).and_then(|n| n.parent_id.clone());
        }
        false
    }

    fn snapshot_of(&self, id: &str) -> Option<NodeData> {
        self.nodes.get(id).cloned().map(|n| n.flat())
    }

    /// 嵌套文档树 → 平铺图（层级以嵌套 children 为准重建 childIds/parentId，
    /// 文件内的 childIds 字段不作为事实源——与前端 loadScene 的解析规则一致）
    pub fn from_root_doc(root: NodeData) -> (Graph, Vec<NodeData>) {
        let mut graph = Graph::default();
        let mut all = Vec::new();
        graph.index_subtree(root, None, &mut all);
        (graph, all)
    }

    fn index_subtree(&mut self, mut node: NodeData, parent: Option<&str>, all: &mut Vec<NodeData>) {
        let children = std::mem::take(&mut node.children);
        node.parent_id = parent.map(str::to_string);
        node.child_ids = children.iter().map(|c| c.id.clone()).collect();
        let id = node.id.clone();
        self.nodes.insert(id.clone(), node);
        if parent.is_none() {
            self.root_id = Some(id.clone());
        }
        for child in children {
            self.index_subtree(child, Some(&id), all);
        }
        if let Some(n) = self.nodes.get(&id) {
            all.push(n.clone());
        }
    }

    /// 整树替换（场景装载/切换），返回 replace 变更（快照 = 全部节点）
    pub fn replace_root(&mut self, root: NodeData) -> GraphChange {
        let (graph, all) = Graph::from_root_doc(root);
        *self = graph;
        GraphChange {
            kind: "replace",
            node_id: self.root_id.clone().unwrap_or_default(),
            snapshots: all,
        }
    }

    /// 加入节点（node.parent_id 须已指向存在的父节点，或为 None 成为根）
    pub fn add_node(&mut self, node: NodeData) -> Option<GraphChange> {
        if node.id.is_empty() || self.nodes.contains_key(&node.id) {
            return None;
        }
        let id = node.id.clone();
        let parent_id = node.parent_id.clone();
        let node = node.flat();
        self.nodes.insert(id.clone(), node);
        let mut snapshots = vec![];
        if let Some(pid) = &parent_id {
            if let Some(parent) = self.nodes.get_mut(pid) {
                if !parent.child_ids.contains(&id) {
                    parent.child_ids.push(id.clone());
                }
            }
            snapshots.extend(self.snapshot_of(pid));
        } else if self.root_id.is_none() {
            self.root_id = Some(id.clone());
        }
        snapshots.extend(self.snapshot_of(&id));
        Some(GraphChange {
            kind: "add",
            node_id: id,
            snapshots,
        })
    }

    /// 收集子树（DFS，文档序）
    fn collect_subtree(&self, root_id: &str) -> Vec<NodeData> {
        let mut out = Vec::new();
        let mut stack = vec![root_id.to_string()];
        while let Some(id) = stack.pop() {
            let Some(node) = self.nodes.get(&id) else { continue };
            out.push(node.clone());
            // 逆序压栈保持文档序遍历
            for cid in node.child_ids.iter().rev() {
                stack.push(cid.clone());
            }
        }
        out
    }

    /// 摘除子树（返回平铺捕获，供 undo 重挂）；快照携带父节点（childIds 已变）
    pub fn remove_subtree(&mut self, id: &str) -> Option<(Vec<NodeData>, GraphChange)> {
        let node = self.nodes.get(id)?.clone();
        let parent_id = node.parent_id.clone();
        let subtree = self.collect_subtree(id);
        for n in &subtree {
            self.nodes.remove(&n.id);
        }
        let mut snapshots = Vec::new();
        if let Some(pid) = &parent_id {
            if let Some(parent) = self.nodes.get_mut(pid) {
                parent.child_ids.retain(|c| c != id);
            }
            snapshots.extend(self.snapshot_of(pid));
        } else if self.root_id.as_deref() == Some(id) {
            self.root_id = None;
        }
        Some((
            subtree,
            GraphChange {
                kind: "remove",
                node_id: id.to_string(),
                snapshots,
            },
        ))
    }

    /// 重挂子树（undo 使用）：平铺捕获的第一个元素为子树根
    pub fn reattach(&mut self, captured: &[NodeData]) -> Option<GraphChange> {
        let root = captured.first()?.clone();
        for n in captured {
            self.nodes.insert(n.id.clone(), n.clone());
        }
        let id = root.id.clone();
        let parent_id = root.parent_id.clone();
        let mut snapshots = Vec::new();
        if let Some(pid) = &parent_id {
            if let Some(parent) = self.nodes.get_mut(pid) {
                if !parent.child_ids.contains(&id) {
                    parent.child_ids.push(id.clone());
                }
            }
            snapshots.extend(self.snapshot_of(pid));
        } else {
            self.root_id = Some(id.clone());
        }
        snapshots.extend(self.snapshot_of(&id));
        Some(GraphChange {
            kind: "add",
            node_id: id,
            snapshots,
        })
    }

    /// 重挂父节点（防环：新父是自身或其子孙时拒绝；祖先是合法目标）
    pub fn reparent(
        &mut self,
        id: &str,
        new_parent_id: Option<&str>,
        index: i64,
    ) -> Option<GraphChange> {
        let node = self.nodes.get(id)?.clone();
        if new_parent_id.is_some()
            && (new_parent_id == Some(id) || self.is_descendant(Some(id), new_parent_id.unwrap()))
        {
            return None;
        }
        let old_parent_id = node.parent_id.clone();
        if let Some(pid) = &old_parent_id {
            if let Some(parent) = self.nodes.get_mut(pid) {
                parent.child_ids.retain(|c| c != id);
            }
        }
        if let Some(n) = self.nodes.get_mut(id) {
            n.parent_id = new_parent_id.map(str::to_string);
        }
        if new_parent_id.is_none() {
            self.root_id = Some(id.to_string());
        } else {
            let parent = self.nodes.get_mut(new_parent_id.unwrap())?;
            let idx = if index < 0 {
                parent.child_ids.len()
            } else {
                (index as usize).min(parent.child_ids.len())
            };
            parent.child_ids.insert(idx, id.to_string());
        }
        let mut snapshots = Vec::new();
        if let Some(pid) = &old_parent_id {
            snapshots.extend(self.snapshot_of(pid));
        }
        if let Some(pid) = new_parent_id {
            snapshots.extend(self.snapshot_of(pid));
        }
        snapshots.extend(self.snapshot_of(id));
        Some(GraphChange {
            kind: "reparent",
            node_id: id.to_string(),
            snapshots,
        })
    }

    /// 同父内调整顺序
    #[allow(dead_code)]
    pub fn move_within_parent(&mut self, id: &str, new_index: i64) -> Option<GraphChange> {
        let node = self.nodes.get(id)?.clone();
        let pid = node.parent_id.clone()?;
        let parent = self.nodes.get_mut(&pid)?;
        parent.child_ids.retain(|c| c != id);
        let idx = if new_index < 0 {
            parent.child_ids.len()
        } else {
            (new_index as usize).min(parent.child_ids.len())
        };
        parent.child_ids.insert(idx, id.to_string());
        let mut snapshots = vec![];
        snapshots.extend(self.snapshot_of(&pid));
        Some(GraphChange {
            kind: "reparent",
            node_id: id.to_string(),
            snapshots,
        })
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Option<GraphChange> {
        let node = self.nodes.get_mut(id)?;
        node.name = name.to_string();
        Some(GraphChange {
            kind: "rename",
            node_id: id.to_string(),
            snapshots: vec![node.clone().flat()],
        })
    }

    pub fn set_transform(&mut self, id: &str, t: &TransformData) -> Option<GraphChange> {
        let node = self.nodes.get_mut(id)?;
        node.transform = t.clone();
        Some(GraphChange {
            kind: "transform",
            node_id: id.to_string(),
            snapshots: vec![node.clone().flat()],
        })
    }

    /// 整节点数据替换（属性补丁；after 自带与图一致的父子链）
    pub fn patch_node(&mut self, id: &str, after: NodeData) -> Option<GraphChange> {
        if !self.nodes.contains_key(id) {
            return None;
        }
        let mut after = after.flat();
        after.id = id.to_string();
        self.nodes.insert(id.to_string(), after);
        Some(GraphChange {
            kind: "properties",
            node_id: id.to_string(),
            snapshots: vec![self.nodes.get(id)?.clone().flat()],
        })
    }

    /// 平铺图 → 嵌套文档树（保存/下发给前端用；递归深度 = 场景层级，编辑器规模安全）
    pub fn to_root_doc(&self) -> Option<NodeData> {
        let root_id = self.root_id.clone()?;
        self.build_doc(&root_id)
    }

    fn build_doc(&self, id: &str) -> Option<NodeData> {
        let node = self.nodes.get(id)?;
        let mut doc = node.clone().flat();
        doc.children = node
            .child_ids
            .iter()
            .filter_map(|cid| self.build_doc(cid))
            .collect();
        Some(doc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mesh(id: &str, parent: Option<&str>) -> NodeData {
        serde_json::from_value(json!({
            "type": "meshNode", "id": id, "name": id,
            "parentId": parent, "childIds": [],
            "source": "primitive", "geometry": "box",
            "material": "internal/materials/Default.mat"
        }))
        .unwrap()
    }

    #[test]
    fn add_remove_reattach_roundtrip() {
        let mut g = Graph::default();
        let root = mesh("root", None);
        g.add_node(root).unwrap();
        g.add_node(mesh("a", Some("root"))).unwrap();
        g.add_node(mesh("b", Some("a"))).unwrap();

        let (captured, _) = g.remove_subtree("a").unwrap();
        assert_eq!(captured.len(), 2);
        assert!(!g.contains("a") && !g.contains("b"));
        assert!(g.root().unwrap().child_ids.is_empty());

        g.reattach(&captured).unwrap();
        assert!(g.contains("a") && g.contains("b"));
        assert_eq!(g.root().unwrap().child_ids, vec!["a".to_string()]);
        assert_eq!(
            g.get("a").unwrap().child_ids,
            vec!["b".to_string()]
        );
    }

    #[test]
    fn reparent_rejects_cycle() {
        let mut g = Graph::default();
        g.add_node(mesh("root", None)).unwrap();
        g.add_node(mesh("a", Some("root"))).unwrap();
        g.add_node(mesh("b", Some("a"))).unwrap();
        // 把 a 挂到自己的子孙 b 下 → 拒绝
        assert!(g.reparent("a", Some("b"), -1).is_none());
        // 挂回根级（祖先方向）→ 允许
        assert!(g.reparent("a", None, -1).is_some());
        assert_eq!(g.root_id.as_deref(), Some("a"));
    }

    #[test]
    fn doc_roundtrip_keeps_hierarchy_and_own_fields() {
        let doc: NodeData = serde_json::from_value(json!({
            "type": "node", "id": "root", "name": "Root", "parentId": null,
            "childIds": ["stale"],
            "transform": { "type": "transform", "position": {"x": 0, "y": 0.5, "z": 0},
                            "rotation": {"x": 0, "y": 90, "z": 0},
                            "scale": {"x": 1, "y": 1, "z": 1} },
            "properties": {},
            "children": [
                { "type": "meshNode", "id": "m1", "name": "M", "parentId": "root",
                  "source": "model", "model": "assets/models/x.glb" }
            ]
        }))
        .unwrap();
        let (g, all) = Graph::from_root_doc(doc);
        assert_eq!(all.len(), 2);
        // childIds 以嵌套 children 重建（文件里的 "stale" 被忽略）
        assert_eq!(g.root().unwrap().child_ids, vec!["m1".to_string()]);

        let out = g.to_root_doc().unwrap();
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v["childIds"], json!(["m1"]));
        assert_eq!(v["children"][0]["model"], json!("assets/models/x.glb"));
        assert_eq!(v["children"][0]["parentId"], json!("root"));
        // 整数字段不带小数点
        assert_eq!(v["transform"]["rotation"]["y"].to_string(), "90");
        assert_eq!(v["transform"]["position"]["y"].to_string(), "0.5");
    }
}
