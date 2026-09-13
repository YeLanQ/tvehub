// ---------------------------------------------------------------------------
// 场景会话（后端权威状态）：场景图 + 撤销历史 + 文档信封（root 以外的顶层
// 字段，metadata/settings 等保存时原样保留）。所有变更经命令进入，变更后以
// "scene:changed" 事件广播（kind/nodeId/节点快照/历史状态/revision），前端
// 镜像按事件同步 three.js 世界；前端写路径先乐观应用、再经命令提交，事件
// 回执幂等确认。
// ---------------------------------------------------------------------------

pub mod graph;
pub mod history;
pub mod material;
pub mod migrate;
pub mod model;
pub mod shader;
pub mod texcube;

use std::path::PathBuf;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Emitter;

use graph::{Graph, GraphChange};
use history::{CmdKind, History, MoveTarget, SceneCmd};
use model::{JsonMap, NodeData, TransformData};

/// 场景变更事件（对齐前端 SceneChange 语义：add/remove/reparent/rename/
/// transform/properties/replace/clear）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SceneChangedEvent {
    pub kind: String,
    pub node_id: String,
    pub revision: u64,
    /// 变更涉及的节点快照（含父节点 childIds 变化；remove 时为受影响父节点）
    pub nodes: Vec<NodeData>,
    pub history: HistoryState,
    pub dirty: bool,
}

/// 历史状态快照（UI 撤销按钮/历史面板用）
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryState {
    pub can_undo: bool,
    pub can_redo: bool,
    pub depth: usize,
    pub undo_label: Option<String>,
    pub redo_label: Option<String>,
    pub labels: Vec<String>,
}

/// scene_open / scene_load_doc 的装载结果
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneLoadResult {
    /// 规范化后的完整场景文档（信封 + 图重建的 root；空场景无 root 字段）
    pub doc: Value,
    pub material_refs: Vec<String>,
    pub model_refs: Vec<String>,
    pub revision: u64,
    pub history: HistoryState,
}

/// 批量重挂目标（前端多选拖拽）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveTargetDto {
    pub id: String,
    pub new_parent_id: Option<String>,
    #[serde(default = "append_index")]
    pub new_index: i64,
}

fn append_index() -> i64 {
    -1
}

struct SessionCore {
    graph: Graph,
    history: History,
    /// 场景文档除 root 外的顶层字段（type/metadata/settings…）
    envelope: JsonMap,
    root_path: Option<PathBuf>,
    scene_rel: String,
    revision: u64,
    dirty: bool,
}

impl Default for SessionCore {
    fn default() -> Self {
        Self {
            graph: Graph::default(),
            history: History::default(),
            envelope: JsonMap::new(),
            root_path: None,
            scene_rel: String::new(),
            revision: 0,
            dirty: false,
        }
    }
}

/// 托管状态（Tauri manage）
pub struct SceneSession(RwLock<SessionCore>);

impl Default for SceneSession {
    fn default() -> Self {
        Self(RwLock::new(SessionCore::default()))
    }
}

fn history_state(core: &SessionCore) -> HistoryState {
    HistoryState {
        can_undo: core.history.can_undo(),
        can_redo: core.history.can_redo(),
        depth: core.history.depth(),
        undo_label: core.history.undo_label().map(str::to_string),
        redo_label: core.history.redo_label().map(str::to_string),
        labels: core.history.labels(),
    }
}

fn build_doc(core: &SessionCore) -> Value {
    let mut doc = core.envelope.clone();
    if let Some(root) = core.graph.to_root_doc() {
        doc.insert(
            "root".into(),
            serde_json::to_value(&root).unwrap_or(Value::Null),
        );
    }
    Value::Object(doc)
}

/// 广播一批图变更（同命令共享一次 revision 递增）
fn emit_changes<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    core: &mut SessionCore,
    changes: Vec<GraphChange>,
) {
    core.revision += 1;
    let hist = history_state(core);
    let dirty = core.dirty;
    for change in changes {
        let event = SceneChangedEvent {
            kind: change.kind.to_string(),
            node_id: change.node_id,
            revision: core.revision,
            nodes: change.snapshots,
            history: hist.clone(),
            dirty,
        };
        let _ = app.emit("scene:changed", &event);
    }
}

