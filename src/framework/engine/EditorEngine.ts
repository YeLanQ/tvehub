import { logger } from "../../platform_abstraction/logger";
import { EventBus } from "../../platform_abstraction/eventBus";
import * as THREE from "three";
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
import { degToRad, type JsonRecord } from "../prototype/types";
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
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  /** 场景真实渲染相机（预览用）：与编辑器自由轨道相机相互独立 */
  private readonly previewCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  /** 是否处于预览渲染（用场景中的 CameraNode 渲染） */
  private previewMode = false;
  /** 编辑器辅助物（网格/相机盒体/灯球/gizmo/选择框）是否显示 */
  private overlayVisible = true;

  constructor() {
    this.factory = createNodeFactory(createDefaultRegistry());
    this.synchronizer = new SceneSynchronizer(this.renderer.scene);
    this.renderer.registerCamera(this.previewCamera);
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
    this.events.on("select:changed", () => this.onSelectionChanged());
    this.setupViewportClickHandler();
    logger.info("EditorEngine mounted");
  }

  dispose(): void {
    this.renderer.dispose();
    this.gizmo.dispose();
    this.synchronizer.dispose();
    this.removeViewportClickHandler();
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
    this.syncPreviewView();
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

  // ===================== 视图模式 / 预览渲染相机 =====================

  /**
   * 切换视图渲染：
   * - "scene"（编辑视口）：使用独立自由轨道相机，显示编辑器辅助物，可交互；
   * - "preview"（预览渲染）：使用场景中的 CameraNode（真实渲染相机）渲染，
   *   隐藏编辑器辅助物，与编辑视口相机完全独立。
   */
  setViewMode(mode: "scene" | "preview"): void {
    const want = mode === "preview";
    if (want === this.previewMode) return;
    this.previewMode = want;
    this.syncPreviewView();
  }

  private onSelectionChanged(): void {
    if (!this.previewMode) return;
    this.syncPreviewView();
  }

  /** 预览相机选择：优先当前选中的 CameraNode，其次第一个非编辑器相机 */
  private resolvePreviewCameraNode(): CameraNode | null {
    const sel = this.selectedId ? this.graph.get(this.selectedId) : undefined;
    if (sel instanceof CameraNode) return sel;
    const cams = this.graph.all().filter((n): n is CameraNode => n instanceof CameraNode);
    if (!cams.length) return null;
    return cams.find((c) => !c.isEditorCamera) ?? cams[0];
  }

  /** 把预览相机对齐到相机节点的世界变换与 FOV/裁剪参数 */
  private syncPreviewCameraTo(node: CameraNode): void {
    const cam = this.previewCamera;
    cam.fov = node.fov;
    cam.near = node.near;
    cam.far = node.far;
    const obj = this.synchronizer.getObjectMap().get(node.id);
    if (obj) {
      obj.getWorldPosition(cam.position);
      obj.getWorldQuaternion(cam.quaternion);
    } else {
      cam.position.set(node.transform.position.x, node.transform.position.y, node.transform.position.z);
      const rot = degToRad(node.transform.rotation);
      cam.quaternion.setFromEuler(new THREE.Euler(rot.x, rot.y, rot.z, "XYZ"));
    }
    cam.updateProjectionMatrix();
  }

  /**
   * 依据当前 previewMode 应用一致的状态：
   * 有可用相机节点 → 预览相机渲染 + 隐藏编辑器辅助物 + 关闭轨道/变换工具；
   * 无相机节点 → 回退到编辑器视角。
   */
  private syncPreviewView(): void {
    if (!this.previewMode) {
      this.overlayVisible = true;
      this.renderer.setActiveCamera(this.renderer.camera);
      this.renderer.orbitControls.enabled = true;
      this.applyOverlayVisibility();
      return;
    }
    const node = this.resolvePreviewCameraNode();
    if (!node) {
      if (this.overlayVisible !== true) {
        logger.info("场景中未找到 CameraNode，预览回退到编辑器视角");
      }
      this.overlayVisible = true;
      this.renderer.setActiveCamera(this.renderer.camera);
      this.renderer.orbitControls.enabled = true;
      this.applyOverlayVisibility();
      return;
    }
    this.overlayVisible = false;
    this.syncPreviewCameraTo(node);
    this.renderer.setActiveCamera(this.previewCamera);
    this.renderer.orbitControls.enabled = false;
    this.applyOverlayVisibility();
  }

  /**
   * 编辑器辅助物显隐（与真实渲染无关的装饰）：
   * 网格、相机体、灯光的辅助球/框、gizmo、选择框。
   */
  private applyOverlayVisibility(): void {
    const vis = this.overlayVisible;
    this.renderer.scene.traverse((o) => {
      if (o.name === "__grid" || o.name === "__camBody") {
        o.visible = vis;
        return;
      }
      const ud = o.userData as { lamp?: boolean };
      if (ud.lamp) {
        // 保留真实灯光对象，仅隐藏装饰 mesh
        o.children.forEach((c) => {
          if (!(c as THREE.Light).isLight) c.visible = vis;
        });
      }
    });
    this.gizmo.setEditorEnabled(vis);
  }

  // ===================== 视口点击选择 =====================

  private setupViewportClickHandler(): void {
    const dom = this.renderer.domElement;
    const handler = (e: MouseEvent) => this.onViewportMouseDown(e);
    this._viewportClickHandler = handler;
    dom.addEventListener("mousedown", handler);
  }

  private removeViewportClickHandler(): void {
    if (!this._viewportClickHandler) return;
    this.renderer.domElement.removeEventListener("mousedown", this._viewportClickHandler);
    this._viewportClickHandler = null;
  }

  _viewportClickHandler: ((e: MouseEvent) => void) | null = null;

  private onViewportMouseDown(e: MouseEvent): void {
    // Only handle left-click (button 0) and only when not dragging in orbit/gizmo
    if (e.button !== 0) return;
    if (this.gizmo.isDragging()) return;
    // 预览渲染无编辑器选择语义
    if (this.previewMode) return;

    // Calculate mouse position in normalized device coordinates (-1 to +1)
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    // Set up raycasting from camera through mouse position
    this.raycaster.setFromCamera(this.mouse, this.renderer.camera);

    // Get all mapped scene objects
    const objectMap = this.synchronizer.getObjectMap();
    const objects = Array.from(objectMap.values());

    // Find intersections with scene objects
    const intersects = this.raycaster.intersectObjects(objects, true);
    if (intersects.length === 0) {
      // Clicked empty space — clear selection (unless shift is held for multi-select)
      if (!e.shiftKey && !e.ctrlKey) {
        this.clearSelection();
      }
      return;
    }

    // Find the first intersection that maps to a node
    for (const hit of intersects) {
      let obj: THREE.Object3D | null = hit.object as THREE.Object3D;
      while (obj) {
        const nodeId = (obj.userData as { nodeId?: string }).nodeId ?? null;
        if (nodeId && objectMap.has(nodeId)) {
          if (e.shiftKey || e.ctrlKey) {
            this.toggleSelection(nodeId);
          } else {
            this.select(nodeId);
          }
          return;
        }
        obj = obj.parent;
      }
    }
  }
}
