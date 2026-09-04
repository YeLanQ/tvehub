import { logger } from "../../platform_abstraction/logger";
import { EventBus } from "../../platform_abstraction/eventBus";
import { createNodeFactory, NodeFactory } from "../factory/NodeFactory";
import { CommandStack } from "../history/CommandStack";
import {
  AddNodeCommand,
  PropertyPatchCommand,

  RemoveNodesCommand,
  RenameCommand,
  ReparentCommand,
  ReparentNodesCommand,
  TransformCommand,
  type MoveTarget,
  type TransformSnapshot,
} from "../command/commands";
import type { Command } from "../command/Command";
import { createDefaultRegistry } from "../prototype/PrototypeRegistry";
import { SceneGraph, type SceneChange } from "../scene/SceneGraph";
import type { Node } from "../prototype/Node";
import {
  CameraNode,
  LightNode,
  MeshNode,
  type GeometryKind,
} from "../prototype/derived/Primitives";
import type { JsonRecord } from "../prototype/types";
import { RendererManager } from "./modules/RendererManager";
export type { GizmoMode } from "./modules/GizmoController";
import { GizmoController, type GizmoMode } from "./modules/GizmoController";
import { SceneSynchronizer } from "./modules/SceneSynchronizer";
import { applySpawnOffset, snapshotTransform } from "./modules/utils";

export interface EditorEvents extends Record<string, unknown> {
  "graph:changed": SceneChange;
  "select:changed": { nodeId: string | null };
  "gizmo:state": { mode: GizmoMode; space: "local" | "world" };
}

export class EditorEngine {
  readonly graph = new SceneGraph();
  readonly factory: NodeFactory;
  readonly history = new CommandStack();
  readonly events = new EventBus<EditorEvents>();

  readonly renderer = new RendererManager();
  readonly synchronizer: SceneSynchronizer;
  gizmo!: GizmoController;

  selectedId: string | null = null;
  private selectedIds: string[] = [];

  constructor() {
    this.factory = createNodeFactory(createDefaultRegistry());
    this.synchronizer = new SceneSynchronizer(this.renderer.scene);
  }

  private initGizmo(): void {
    this.gizmo = new GizmoController(this.renderer.camera, this.renderer.domElement);
    this.gizmo.setCallbacks({
      onDraggingChanged: (val) => {
        this.renderer.orbitControls.enabled = !val;
      },
      onGizmoObjectChange: () => {
        this.gizmo.updateSelectionBox();
      },
    });
    this.gizmo.onCommitTransform = (id, after, before) => {
      const cmd = new TransformCommand(this.graph, id, after);
      cmd.setBefore(before);
      this.run(cmd);
    };
    this.gizmo.attachToScene(this.renderer.scene);
  }

  // ===================== 生命周期 =====================

  mount(container: HTMLElement): void {
    this.renderer.mount(container);
    this.initGizmo();
    this.renderer.setRenderCb(() => {
      this.gizmo.updateSelectionBox();
    });
    this.graph.onChange((c) => this.onGraphChange(c));
    logger.info("EditorEngine mounted");
  }

  dispose(): void {
    this.renderer.dispose();
    this.gizmo.dispose();
    this.synchronizer.dispose();
  }

  // ===================== 操作 API 走命令 + 栈 =====================

  run(cmd: Command, mergeKey?: string): void {
    this.history.execute(cmd, mergeKey);
  }

  undo(): void {
    this.history.undo();
  }

  redo(): void {
    this.history.redo();
  }

  addMesh(geometry: GeometryKind, parentId?: string): MeshNode {
    const parent = this.resolveParent(parentId);
    const node = this.factory.createMesh(geometry, { parentId: parent?.id ?? null });
    applySpawnOffset(node);
    this.run(new AddNodeCommand(this.graph, node));
    this.select(node.id);
    return node;
  }

  addLight(kind: LightNode["lightKind"], parentId?: string): LightNode {
    const parent = this.resolveParent(parentId);
    const node = this.factory.createLight(kind, { parentId: parent?.id ?? null });
    this.run(new AddNodeCommand(this.graph, node));
    this.select(node.id);
    return node;
  }

  addCamera(parentId?: string): CameraNode {
    const parent = this.resolveParent(parentId);
    const node = this.factory.createCamera({ parentId: parent?.id ?? null });
    this.run(new AddNodeCommand(this.graph, node));
    this.select(node.id);
    return node;
  }

  addEmptyGroup(parentId?: string): Node {
    const parent = this.resolveParent(parentId);
    const node = this.factory.create("node", { parentId: parent?.id ?? null, name: "Group" });
    this.run(new AddNodeCommand(this.graph, node));
    this.select(node.id);
    return node;
  }

