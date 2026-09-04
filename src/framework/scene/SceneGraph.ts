import type { Node } from "../prototype/Node";
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

/**
 * 场景图（数据层）。
 * 只维护"原型节点实例 + 父子链"的权威状态，不感知 Three.js；
 * 命令层直接改它，引擎层订阅它并把变化镜像到渲染世界。
 */
export class SceneGraph {
  private nodes = new Map<string, Node>();
  private rootId: string | null = null;
  private listeners = new Set<(c: SceneChange) => void>();

  get root(): Node | undefined {
    return this.rootId ? this.nodes.get(this.rootId) : undefined;
  }

  get size(): number {
    return this.nodes.size;
  }

  onChange(fn: (c: SceneChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(c: SceneChange): void {
    this.listeners.forEach((fn) => fn(c));
  }

  get(id: string): Node | undefined {
    return this.nodes.get(id);
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  setRoot(node: Node): void {
    this.nodes.clear();
    this.indexSubtree(node);
    this.rootId = node.id;
  }

  /** 用一棵已构建好的完整节点树整体替换场景图（场景文件加载使用） */
  replaceTree(root: Node, all: Node[]): void {
    this.nodes.clear();
    all.forEach((n) => this.nodes.set(n.id, n));
    this.rootId = root.id;
    this.emit({ kind: "replace", nodeId: root.id });
  }

  private indexSubtree(node: Node): void {
    this.nodes.set(node.id, node);
    node.childIds.forEach((childId) => {
      const child = this.nodes.get(childId);
      if (child) this.indexSubtree(child);
    });
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

  /** 加入节点（调用方需保证 node.parentId 已设且父节点存在或为 root） */
  add(node: Node): void {
    this.nodes.set(node.id, node);
    if (node.parentId) {
      this.nodes.get(node.parentId)?.addChildId(node.id);
    }
    this.emit({ kind: "add", nodeId: node.id });
  }

  /** 摘除节点（连同其子树保留引用，供 undo 重挂） */
  remove(id: string): { node: Node; removed: Node[] } | undefined {
    const node = this.nodes.get(id);
    if (!node) return undefined;
    const subtree = this.collectSubtree(node);
    subtree.forEach((n) => this.nodes.delete(n.id));
    if (node.parentId) this.nodes.get(node.parentId)?.removeChildId(id);
    else if (this.rootId === id) this.rootId = null;
    this.emit({ kind: "remove", nodeId: id });
    return { node, removed: subtree };
  }

  private collectSubtree(root: Node): Node[] {
    const out: Node[] = [];
    const walk = (n: Node) => {
      out.push(n);
      n.childIds.forEach((cid) => {
        const ch = this.nodes.get(cid);
        if (ch) walk(ch);
      });
    };
    walk(root);
    return out;
  }

  /** 重新挂回子树（命令 redo / undo 使用） */
  reattach(node: Node, removed: Node[]): void {
    removed.forEach((n) => this.nodes.set(n.id, n));
    if (node.parentId) {
      this.nodes.get(node.parentId)?.addChildId(node.id);
    } else {
      this.rootId = node.id;
    }
    this.emit({ kind: "add", nodeId: node.id });
  }

  reparent(id: string, newParentId: string | null, index = -1): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    // 防环：新父是被拖节点自身或其子孙（拖入自身子树）才禁止；
    // 新父是被拖节点的祖先（拖回根/父级）是合法操作，必须放行。
    if (newParentId !== null && (newParentId === id || this.isDescendant(id, newParentId))) return false;
    if (node.parentId) this.nodes.get(node.parentId)?.removeChildId(id);
    node.parentId = newParentId;
    if (newParentId === null) {
      this.rootId = id;
    } else {
      const parent = this.nodes.get(newParentId);
      if (!parent) return false;
      if (index < 0) parent.childIds.push(id);
      else parent.childIds.splice(index, 0, id);
    }
    this.emit({ kind: "reparent", nodeId: id });
    return true;
  }

  moveWithinParent(id: string, newIndex: number): void {
    const node = this.nodes.get(id);
    if (!node || !node.parentId) return;
    const parent = this.nodes.get(node.parentId);
    if (!parent) return;
    parent.childIds = parent.childIds.filter((cid) => cid !== id);
    parent.childIds.splice(newIndex, 0, id);
    this.emit({ kind: "reparent", nodeId: id });
  }

  rename(id: string, name: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.name = name;
    this.emit({ kind: "rename", nodeId: id });
  }

  patchTransform(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    this.emit({ kind: "transform", nodeId: id });
  }

  patchProperties(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    this.emit({ kind: "properties", nodeId: id });
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

  toJSON(): JsonRecord {
    const serialize = (node: Node): JsonRecord => {
      const children: JsonRecord[] = node.childIds
        .map((cid) => this.nodes.get(cid))
        .filter((n): n is Node => !!n)
        .map(serialize);
      const json = node.toJSON() as JsonRecord;
      json.children = children;
      return json;
    };
    const root = this.root;
    return root ? (serialize(root) as JsonRecord) : { type: "empty" };
  }
}