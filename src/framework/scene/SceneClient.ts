// ---------------------------------------------------------------------------
// 场景客户端（前端镜像层）：
// 权威状态在后端 SceneSession（Rust）；本类维护一份只读镜像（原型 Node 实例，
// UI/SceneSynchronizer 直接读取），并承担三件事：
// 1. 读接口与旧 SceneGraph 同构（get/all/childrenOf/…），镜像消费者零改动；
// 2. 写操作乐观应用（先改镜像并广播 SceneChange，再提交后端命令），后端
//    scene:changed 事件回执幂等确认（快照回填）；提交失败回滚镜像并告警；
// 3. 撤销/重做转发后端执行，事件携带的历史状态驱动 HistoryView（UI 按钮态）。
// 连续交互（gizmo 拖动/滑杆）期间只更新镜像不提交，松手一次性带 before/after
// 提交——与旧命令栈"一次拖动 = 一个命令"的撤销粒度一致。
// ---------------------------------------------------------------------------

import { EventBus } from "../../platform_abstraction/eventBus";
import { logger } from "../../platform_abstraction/logger";
import type { NodeFactory } from "../factory/NodeFactory";
import type { Node } from "../prototype/Node";
import { serializePrefabTree } from "../prototype/prefab";
import type { JsonRecord } from "../prototype/types";

export type SceneChangeKind =
  | "add"
  | "remove"
  | "reparent"
  | "rename"
  | "transform"
  | "properties"
  | "replace"
  | "clear";

export interface SceneChange {
  kind: SceneChangeKind;
  nodeId: string;
}

/** 变换快照（度制欧拉；结构与文件格式同构） */
export interface TransformSnapshot {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
}

/** 批量重挂目标（多选拖拽一次撤销） */
export interface MoveTarget {
  id: string;
  newParentId: string | null;
  newIndex: number;
}

/** 后端历史状态（scene:changed 事件 / 命令返回携带） */
export interface SceneHistoryState {
  canUndo: boolean;
  canRedo: boolean;
  depth: number;
  undoLabel: string | null;
  redoLabel: string | null;
  labels: string[];
}

/** 后端 scene:changed 事件载荷 */
export interface SceneChangedEvent {
  /** 变更来源的场景 rel（会话按场景分键；订阅方据此过滤自己的会话） */
  rel: string;
  kind: SceneChangeKind;
  nodeId: string;
  revision: number;
  /** 变更涉及的节点快照（JSON；幂等回填镜像） */
  nodes: JsonRecord[];
  history: SceneHistoryState;
  dirty: boolean;
}

/** 批量属性补丁条目（多选批量编辑；before/after 为完整节点 JSON 快照） */
export interface PatchItem {
  id: string;
  before: JsonRecord;
  after: JsonRecord;
}

/** 写通道（应用层注入；未注入时纯本地镜像，无持久化/撤销） */
export interface SceneTransport {
  addNode(node: JsonRecord, label?: string): Promise<void>;
  /** 新增嵌套子树（prefab 实例化；层级以嵌套 children 为准，根挂 parentId 下） */
  addTree(root: JsonRecord, parentId: string | null, label?: string): Promise<void>;
  removeNodes(ids: string[], label?: string): Promise<void>;
  reparentNodes(moves: MoveTarget[], label?: string): Promise<void>;
  rename(id: string, name: string, label?: string): Promise<void>;
  setTransform(id: string, before: TransformSnapshot, after: TransformSnapshot): Promise<void>;
  patchNode(id: string, before: JsonRecord, after: JsonRecord, label?: string): Promise<void>;
  patchNodes(items: PatchItem[], label?: string): Promise<void>;
  undo(): Promise<SceneHistoryState>;
  redo(): Promise<SceneHistoryState>;
}

/** 镜像消费者所需的最小读接口（SceneSynchronizer/HelperSystem 依赖面） */
export interface GraphLike {
  get(id: string): Node | undefined;
  all(): Node[];
}

export interface HistoryEvents {
  changed: { canUndo: boolean; canRedo: boolean; depth: number };
}