  deleteSelected(): void {
    if (!this.selectedId) return;
    this.deleteNodes([this.selectedId]);
  }

  deleteNodes(ids: string[]): void {
    const targets = ids.filter((id) => {
      if (!id) return false;
      if (this.graph.root?.id === id) return false;
      return this.graph.has(id);
    });
    if (!targets.length) return;
    this.run(new RemoveNodesCommand(this.graph, targets));
    this.setSelection(this.selectedIds.filter((s) => this.graph.has(s)));
  }

  reparentNodes(moves: MoveTarget[]): void {
    const valid = moves.filter((m) => m.id && this.graph.has(m.id));
    if (!valid.length) return;
    this.run(new ReparentNodesCommand(this.graph, valid));
  }

  renameSelected(name: string): void {
    if (this.selectedId) this.run(new RenameCommand(this.graph, this.selectedId, name));
  }

  reparentSelected(newParentId: string | null): void {
    if (!this.selectedId) return;
    this.run(new ReparentCommand(this.graph, this.selectedId, newParentId));
  }

  setTransform(nodeId: string, snap: TransformSnapshot): void {
    this.run(new TransformCommand(this.graph, nodeId, snap));
  }

  patchNode(nodeId: string, before: JsonRecord, after: JsonRecord, label?: string): void {
    this.run(new PropertyPatchCommand(this.graph, nodeId, before, after, label));
  }

  private resolveParent(preferred?: string): Node | undefined {
    if (preferred) return this.graph.get(preferred);
    if (this.selectedId) {
      const sel = this.graph.get(this.selectedId);
      if (sel) return sel;
    }
    return this.graph.root;
  }

  // ===================== 选择 =====================

  get selectionIds(): string[] {
    return [...this.selectedIds];
  }

  select(id: string | null): void {
    this.selectedIds = id ? [id] : [];
    this.selectedId = id;
    this.gizmo.select(id, this.synchronizer.getObjectMap());
    this.events.emit("select:changed", { nodeId: this.selectedId });
  }

  addToSelection(id: string): void {
    if (!id || this.selectedIds.includes(id)) return;
    if (this.selectedIds.length === 0) this.selectedId = id;
    this.selectedIds.push(id);
    this.syncGizmo();
    this.events.emit("select:changed", { nodeId: this.selectedId });
  }

  toggleSelection(id: string): void {
    if (!id) return;
    if (this.selectedIds.includes(id)) {
      this.selectedIds = this.selectedIds.filter((s) => s !== id);
      this.selectedId = this.selectedIds[this.selectedIds.length - 1] ?? null;
    } else {
      this.selectedIds.push(id);
      this.selectedId = id;
    }
    this.syncGizmo();
    this.events.emit("select:changed", { nodeId: this.selectedId });
  }

  setSelection(ids: string[]): void {
    this.selectedIds = [...ids];
    this.selectedId = ids[ids.length - 1] ?? null;
    this.syncGizmo();
    this.events.emit("select:changed", { nodeId: this.selectedId });
  }

  clearSelection(): void {
    this.select(null);
  }

  private syncGizmo(): void {
    this.gizmo.select(this.selectedId, this.synchronizer.getObjectMap());
  }

  getTransform(id: string): TransformSnapshot | null {
    const node = this.graph.get(id);
    return node ? snapshotTransform(node) : null;
  }

  getSelectedNode(): Node | undefined {
    return this.selectedId ? this.graph.get(this.selectedId) : undefined;
  }

  // ===================== 数据 → Three 同步 =====================

  private onGraphChange(c: SceneChange): void {
    this.synchronizer.onGraphChange(c, this.graph);
    this.events.emit("graph:changed", c);
  }

  rebuildAll(): void {
    this.synchronizer.rebuildAll(this.graph);
    this.gizmo.select(this.selectedId, this.synchronizer.getObjectMap());
  }

  /** 用一棵完整节点树替换当前场景图并重建渲染（场景文件加载使用） */
  replaceGraph(root: Node, all: Node[]): void {
    this.graph.replaceTree(root, all);
    this.selectedId = null;
    this.rebuildAll();
  }

  setGizmoMode(mode: GizmoMode): void {
    this.gizmo.setMode(mode);
    this.events.emit("gizmo:state", { mode, space: this.gizmo.getSpace() });
  }

  setGizmoSpace(space: "local" | "world"): void {
    this.gizmo.setSpace(space);
    this.events.emit("gizmo:state", { mode: this.gizmo.getMode(), space });
  }

  get gizmoMode(): GizmoMode {
    return this.gizmo.getMode();
  }

  get gizmoSpace(): "local" | "world" {
    return this.gizmo.getSpace();
  }
}
