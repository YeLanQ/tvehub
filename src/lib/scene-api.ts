// ---------------------------------------------------------------------------
// 场景会话 API（前端 ↔ 后端权威状态）：
// - transport：SceneClient 的写通道（乐观应用后提交后端命令）；
// - open/loadDoc/save/close：装载与持久化（读盘/迁移/序列化全在后端）；
// - subscribe：订阅后端 scene:changed 事件（快照回灌镜像）。
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { JsonRecord } from "../framework/prototype/types";
import type {
  MoveTarget,
  PatchItem,
  SceneChangedEvent,
  SceneHistoryState,
  SceneTransport,
  TransformSnapshot,
} from "../framework/scene/SceneClient";

/** 装载结果：规范化的完整场景文档 + 引用清单（材质/模型预取用） */
export interface SceneLoadResult {
  doc: Record<string, unknown>;
  materialRefs: string[];
  modelRefs: string[];
  revision: number;
  history: SceneHistoryState;
}

/** 层级面板行（后端单次 DFS 计算：域过滤 + 搜索过滤，displayDepth 已按域压缩） */
export interface HierarchyRowDto {
  id: string;
  name: string;
  typeKey: string;
  depth: number;
  visible: boolean;
  active: boolean;
  hasChildren: boolean;
  hasPrefab: boolean;
}

export interface HierarchyRowsResult {
  revision: number;
  rows: HierarchyRowDto[];
}

const transport: SceneTransport = {
  addNode: (node, label) => invoke<void>("scene_add_node", { node, label }),
  addTree: (root, parentId, label) => invoke<void>("scene_add_tree", { root, parentId, label }),
  removeNodes: (ids, label) => invoke<void>("scene_remove_nodes", { ids, label }),
  reparentNodes: (moves: MoveTarget[], label) =>
    invoke<void>("scene_reparent_nodes", { moves, label }),
  rename: (id, name, label) => invoke<void>("scene_rename", { id, name, label }),
  setTransform: (id: string, before: TransformSnapshot, after: TransformSnapshot) =>
    invoke<void>("scene_set_transform", { id, before, after }),
  patchNode: (id: string, before: JsonRecord, after: JsonRecord, label) =>
    invoke<void>("scene_patch_node", { id, before, after, label }),
  patchNodes: (items: PatchItem[], label) => invoke<void>("scene_patch_nodes", { items, label }),
  undo: () => invoke<SceneHistoryState>("scene_undo"),
  redo: () => invoke<SceneHistoryState>("scene_redo"),
};

export const sceneApi = {
  /** SceneClient 写通道（项目打开时注入引擎） */
  transport: (): SceneTransport => transport,
  /** 打开项目内 .scene 资产（后端读盘 + 旧格式迁移 + 建图；历史清零）。
   *  force：会话已存在且无未保存修改时强制从磁盘重装（asset.write 等外部直写后
   *  重开场景即见磁盘版本）；有未保存修改由后端脏保护复用会话。 */
  open: (root: string, rel: string, force = false) =>
    invoke<SceneLoadResult>("scene_open", { root, rel, force }),
  /** 以前端构建的文档整树替换后端会话（初始场景/回退用；不落盘）；
   *  root/rel 提供时作为保存目标记录 */
  loadDoc: (doc: unknown, root?: string, rel?: string) =>
    invoke<SceneLoadResult>("scene_load_doc", { doc, root, rel }),
  /** 保存场景（后端序列化 + 写盘 + 清脏标记） */
  save: () => invoke<void>("scene_save"),
  /** 提交场景物理设置（合并进 settings.physics；不入撤销历史，仅标脏随保存落盘） */
  /** 读取当前会话的完整场景文档（devtools/状态快照用） */
  doc: () => invoke<unknown>("scene_doc"),
  /** 层级面板行查询（后端 DFS：view = scene|layout 域过滤 + 名称搜索；
   *  大量节点下替代前端全树逐节点父链回溯，revision 供同版本跳过） */
  hierarchyRows: (view: "scene" | "layout", search: string) =>
    invoke<HierarchyRowsResult>("scene_hierarchy_rows", { view, search }),
  /** 关闭会话（清空后端图与历史） */
  close: () => invoke<void>("scene_close"),
  /** 后端是否有未保存修改 */
  dirty: () => invoke<boolean>("scene_dirty"),
  /** 订阅后端 scene:changed 事件；返回取消函数 */
  subscribe: (fn: (e: SceneChangedEvent) => void): Promise<() => void> =>
    listen<SceneChangedEvent>("scene:changed", (ev) => fn(ev.payload)),
};
