import { logger } from "../../platform_abstraction/logger";
import { EventBus } from "../../platform_abstraction/eventBus";
import { createNodeFactory, NodeFactory } from "../factory/NodeFactory";
import { CommandStack } from "../history/CommandStack";
import {
  AddNodeCommand,
  PropertyPatchCommand,
  RemoveNodeCommand,
  RenameCommand,
  ReparentCommand,
  TransformCommand,
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
import type { JsonRecord, Vec3 } from "../prototype/types";
import { RendererManager } from "./modules/RendererManager";
import { GizmoController, type GizmoMode } from "./modules/GizmoController";
import { SceneSynchronizer } from "./modules/SceneSynchronizer";
import { applySpawnOffset, sameTransform, snapshotTransform } from "./modules/utils";

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
  readonly gizmo: GizmoController;
  readonly synchronizer: SceneSynchronizer;

  selectedId: string | null = null;

  constructor() {
    this.factory = createNodeFactory(createDefaultRegistry());
    this.gizmo = new GizmoController(this.renderer.camera, this.renderer.domElement);
    this.synchronizer = new SceneSynchronizer(this.renderer.scene);

    this.renderer.setRenderCb(() => {
      this.gizmo.updateSelectionBox();
    });

    this.gizmo.setCallbacks({
      onDraggingChanged: (val) => {
        this.renderer.orbit.enabled = !val;
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
  }

  // ===================== 生命周期 =====================

  mount(container: HTMLElement): void {
    this.renderer.mount(container);
    this.gizmo.attachToScene(this.renderer.scene);
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
    this.run(new RemoveNodeCommand(this.graph, this.selectedId));
    this.select(null);
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

  select(id: string | null): void {
    this.selectedId = id;
    this.gizmo.select(id, this.synchronizer.getObjectMap(), this.graph);
    this.events.emit("select:changed", { nodeId: this.selectedId });
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
    this.gizmo.select(this.selectedId, this.synchronizer.getObjectMap(), this.graph);
  }

  setGizmoMode(mode: GizmoMode): void {
    this.gizmo.setMode(mode);
    this.events.emit("gizmo:state", { mode, space: this.gizmo.getSpace() });
  }

  setGizmoSpace(space: "local" | "world"): void {
    this.gizmo.setSpace(space);
    this.events.emit("gizmo:state", { mode: this.gizmo.getMode(), space });
  }
}