/// 从文档 JSON 装载会话核心（信封提取 + 图重建 + 历史清零）
fn load_core_from_doc(core: &mut SessionCore, doc: &Value, root_path: Option<PathBuf>, scene_rel: &str) {
    let mut envelope = doc
        .as_object()
        .cloned()
        .unwrap_or_default();
    envelope.remove("root");

    // 旧版空场景的 type="empty" 魔法标记 / 缺失 root → 空图（前端回退初始场景）
    let root_node = doc.get("root").and_then(|r| {
        if r.get("type").and_then(Value::as_str) == Some("empty") {
            return None;
        }
        NodeData::deserialize(r).ok()
    });

    core.graph = Graph::default();
    if let Some(root) = root_node {
        core.graph.replace_root(root);
    }
    core.history.clear();
    core.envelope = envelope;
    core.root_path = root_path;
    core.scene_rel = scene_rel.to_string();
    core.revision += 1;
    core.dirty = false;
}

fn collect_refs(doc: &Value) -> (Vec<String>, Vec<String>) {
    let mut material_refs = Vec::new();
    let mut model_refs = Vec::new();
    migrate::collect_material_refs(doc, &mut material_refs);
    migrate::collect_model_refs(doc, &mut model_refs);
    (material_refs, model_refs)
}

fn load_result(core: &SessionCore, doc: &Value) -> SceneLoadResult {
    let (material_refs, model_refs) = collect_refs(doc);
    SceneLoadResult {
        doc: build_doc(core),
        material_refs,
        model_refs,
        revision: core.revision,
        history: history_state(core),
    }
}

/// 打开项目内 .scene 资产：读盘 → 旧格式迁移 → 图重建（历史清零）。
/// 文件不存在/损坏返回 Err（前端回退初始场景）；root 非法（empty 标记）时
/// 装载空图并按原文档返回（前端判断 doc.root 决定回退）。
#[tauri::command]
pub async fn scene_open(
    state: tauri::State<'_, SceneSession>,
    root: String,
    rel: String,
) -> Result<SceneLoadResult, String> {
    let root_path = PathBuf::from(&root);
    let path = crate::project::resolve_in_root(&root_path, &rel)?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取场景失败 '{rel}': {e}"))?;
    let mut doc: Value = serde_json::from_str(&text)
        .map_err(|e| format!("场景文件解析失败 '{rel}': {e}"))?;

    // 旧版内嵌材质迁移；失败按原文档装载（与前端旧行为一致：警告不阻断）
    let original = doc.clone();
    if let Err(e) = migrate::migrate_legacy_scene(&root_path, &mut doc) {
        eprintln!("[scene] 旧场景材质迁移失败（按原内容加载）: {e}");
        doc = original;
    }

    let mut core = state.0.write().map_err(|e| e.to_string())?;
    load_core_from_doc(&mut core, &doc, Some(root_path), &rel);
    Ok(load_result(&core, &doc))
}

/// 以前端构建的文档整树替换会话（初始场景/回退用；无历史、不落盘）。
/// root/rel 可选：提供时作为保存目标记录（新项目首次保存创建场景文件用）。
#[tauri::command]
pub async fn scene_load_doc(
    state: tauri::State<'_, SceneSession>,
    doc: Value,
    root: Option<String>,
    rel: Option<String>,
) -> Result<SceneLoadResult, String> {
    let mut core = state.0.write().map_err(|e| e.to_string())?;
    let root_path = match root {
        Some(r) => Some(PathBuf::from(r)),
        None => core.root_path.clone(),
    };
    let scene_rel = rel.unwrap_or_else(|| core.scene_rel.clone());
    load_core_from_doc(&mut core, &doc, root_path, &scene_rel);
    Ok(load_result(&core, &doc))
}