/** 历史状态视图（后端权威；对 UI 暴露与旧 CommandStack 同构的读取面） */
export class HistoryView {
  readonly events = new EventBus<HistoryEvents>();
  private state: SceneHistoryState = {
    canUndo: false,
    canRedo: false,
    depth: 0,
    undoLabel: null,
    redoLabel: null,
    labels: [],
  };

  update(s: SceneHistoryState): void {
    this.state = s;
    this.events.emit("changed", {
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      depth: s.depth,
    });
  }

  clear(): void {
    this.update({
      canUndo: false,
      canRedo: false,
      depth: 0,
      undoLabel: null,
      redoLabel: null,
      labels: [],
    });
  }

  get canUndo(): boolean {
    return this.state.canUndo;
  }
  get canRedo(): boolean {
    return this.state.canRedo;
  }
  get depth(): number {
    return this.state.depth;
  }
  peekUndoLabel(): string | null {
    return this.state.undoLabel;
  }
  peekRedoLabel(): string | null {
    return this.state.redoLabel;
  }
  listLabels(): string[] {
    return [...this.state.labels];
  }
}

function applySnapshotTransform(node: Node, snap: TransformSnapshot): void {
  node.transform.setPosition(snap.position.x, snap.position.y, snap.position.z);
  node.transform.setRotation(snap.rotation.x, snap.rotation.y, snap.rotation.z);
  node.transform.setScale(snap.scale.x, snap.scale.y, snap.scale.z);
}

export class SceneClient implements GraphLike {
  private nodes = new Map<string, Node>();
  private rootId: string | null = null;
  private listeners = new Set<(c: SceneChange) => void>();
  private transport: SceneTransport | null = null;
  readonly history = new HistoryView();

  constructor(private factory: NodeFactory) {}

  /** 注入后端写通道（应用层在项目打开时接线；null = 断开） */
  setTransport(t: SceneTransport | null): void {
    this.transport = t;
  }

