import type { SceneGraph } from "../scene/SceneGraph";
import type { Node } from "../prototype/Node";
import type { JsonRecord, Vec3 } from "../prototype/types";
import type { Command } from "./Command";

function nodeJson(node: Node): JsonRecord {
  return node.toJSON() as JsonRecord;
}

// —— Add ——

export class AddNodeCommand implements Command {
  readonly label: string;
  constructor(
    private graph: SceneGraph,
    private node: Node,
    label?: string,
  ) {
    this.label = label ?? `Add ${node.name}`;
  }
  execute(): void {
    this.graph.add(this.node);
  }
  undo(): void {
    this.graph.remove(this.node.id);
  }
}

// —— Remove ——

export class RemoveNodeCommand implements Command {
  readonly label: string;
  private captured?: { node: Node; removed: Node[] };
  constructor(
    private graph: SceneGraph,
    private nodeId: string,
    label?: string,
  ) {
    this.label = label ?? `Remove node`;
  }
  execute(): void {
    const res = this.graph.remove(this.nodeId);
    if (res && !this.captured) this.captured = res;
  }
  undo(): void {
    if (!this.captured) return;
    this.graph.reattach(this.captured.node, this.captured.removed);
  }
}

// —— Reparent ——

export class ReparentCommand implements Command {
  readonly label: string;
  private oldParentId: string | null = null;
  private oldIndex = -1;
  private newParentId: string | null = null;
  private newIndex = -1;
  constructor(
    private graph: SceneGraph,
    private nodeId: string,
    newParentId: string | null,
    newIndex = -1,
    label?: string,
  ) {
    this.label = label ?? `Reparent node`;
    this.newParentId = newParentId;
    this.newIndex = newIndex;
    const node = this.graph.get(nodeId);
    this.oldParentId = node?.parentId ?? null;
    const parent = this.oldParentId ? this.graph.get(this.oldParentId) : undefined;
    this.oldIndex = parent ? parent.childIds.indexOf(nodeId) : 0;
  }
  execute(): void {
    this.graph.reparent(this.nodeId, this.newParentId, this.newIndex);
  }
  undo(): void {
    this.graph.reparent(this.nodeId, this.oldParentId, this.oldIndex);
  }
}

// —— Rename ——

export class RenameCommand implements Command {
  readonly label: string;
  private oldName = "";
  constructor(
    private graph: SceneGraph,
    private nodeId: string,
    private newName: string,
    label?: string,
  ) {
    this.label = label ?? `Rename node`;
    this.oldName = this.graph.get(nodeId)?.name ?? "";
  }
  execute(): void {
    this.graph.rename(this.nodeId, this.newName);
  }
  undo(): void {
    this.graph.rename(this.nodeId, this.oldName);
  }
}

// —— Transform（命令级粒度：一次拖动 = 一个命令，保存 before/after 快照）——

export interface TransformSnapshot {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

function snapTransform(node: Node): TransformSnapshot {
  return {
    position: { ...node.transform.position },
    rotation: { ...node.transform.rotation },
    scale: { ...node.transform.scale },
  };
}

export class TransformCommand implements Command {
  readonly label = "Set Transform";
  private before: TransformSnapshot;
  private after: TransformSnapshot;
  constructor(
    private graph: SceneGraph,
    private nodeId: string,
    target: TransformSnapshot,
  ) {
    const node = this.graph.get(nodeId);
    this.before = node ? snapTransform(node) : { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    this.after = target;
    // gizmo 拖动过程中视觉已即时生效：这里记录命令时 before 取拖动前的快照
  }

  setBefore(from: TransformSnapshot): void {
    this.before = from;
  }

  execute(): void {
    this.apply(this.after);
  }
  undo(): void {
    this.apply(this.before);
  }

  private apply(snap: TransformSnapshot): void {
    const node = this.graph.get(this.nodeId);
    if (!node) return;
    node.transform.setPosition(snap.position.x, snap.position.y, snap.position.z);
    node.transform.setRotation(snap.rotation.x, snap.rotation.y, snap.rotation.z);
    node.transform.setScale(snap.scale.x, snap.scale.y, snap.scale.z);
    this.graph.patchTransform(this.nodeId);
  }
}

// —— 属性 / 自有数据补丁（before/after 整节点 JSON，redo 时回填）——

export class PropertyPatchCommand implements Command {
  readonly label: string;
  constructor(
    private graph: SceneGraph,
    private nodeId: string,
    private before: JsonRecord,
    private after: JsonRecord,
    label?: string,
  ) {
    this.label = label ?? "Set Property";
  }
  execute(): void {
    this.apply(this.after);
  }
  undo(): void {
    this.apply(this.before);
  }
  private apply(json: JsonRecord): void {
    const node = this.graph.get(this.nodeId);
    if (!node) return;
    // 仅回填数据字段，保持节点实例在图上的父子链（childIds 在 before/after 中一致）
    node.applyJSON(json);
    this.graph.patchProperties(this.nodeId);
  }
}

export function snapshotNode(node: Node): JsonRecord {
  return nodeJson(node);
}

// —— 批量删除（多选一次撤销）——

export class RemoveNodesCommand implements Command {
  readonly label: string;
  private captured: { node: Node; removed: Node[] }[] = [];
  constructor(
    private graph: SceneGraph,
    private ids: string[],
    label?: string,
  ) {
    this.label = label ?? "Remove nodes";
  }
  execute(): void {
    if (this.captured.length) {
      // redo：重新摘除（und 已回挂）
      for (const c of this.captured) this.graph.remove(c.node.id);
      return;
    }
    for (const id of this.ids) {
      // 跳过根节点与不存在的节点（多选会先在前端过滤，这里再兜底）
      if (this.graph.root?.id === id) continue;
      const res = this.graph.remove(id);
      if (res) this.captured.push(res);
    }
  }
  undo(): void {
    for (let i = this.captured.length - 1; i >= 0; i--) {
      const c = this.captured[i];
      this.graph.reattach(c.node, c.removed);
    }
  }
}

// —— 批量重挂/移动（多选拖拽一次撤销）——

export interface MoveTarget {
  id: string;
  newParentId: string | null;
  newIndex: number;
}

export class ReparentNodesCommand implements Command {
  readonly label: string;
  private olds: { id: string; oldParentId: string | null; oldIndex: number }[] = [];
  constructor(
    private graph: SceneGraph,
    private moves: MoveTarget[],
    label?: string,
  ) {
    this.label = label ?? "Move nodes";
  }
  execute(): void {
    if (!this.olds.length) {
      for (const m of this.moves) {
        const node = this.graph.get(m.id);
        if (!node) continue;
        const parent = node.parentId ? this.graph.get(node.parentId) : undefined;
        const oldIndex = parent ? parent.childIds.indexOf(m.id) : 0;
        this.olds.push({ id: m.id, oldParentId: node.parentId, oldIndex });
        this.graph.reparent(m.id, m.newParentId, m.newIndex);
      }
    } else {
      for (const m of this.moves) this.graph.reparent(m.id, m.newParentId, m.newIndex);
    }
  }
  undo(): void {
    for (let i = this.olds.length - 1; i >= 0; i--) {
      const o = this.olds[i];
      this.graph.reparent(o.id, o.oldParentId, o.oldIndex);
    }
  }
}