/// 新增节点（node.parentId 已指向目标父节点）
#[tauri::command]
pub async fn scene_add_node(
    app: tauri::AppHandle,
    state: tauri::State<'_, SceneSession>,
    node: NodeData,
    label: Option<String>,
) -> Result<(), String> {
    let mut core = state.0.write().map_err(|e| e.to_string())?;
    let mut cmd = SceneCmd {
        label: label.unwrap_or_else(|| format!("Add {}", node.name)),
        kind: CmdKind::Add { node },
    };
    let changes = cmd.execute(&mut core.graph);
    if changes.is_empty() {
        return Err(format!("节点加入失败（id 冲突）: {}", "node"));
    }
    core.history.push(cmd);
    core.dirty = true;
    emit_changes(&app, &mut core, changes);
    Ok(())
}

/// 新增嵌套子树（prefab 实例化；层级以嵌套 children 为准，根挂 parentId 下，
/// 空场景可为 None 成为根；一次撤销）
#[tauri::command]
pub async fn scene_add_tree(
    app: tauri::AppHandle,
    state: tauri::State<'_, SceneSession>,
    root: NodeData,
    parent_id: Option<String>,
    label: Option<String>,
) -> Result<(), String> {
    let mut core = state.0.write().map_err(|e| e.to_string())?;
    // 无父挂载仅允许空场景；有场景根时必须给出目标父节点
    if parent_id.is_none() && core.graph.root_id.is_some() {
        return Err("新增子树缺少目标父节点".into());
    }
    if let Some(pid) = &parent_id {
        if !core.graph.contains(pid) {
            return Err(format!("父节点不存在: {pid}"));
        }
    }
    let mut cmd = SceneCmd {
        label: label.unwrap_or_else(|| format!("Add {}", root.name)),
        kind: CmdKind::AddTree { root, parent_id },
    };
    let changes = cmd.execute(&mut core.graph);
    if changes.is_empty() {
        return Err("子树加入失败（id 冲突或父节点缺失）".into());
    }
    core.history.push(cmd);
    core.dirty = true;
    emit_changes(&app, &mut core, changes);
    Ok(())
}

/// 批量删除节点（一次撤销；根节点自动跳过）
#[tauri::command]
pub async fn scene_remove_nodes(
    app: tauri::AppHandle,
    state: tauri::State<'_, SceneSession>,
    ids: Vec<String>,
    label: Option<String>,
) -> Result<(), String> {
    let mut core = state.0.write().map_err(|e| e.to_string())?;
    let mut cmd = SceneCmd {
        label: label.unwrap_or_else(|| "Remove nodes".into()),
        kind: CmdKind::RemoveNodes {
            ids,
            captured: Vec::new(),
            done: false,
        },
    };
    let changes = cmd.execute(&mut core.graph);
    if changes.is_empty() {
        return Ok(()); // 全部为无效/根节点：无事发生，不入历史
    }
    core.history.push(cmd);
    core.dirty = true;
    emit_changes(&app, &mut core, changes);
    Ok(())
}

/// 批量重挂/移动（多选拖拽一次撤销）
#[tauri::command]
pub async fn scene_reparent_nodes(
    app: tauri::AppHandle,
    state: tauri::State<'_, SceneSession>,
    moves: Vec<MoveTargetDto>,
    label: Option<String>,
) -> Result<(), String> {
    let mut core = state.0.write().map_err(|e| e.to_string())?;
    let moves: Vec<MoveTarget> = moves
        .into_iter()
        .map(|m| MoveTarget {
            id: m.id,
            new_parent_id: m.new_parent_id,
            new_index: m.new_index,
        })
        .collect();
    let mut cmd = SceneCmd {
        label: label.unwrap_or_else(|| "Move nodes".into()),
        kind: CmdKind::ReparentNodes {
            moves,
            olds: Vec::new(),
            done: false,
        },
    };
    let changes = cmd.execute(&mut core.graph);
    if changes.is_empty() {
        return Ok(());
    }
    core.history.push(cmd);
    core.dirty = true;
    emit_changes(&app, &mut core, changes);
    Ok(())
}