  onChange(fn: (c: SceneChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(c: SceneChange): void {
    this.listeners.forEach((fn) => fn(c));
  }

  // ===================== 读接口（与旧 SceneGraph 同构） =====================

  get root(): Node | undefined {
    return this.rootId ? this.nodes.get(this.rootId) : undefined;
  }

  get size(): number {
    return this.nodes.size;
  }

  get(id: string): Node | undefined {
    return this.nodes.get(id);
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  all(): Node[] {
    return [...this.nodes.values()];
  }

  childrenOf(id: string): Node[] {
    const node = this.nodes.get(id);
    if (!node) return [];
    return node.childIds.map((cid) => this.nodes.get(cid)).filter((n): n is Node => !!n);
  }

  parentOf(id: string): Node | undefined {
    const node = this.nodes.get(id);
    if (!node || !node.parentId) return undefined;
    return this.nodes.get(node.parentId);
  }

  isDescendant(maybeAncestorId: string | null, id: string): boolean {
    if (maybeAncestorId === null) return false;
    let cur = this.nodes.get(id)?.parentId ?? null;
    while (cur) {
      if (cur === maybeAncestorId) return true;
      cur = this.nodes.get(cur)?.parentId ?? null;
    }
    return false;
  }

  // ===================== 镜像结构操作（本地） =====================

  private linkAdded(node: Node): void {
    this.nodes.set(node.id, node);
    if (node.parentId) {
      this.nodes.get(node.parentId)?.addChildId(node.id);
    } else if (!this.rootId) {
      this.rootId = node.id;
    }
  }

  private collectSubtree(node: Node): Node[] {
    const out: Node[] = [];
    const walk = (n: Node): void => {
      out.push(n);
      n.childIds.forEach((cid) => {
        const ch = this.nodes.get(cid);
        if (ch) walk(ch);
      });
    };
    walk(node);
    return out;
  }

  private collectSubtreeById(id: string): Node[] {
    const node = this.nodes.get(id);
    return node ? this.collectSubtree(node) : [];
  }

  private removeFromMap(id: string): { node: Node; removed: Node[] } | undefined {
    const node = this.nodes.get(id);
    if (!node) return undefined;
    const subtree = this.collectSubtree(node);
    subtree.forEach((n) => this.nodes.delete(n.id));
    if (node.parentId) this.nodes.get(node.parentId)?.removeChildId(id);
    else if (this.rootId === id) this.rootId = null;
    return { node, removed: subtree };
  }

  private reattachMap(node: Node, removed: Node[]): void {
    removed.forEach((n) => this.nodes.set(n.id, n));
    if (node.parentId) {
      this.nodes.get(node.parentId)?.addChildId(node.id);
    } else {
      this.rootId = node.id;
    }
  }

  private reparentLocal(id: string, newParentId: string | null, index: number): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    // 防环：新父为自身或其子孙禁止；新父为祖先（拖回根/父级）合法
    if (
      newParentId !== null &&
      (newParentId === id || this.isDescendant(id, newParentId))
    ) {
      return false;
    }
    if (node.parentId) this.nodes.get(node.parentId)?.removeChildId(id);
    node.parentId = newParentId;
    if (newParentId === null) {
      this.rootId = id;
    } else {
      const parent = this.nodes.get(newParentId);
      if (!parent) return false;
      if (index < 0 || index >= parent.childIds.length) parent.childIds.push(id);
      else parent.childIds.splice(index, 0, id);
    }
    return true;
  }

  // ===================== 写路径：乐观应用 + 后端提交 =====================

  /** 新增节点（node.parentId 已指向目标父节点；失败自动回滚镜像） */
  add(node: Node, label?: string): void {
    this.linkAdded(node);
    this.emit({ kind: "add", nodeId: node.id });
    const json = node.toJSON() as JsonRecord;
    this.transport
      ?.addNode(json, label)
      .catch((e) => {
        logger.error(`[scene] 节点提交失败，已回滚 ${node.name}: ${String(e)}`);
        this.removeFromMap(node.id);
        this.emit({ kind: "remove", nodeId: node.id });
      });
  }

  /**
   * 新增嵌套子树（prefab 实例化；一次撤销）。
   * root/nodes 为 instantiatePrefabTree 产出的全新节点树（子节点尚未进镜像，
   * 经 nodes 参数遍历链接，而非镜像查找）；doc 为该树的嵌套序列化文档（提交体）。
   * 镜像按文档序乐观挂入（先父后子），提交失败整树回滚。
   */
  addTree(root: Node, nodes: Node[], parentId: string | null, label?: string): void {
    if (parentId !== null && !this.nodes.has(parentId)) return;
    if (!nodes.length) return;
    const byId = new Map(nodes.map((n) => [n.id, n] as const));
    const childrenInTree = (id: string): Node[] => {
      const out: Node[] = [];
      for (const cid of byId.get(id)?.childIds ?? []) {
        const c = byId.get(cid);
        if (c) out.push(c);
      }
      return out;
    };
    const added: Node[] = [];
    const walk = (n: Node): void => {
      if (!added.length) n.parentId = parentId;
      this.linkAdded(n);
      added.push(n);
      for (const c of childrenInTree(n.id)) {
        if (!added.includes(c)) walk(c);
      }
    };
    walk(root);
    added.forEach((n) => this.emit({ kind: "add", nodeId: n.id }));
    // 提交文档保留 prefab 来源引用与组件 id（实例身份与绑定键稳定）
    const doc = serializePrefabTree(root, childrenInTree, { forAsset: false });
    this.transport
      ?.addTree(doc, parentId, label)
      .catch((e) => {
        logger.error(`[scene] 子树提交失败，已回滚 ${root.name}: ${String(e)}`);
        for (let i = added.length - 1; i >= 0; i--) {
          const n = added[i];
          if (this.removeFromMap(n.id)) this.emit({ kind: "remove", nodeId: n.id });
        }
      });
  }

  /** 批量删除（一次撤销；根节点自动跳过） */
  removeNodes(ids: string[], label?: string): void {
    const rootId = this.root?.id ?? null;
    const captured: { node: Node; removed: Node[] }[] = [];
    for (const id of ids) {
      if (!id || id === rootId) continue;
      const res = this.removeFromMap(id);
      if (res) captured.push(res);
    }
    if (!captured.length) return;
    captured.forEach((c) => this.emit({ kind: "remove", nodeId: c.node.id }));
    this.transport
      ?.removeNodes(captured.map((c) => c.node.id), label)
      .catch((e) => {
        logger.error(`[scene] 删除提交失败，已回滚: ${String(e)}`);
        for (let i = captured.length - 1; i >= 0; i--) {
          this.reattachMap(captured[i].node, captured[i].removed);
          this.emit({ kind: "add", nodeId: captured[i].node.id });
        }
      });
  }

  /** 批量重挂/移动（多选拖拽一次撤销） */
  reparentNodes(moves: MoveTarget[], label?: string): void {
    const applied: MoveTarget[] = [];
    const olds: { id: string; oldParentId: string | null; oldIndex: number }[] = [];
    for (const m of moves) {
      const node = this.nodes.get(m.id);
      if (!node || !this.has(m.id)) continue;
      if (
        m.newParentId !== null &&
        (m.newParentId === m.id || this.isDescendant(m.id, m.newParentId))
      ) {
        continue;
      }
      const parent = node.parentId ? this.nodes.get(node.parentId) : undefined;
      olds.push({
        id: m.id,
        oldParentId: node.parentId,
        oldIndex: parent ? parent.childIds.indexOf(m.id) : 0,
      });
      if (this.reparentLocal(m.id, m.newParentId, m.newIndex)) {
        applied.push(m);
        this.emit({ kind: "reparent", nodeId: m.id });
      }
    }
    if (!applied.length) return;
    this.transport
      ?.reparentNodes(applied, label)
      .catch((e) => {
        logger.error(`[scene] 层级调整提交失败，已回滚: ${String(e)}`);
        for (let i = olds.length - 1; i >= 0; i--) {
          const o = olds[i];
          this.reparentLocal(o.id, o.oldParentId, o.oldIndex);
          this.emit({ kind: "reparent", nodeId: o.id });
        }
      });
  }

  /** 重命名 */
  rename(id: string, name: string, label?: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    const oldName = node.name;
    node.name = name;
    this.emit({ kind: "rename", nodeId: id });
    this.transport
      ?.rename(id, name, label)
      .catch((e) => {
        logger.error(`[scene] 重命名提交失败，已回滚: ${String(e)}`);
        node.name = oldName;
        this.emit({ kind: "rename", nodeId: id });
      });
  }

  /**
   * 提交变换（Gizmo 松手 / 检查器输入）。
   * 镜像可能已被调用方写到 after（gizmo 拖动实时回写）——此处幂等应用后提交。
   */
  commitTransform(id: string, before: TransformSnapshot, after: TransformSnapshot): void {
    const node = this.nodes.get(id);
    if (node) {
      applySnapshotTransform(node, after);
      this.emit({ kind: "transform", nodeId: id });
    }
    this.transport
      ?.setTransform(id, before, after)
      .catch((e) => {
        logger.error(`[scene] 变换提交失败，已回滚: ${String(e)}`);
        const n = this.nodes.get(id);
        if (n) {
          applySnapshotTransform(n, before);
          this.emit({ kind: "transform", nodeId: id });
        }
      });
  }

  /**
   * 整节点属性补丁（before/after 为完整节点 JSON 快照）。
   * 调用方约定与旧命令一致：节点可能已就地改到 after——此处幂等回填。
   */
  commitPatch(id: string, before: JsonRecord, after: JsonRecord, label?: string): void {
    const node = this.nodes.get(id);
    if (node) {
      node.applyJSON(after);
      this.emit({ kind: "properties", nodeId: id });
    }
    this.transport
      ?.patchNode(id, before, after, label)
      .catch((e) => {
        logger.error(`[scene] 属性提交失败，已回滚: ${String(e)}`);
        const n = this.nodes.get(id);
        if (n) {
          n.applyJSON(before);
          this.emit({ kind: "properties", nodeId: id });
        }
      });
  }

  /** 批量整节点属性补丁（多选批量编辑；一次撤销） */
  commitPatches(items: PatchItem[], label?: string): void {
    if (!items.length) return;
    for (const item of items) {
      const node = this.nodes.get(item.id);
      if (node) {
        node.applyJSON(item.after);
        this.emit({ kind: "properties", nodeId: item.id });
      }
    }
    this.transport
      ?.patchNodes(items, label)
      .catch((e) => {
        logger.error(`[scene] 批量属性提交失败，已回滚: ${String(e)}`);
        for (const item of items) {
          const n = this.nodes.get(item.id);
          if (n) {
            n.applyJSON(item.before);
            this.emit({ kind: "properties", nodeId: item.id });
          }
        }
      });
  }

  /** 本地已直接改写节点变换（gizmo 拖动实时回写）：仅广播，不提交 */
  notifyTransformChanged(id: string): void {
    if (this.nodes.has(id)) this.emit({ kind: "transform", nodeId: id });
  }

  /** 撤销（后端执行；结果经 scene:changed 事件回灌镜像与历史状态） */
  undo(): void {
    this.transport
      ?.undo()
      .then((h) => this.history.update(h))
      .catch((e) => logger.error(`[scene] 撤销失败: ${String(e)}`));
  }

  /** 重做（后端执行） */
  redo(): void {
    this.transport
      ?.redo()
      .then((h) => this.history.update(h))
      .catch((e) => logger.error(`[scene] 重做失败: ${String(e)}`));
  }

  // ===================== 装载 / 事件回执 =====================

  /**
   * 嵌套文档根 → 镜像重建（scene_open / scene_load_doc 装载结果）。
   * 层级以嵌套 children 重建 childIds/parentId（与旧 loadScene 解析规则一致）。
   */
  replaceFromDocRoot(rootJson: JsonRecord | null | undefined): void {
    this.nodes.clear();
    this.rootId = null;
    if (rootJson && typeof rootJson === "object" && (rootJson as { type?: string }).type !== "empty") {
      const build = (json: JsonRecord, parentId: string | null): Node => {
        const node = this.factory.fromJSON(json);
        node.parentId = parentId;
        node.childIds = [];
        const children = Array.isArray(json.children) ? (json.children as JsonRecord[]) : [];
        for (const childJson of children) {
          const child = build(childJson, node.id);
          node.childIds.push(child.id);
          this.nodes.set(child.id, child);
        }
        this.nodes.set(node.id, node);
        return node;
      };
      const root = build(rootJson, null);
      this.rootId = root.id;
    }
    this.emit({ kind: "replace", nodeId: this.rootId ?? "" });
  }

  /** 平铺快照整树重建（replace 事件 / 兜底） */
  rebuildFromSnapshots(list: JsonRecord[]): void {
    this.nodes.clear();
    this.rootId = null;
    for (const json of list) {
      const node = this.factory.fromJSON(json);
      this.nodes.set(node.id, node);
      if (!node.parentId) this.rootId = node.id;
    }
    this.emit({ kind: "replace", nodeId: this.rootId ?? "" });
  }

  /** 后端 scene:changed 事件回执：历史状态 + 快照幂等回填 + 子树清理 */
  applyEvent(evt: SceneChangedEvent): void {
    this.history.update(evt.history);
    if (evt.kind === "replace") {
      this.rebuildFromSnapshots(evt.nodes);
      return;
    }
    if (evt.kind === "remove") {
      // 删除事件的快照只含父节点；子树按镜像 childIds 收集清除
      this.collectSubtreeById(evt.nodeId).forEach((n) => this.nodes.delete(n.id));
    }
    for (const json of evt.nodes) this.applySnapshot(json);
    this.emit({ kind: evt.kind, nodeId: evt.nodeId });
  }

  private applySnapshot(json: JsonRecord): void {
    const id = typeof json.id === "string" ? json.id : "";
    if (!id) return;
    const existing = this.nodes.get(id);
    if (existing) {
      existing.applyJSON(json);
      return;
    }
    const node = this.factory.fromJSON(json);
    this.nodes.set(id, node);
    if (!node.parentId) this.rootId = id;
  }
}