/// 重命名节点
#[tauri::command]
pub async fn scene_rename(
    app: tauri::AppHandle,
    state: tauri::State<'_, SceneSession>,
    id: String,
    name: String,
    label: Option<String>,
) -> Result<(), String> {
    let mut core = state.0.write().map_err(|e| e.to_string())?;
    let old_name = core
        .graph
        .get(&id)
        .map(|n| n.name.clone())
        .ok_or_else(|| format!("节点不存在: {id}"))?;
    let mut cmd = SceneCmd {
        label: label.unwrap_or_else(|| "Rename node".into()),
        kind: CmdKind::Rename {
            id,
            old_name,
            new_name: name,
        },
    };
    let changes = cmd.execute(&mut core.graph);
    core.history.push(cmd);
    core.dirty = true;
    emit_changes(&app, &mut core, changes);
    Ok(())
}

/// 提交变换（Gizmo 拖动/检查器输入：一次操作 = 一个命令，before/after 快照）
#[tauri::command]
pub async fn scene_set_transform(
    app: tauri::AppHandle,
    state: tauri::State<'_, SceneSession>,
    id: String,
    before: TransformData,
    after: TransformData,
) -> Result<(), String> {
    let mut core = state.0.write().map_err(|e| e.to_string())?;
    if !core.graph.contains(&id) {
        return Err(format!("节点不存在: {id}"));
    }
    let mut cmd = SceneCmd {
        label: "Set Transform".into(),
        kind: CmdKind::SetTransform { id, before, after },
    };
    let changes = cmd.execute(&mut core.graph);
    core.history.push(cmd);
    core.dirty = true;
    emit_changes(&app, &mut core, changes);
    Ok(())
}

/// 整节点属性补丁（before/after 为完整节点快照；redo/undo 整体回填）
#[tauri::command]
pub async fn scene_patch_node(
    app: tauri::AppHandle,
    state: tauri::State<'_, SceneSession>,
    id: String,
    before: NodeData,
    after: NodeData,
    label: Option<String>,
) -> Result<(), String> {
    let mut core = state.0.write().map_err(|e| e.to_string())?;
    if !core.graph.contains(&id) {
        return Err(format!("节点不存在: {id}"));
    }
    let mut cmd = SceneCmd {
        label: label.unwrap_or_else(|| "Set Property".into()),
        kind: CmdKind::PatchNode { id, before, after },
    };
    let changes = cmd.execute(&mut core.graph);
    core.history.push(cmd);
    core.dirty = true;
    emit_changes(&app, &mut core, changes);
    Ok(())
}

/// 批量整节点属性补丁（多选批量编辑；一次撤销）
#[tauri::command]
pub async fn scene_patch_nodes(
    app: tauri::AppHandle,
    state: tauri::State<'_, SceneSession>,
    items: Vec<PatchItemDto>,
    label: Option<String>,
) -> Result<(), String> {
    let mut core = state.0.write().map_err(|e| e.to_string())?;
    let mut pairs: Vec<(String, NodeData, NodeData)> = Vec::new();
    for item in items {
        if !core.graph.contains(&item.id) {
            continue; // 多选兜底：已删除的节点跳过
        }
        pairs.push((item.id, item.before, item.after));
    }
    if pairs.is_empty() {
        return Ok(());
    }
    let mut cmd = SceneCmd {
        label: label.unwrap_or_else(|| "Set Properties".into()),
        kind: CmdKind::PatchNodes { items: pairs },
    };
    let changes = cmd.execute(&mut core.graph);
    core.history.push(cmd);
    core.dirty = true;
    emit_changes(&app, &mut core, changes);
    Ok(())
}

/// 批量补丁条目（id + before/after 完整节点快照）
#[derive(Deserialize)]
pub struct PatchItemDto {
    pub id: String,
    pub before: NodeData,
    pub after: NodeData,
}

/// 撤销（广播变更事件）
#[tauri::command]
pub async fn scene_undo(
    app: tauri::AppHandle,
    state: tauri::State<'_, SceneSession>,
) -> Result<HistoryState, String> {
    let mut core = state.0.write().map_err(|e| e.to_string())?;
    let outcome = {
        let SessionCore { history, graph, .. } = &mut *core;
        history.undo(graph)
    };
    let Some((_, changes)) = outcome else {
        return Ok(history_state(&core));
    };
    core.dirty = true;
    emit_changes(&app, &mut core, changes);
    Ok(history_state(&core))
}

/// 重做（广播变更事件）
#[tauri::command]
pub async fn scene_redo(
    app: tauri::AppHandle,
    state: tauri::State<'_, SceneSession>,
) -> Result<HistoryState, String> {
    let mut core = state.0.write().map_err(|e| e.to_string())?;
    let outcome = {
        let SessionCore { history, graph, .. } = &mut *core;
        history.redo(graph)
    };
    let Some((_, changes)) = outcome else {
        return Ok(history_state(&core));
    };
    core.dirty = true;
    emit_changes(&app, &mut core, changes);
    Ok(history_state(&core))
}

/// 当前历史状态（UI 同步用）
#[tauri::command]
pub async fn scene_history_state(
    state: tauri::State<'_, SceneSession>,
) -> Result<HistoryState, String> {
    let core = state.0.read().map_err(|e| e.to_string())?;
    Ok(history_state(&core))
}

/// 会话是否有未保存修改
#[tauri::command]
pub async fn scene_dirty(state: tauri::State<'_, SceneSession>) -> Result<bool, String> {
    let core = state.0.read().map_err(|e| e.to_string())?;
    Ok(core.dirty)
}

/// 层级面板行（后端单次 DFS 计算的展平树；前端只做折叠裁剪与渲染）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyRow {
    pub id: String,
    pub name: String,
    pub type_key: String,
    /// 显示深度：域外祖先不计入（画布挂组下时顶替父级深度作树根）
    pub depth: u32,
    pub visible: bool,
    pub active: bool,
    pub has_children: bool,
    pub has_prefab: bool,
}

/// scene_hierarchy_rows 结果（revision 为后端图版本，供前端同版本跳过）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyRows {
    pub revision: u64,
    pub rows: Vec<HierarchyRow>,
}

/// 层级面板行查询（读命令，O(n) 单次 DFS，替代前端每次图变更的全树
/// O(n·depth) 逐节点父链回溯）：view = scene 出非 UI 域 / layout 出 UI 域
/// （type 以 ui 开头或处于画布子树内，与前端视口点选同口径）；search 非空
/// 按名称子串过滤（大小写不敏感；行仍按 DFS 序带全深度，折叠由前端裁剪）。
#[tauri::command]
pub async fn scene_hierarchy_rows(
    state: tauri::State<'_, SceneSession>,
    view: String,
    search: Option<String>,
) -> Result<HierarchyRows, String> {
    let core = state.0.read().map_err(|e| e.to_string())?;
    let ui_domain = view == "layout";
    let q = search.unwrap_or_default().trim().to_lowercase();
    let graph = &core.graph;
    let mut rows: Vec<HierarchyRow> = Vec::new();
    let Some(root_id) = graph.root_id.clone() else {
        return Ok(HierarchyRows { revision: core.revision, rows });
    };
    // 迭代式 DFS（栈：节点 id、显示深度、所在画布子树标记）；子级逆序入栈保序
    let mut stack: Vec<(String, u32, bool)> = vec![(root_id, 0, false)];
    while let Some((id, depth, parent_in_canvas)) = stack.pop() {
        let Some(node) = graph.get(&id) else { continue };
        let in_canvas = parent_in_canvas || node.type_key == "uiCanvasNode";
        let in_domain = ui_domain == (node.type_key.starts_with("ui") || in_canvas);
        // 域外节点不进结果但仍下钻（根/组下挂画布），子级沿用同一显示深度
        let child_depth = if in_domain { depth + 1 } else { depth };
        if in_domain && (q.is_empty() || node.name.to_lowercase().contains(&q)) {
            rows.push(HierarchyRow {
                id: node.id.clone(),
                name: node.name.clone(),
                type_key: node.type_key.clone(),
                depth,
                visible: node.visible,
                active: node.active,
                has_children: !node.child_ids.is_empty(),
                has_prefab: node.extra.contains_key("prefab"),
            });
        }
        let mut children = node.child_ids.clone();
        children.reverse();
        for child in children {
            stack.push((child, child_depth, in_canvas));
        }
    }
    Ok(HierarchyRows { revision: core.revision, rows })
}

/// 会话当前打开的项目根目录（devtools 纯后端查询扫描用；未打开返回 None）
#[tauri::command]
pub async fn scene_root_path(
    state: tauri::State<'_, SceneSession>,
) -> Result<Option<String>, String> {
    let core = state.0.read().map_err(|e| e.to_string())?;
    Ok(core.root_path.as_ref().map(|p| p.display().to_string()))
}

/// 当前场景文档（信封 + 图重建 root；调试/兜底用）
#[tauri::command]
pub async fn scene_doc(state: tauri::State<'_, SceneSession>) -> Result<Value, String> {
    let core = state.0.read().map_err(|e| e.to_string())?;
    Ok(build_doc(&core))
}

/// 保存场景：后端序列化（保留信封字段）→ pretty JSON 写盘 → 清脏标记
#[tauri::command]
pub async fn scene_save(state: tauri::State<'_, SceneSession>) -> Result<(), String> {
    let mut core = state.0.write().map_err(|e| e.to_string())?;
    let (root_path, scene_rel) = match (&core.root_path, core.scene_rel.as_str()) {
        (Some(p), rel) if !rel.is_empty() => (p.clone(), rel.to_string()),
        _ => return Err("未打开场景（无保存目标）".into()),
    };
    let doc = build_doc(&core);
    let content = serde_json::to_string_pretty(&doc)
        .map_err(|e| format!("场景序列化失败: {e}"))?;
    let path = crate::project::resolve_in_root(&root_path, &scene_rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| format!("写入场景失败 '{scene_rel}': {e}"))?;
    if crate::project::is_meta_candidate(&root_path, &scene_rel) {
        let _ = crate::project::ensure_meta(&path);
    }
    core.dirty = false;
    Ok(())
}

/// 关闭会话（清空图与历史；不落盘）
#[tauri::command]
pub async fn scene_close(state: tauri::State<'_, SceneSession>) -> Result<(), String> {
    let mut core = state.0.write().map_err(|e| e.to_string())?;
    *core = SessionCore::default();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count_nodes(v: &Value) -> usize {
        1 + v
            .get("children")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(count_nodes).sum())
            .unwrap_or(0)
    }

    /// 真实模板场景（前端 TS 产物）→ Rust 解析建图 → 重建文档：
    /// 节点数/类型/材质引用/变换数值保真，保证旧文件直接可用
    #[test]
    fn template_scene_roundtrip() {
        let text = include_str!("../../../public/templates/3d/assets/Main.scene");
        let doc: Value = serde_json::from_str(text).expect("模板场景 JSON 解析");
        let root = doc.get("root").cloned().unwrap_or(Value::Null);
        let node = NodeData::deserialize(&root).expect("根节点 NodeData 解析");
        let (graph, all) = Graph::from_root_doc(node);
        assert!(!all.is_empty(), "模板场景应含节点");

        let out = graph.to_root_doc().unwrap();
        let out_json = serde_json::to_value(&out).unwrap();
        assert_eq!(count_nodes(&out_json), count_nodes(&root), "往返节点数一致");
        assert_eq!(out_json["type"], root["type"], "根节点类型保真");
        // 每个节点保持 id/名称/层级（按 id 抽样对比原文件）
        fn walk_ids(v: &Value, out: &mut Vec<(String, String, Option<String>)>) {
            out.push((
                v["id"].as_str().unwrap_or_default().to_string(),
                v["name"].as_str().unwrap_or_default().to_string(),
                v["parentId"].as_str().map(str::to_string),
            ));
            if let Some(children) = v.get("children").and_then(Value::as_array) {
                for c in children {
                    walk_ids(c, out);
                }
            }
        }
        let mut before = Vec::new();
        let mut after = Vec::new();
        walk_ids(&root, &mut before);
        walk_ids(&out_json, &mut after);
        assert_eq!(before, after, "id/名称/父子链保真");

        // 引用收集可用
        let (mats, models) = collect_refs(&doc);
        assert!(mats.iter().all(|r| r.ends_with(".mat")), "材质引用为 .mat 路径");
        let _ = models;
    }

    /// 前端「实例化预制体」提交的真实文档形状（SceneClient.addTree 产出）：
    /// serde 解析 → AddTree 命令执行 → undo/redo 往返（含组件/tag/嵌套 children）
    #[test]
    fn scene_add_tree_accepts_frontend_prefab_doc() {
        let doc_text = r#"{"type":"node","id":"node_mtt5n81u6sj3g","name":"PrefabRoot","parentId":"node_mtt5n81t1xyzi","childIds":["meshNode_mtt5n81u9zzt8"],"active":true,"visible":true,"transform":{"type":"transform","position":{"x":0,"y":0,"z":0},"rotation":{"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1}},"properties":{},"tag":"enemy","children":[{"type":"meshNode","id":"meshNode_mtt5n81u9zzt8","name":"Box","parentId":"node_mtt5n81u6sj3g","childIds":["node_mtt5n81ucb56n"],"active":true,"visible":true,"transform":{"type":"transform","position":{"x":0,"y":0,"z":0},"rotation":{"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1}},"properties":{},"components":[{"type":"light","enabled":true,"light":{"kind":"point","lightColor":16744448,"intensity":6,"distance":6,"decay":2,"angle":45,"penumbra":0.2,"castShadow":false}}],"source":"primitive","geometry":"box","size":{"x":1,"y":1,"z":1},"material":"internal/materials/Default.mat","model":"","anim":{"autoplay":true,"clip":"","speed":1,"loop":"loop"},"animGraph":null,"children":[{"type":"node","id":"node_mtt5n81ucb56n","name":"Inner","parentId":"meshNode_mtt5n81u9zzt8","childIds":[],"active":true,"visible":true,"transform":{"type":"transform","position":{"x":0,"y":0,"z":0},"rotation":{"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1}},"properties":{}}]}]}"#;
        let root: NodeData = serde_json::from_str(doc_text).expect("预制体文档 NodeData 解析");
        assert_eq!(root.children.len(), 1, "嵌套 children 解析");

        let mut core = SessionCore::default();
        // 场景根（父节点存在）
        let scene_root: NodeData =
            serde_json::from_value(serde_json::json!({ "type": "node", "id": "scene-root", "name": "Root" }))
                .unwrap();
        core.graph.add_node(scene_root).unwrap();

        let mut cmd = SceneCmd {
            label: "实例化 Foo.prefab".into(),
            kind: CmdKind::AddTree {
                root,
                parent_id: Some("scene-root".into()),
            },
        };
        let changes = cmd.execute(&mut core.graph);
        assert_eq!(changes.len(), 3, "根 + 2 子节点 = 3 条 add 变更");
        assert!(core.graph.contains("node_mtt5n81u6sj3g"));
        assert_eq!(
            core.graph.get("node_mtt5n81u6sj3g").unwrap().parent_id.as_deref(),
            Some("scene-root"),
            "根挂到目标父节点（以命令参数为准，而非文档内 parentId）"
        );
        let mesh = core.graph.get("meshNode_mtt5n81u9zzt8").unwrap();
        assert_eq!(mesh.child_ids, vec!["node_mtt5n81ucb56n".to_string()]);
        assert_eq!(
            mesh.extra.get("material").and_then(|v| v.as_str()),
            Some("internal/materials/Default.mat")
        );
        assert!(mesh.extra.contains_key("components"), "组件随 extra 透传");

        core.history.push(cmd);
        core.history.undo(&mut core.graph).unwrap();
        assert!(!core.graph.contains("node_mtt5n81u6sj3g"), "undo 摘除整棵实例");
        core.history.redo(&mut core.graph).unwrap();
        assert!(core.graph.contains("meshNode_mtt5n81u9zzt8"), "redo 重建整棵实例");
    }
}
