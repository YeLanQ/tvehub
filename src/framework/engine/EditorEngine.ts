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
import { degToRad, radToDeg, type JsonRecord } from "../prototype/types";
import { RendererManager, type RendererBackend } from "./modules/RendererManager";
import { HelperSystem } from "./modules/HelperSystem";
export type { GizmoMode } from "./modules/GizmoController";
import { GizmoController, type GizmoMode } from "./modules/GizmoController";
import { SceneSynchronizer } from "./modules/SceneSynchronizer";
import { applyLightSpawn, applySpawnOffset, snapshotTransform } from "./modules/utils";
import { MaterialManager } from "../material/MaterialManager";

export interface EditorEvents extends Record<string, unknown> {
  "graph:changed": SceneChange;
  "select:changed": { nodeId: string | null };
  "gizmo:state": { mode: GizmoMode; space: "local" | "world" };
  /** 材质资产参数变更（保存/刷新后广播；rel 为空串表示全部） */
  "material:changed": { rel: string };
}

export class EditorEngine {
  readonly graph = new SceneGraph();
  readonly factory: NodeFactory;
  readonly history = new CommandStack();
  readonly events = new EventBus<EditorEvents>();

  readonly renderer = new RendererManager();
  readonly synchronizer: SceneSynchronizer;
  readonly helperSystem: HelperSystem;
  /** 材质资产参数缓存/解析（网格按引用取参数渲染；应用层注入文件读取器） */
  readonly materials = new MaterialManager();
  gizmo!: GizmoController;

  /**
   * 项目设计分辨率（取自 project.config.json 的 designResolution）。
   * 相机辅助视锥线框的取景宽高比优先使用它；null = 未设置（回退视口宽高比）。
   * 应用层在项目打开/设置保存后写入，辅助线每帧读取即时同步。
   */
  designResolution: { width: number; height: number } | null = null;

  selectedId: string | null = null;
  private selectedIds: string[] = [];
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  // —— gizmo 拖动“独占”期间的全局输入拦截（避免左键/键位串扰变换）——
  private onCapturePointerDown = (e: PointerEvent): void => {
    if (this.gizmo && this.gizmo.isDragging()) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  private onCaptureKeyDown = (e: KeyboardEvent): void => {
    if (this.gizmo && this.gizmo.isDragging()) {
      // 拖动中屏蔽 W/E/R、Delete、Ctrl+Z、Shift/空格 等键位，避免干扰变换
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  /** 场景真实渲染相机（预览用）：与编辑器自由轨道相机相互独立 */
  private readonly previewCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  /** 是否处于预览渲染（用场景中的 CameraNode 渲染） */
  private previewMode = false;
  /** 编辑器辅助物（网格/相机盒体/灯球/gizmo/选择框）是否显示 */
  private overlayVisible = true;
  /** 无场景相机时的回退提示是否已输出过（避免每次图事件刷屏） */
  private previewFallbackLogged = false;

  constructor() {
    this.factory = createNodeFactory(createDefaultRegistry());
    this.synchronizer = new SceneSynchronizer(this.renderer.scene, {
      paramsFor: (rel) => this.materials.paramsFor(rel),
    });
    // 材质库缓存更新（编辑保存等）→ 刷新引用该材质的所有网格外观
    this.materials.onChanged((rel) => this.refreshMaterialNodes(rel));
    this.helperSystem = new HelperSystem(this.renderer.scene, {
      getAspect: () => this.renderer.aspect,
      getDesignSize: () => this.designResolution,
      getEditorDistanceTo: (p) => {
        const cam = this.renderer.camera;
        return cam ? cam.position.distanceTo(p) : 1;
      },
    });
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
        // 拖动中把 three 对象的当前变换实时回写数据节点并广播，
        // 属性面板的 Transform 数值与视口 gizmo 同步变化（松手才写历史）
        if (this.gizmo.isDragging()) this.syncGizmoTransformToNode();
      },
    });
    this.gizmo.onCommitTransform = (id, after, before) => {
      const cmd = new TransformCommand(this.graph, id, after);
      cmd.setBefore(before);
      this.run(cmd);
    };
    this.gizmo.attachToScene(this.renderer.scene);
    // 关键：把 OrbitControls 的监听器摘掉后重新挂到 gizmo 之后——
    // 指针按下时 gizmo 先进入拖拽并（经 dragging-changed）禁用轨道相机，
    // OrbitControls 随后收到同一个按下事件时因 enabled=false 直接忽略，
    // 避免“拖动变换的同时相机也在旋转”。
    {
      const oc = this.renderer.orbitControls as unknown as {
        disconnect?: () => void;
        connect?: (el: HTMLElement) => void;
      };
      oc.disconnect?.();
      oc.connect?.(this.renderer.domElement);
    }
  }

  /**
   * gizmo 拖动中调用：把当前被拖 three 对象的变换实时写回数据节点
   * （不产生历史命令，undo 仍以拖动起点/终点为准），并广播 transform 变化，
   * 让属性面板数值与 gizmo 同步。
   */
  private syncGizmoTransformToNode(): void {
    const id = this.selectedId;
    if (!id) return;
    const node = this.graph.get(id);
    const obj = id ? this.synchronizer.getObjectMap().get(id) : undefined;
    if (!node || !obj) return;
    const rot = radToDeg({ x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z });
    node.transform.setPosition(obj.position.x, obj.position.y, obj.position.z);
    node.transform.setRotation(rot.x, rot.y, rot.z);
    node.transform.setScale(obj.scale.x, obj.scale.y, obj.scale.z);
    this.graph.patchTransform(node.id);
  }

  // ===================== 生命周期 =====================

  async mount(
    container: HTMLElement,
    options?: {
      renderer?: RendererBackend;
      antialias?: number;
      hdrMode?: "hdr" | "ldr";
    },
  ): Promise<void> {
    await this.renderer.mount(container, options);
    this.initGizmo();
    this.renderer.setRenderCb(() => {
      this.gizmo.updateSelectionBox();
      // 每帧贴合辅助线世界变换（gizmo 拖拽时实时跟随）
      this.helperSystem.tick(this.synchronizer.getObjectMap());
    });
    this.graph.onChange((c) => this.onGraphChange(c));
    this.events.on("select:changed", () => this.onSelectionChanged());
    this.setupViewportClickHandler();
    // gizmo 拖动期间：捕获阶段拦截其它鼠标按下与键位输入（独占变换操作）
    window.addEventListener("pointerdown", this.onCapturePointerDown, true);
    window.addEventListener("keydown", this.onCaptureKeyDown, true);
    logger.info("EditorEngine mounted");
  }

  dispose(): void {
    window.removeEventListener("pointerdown", this.onCapturePointerDown, true);
    window.removeEventListener("keydown", this.onCaptureKeyDown, true);
    this.renderer.dispose();
    this.gizmo.dispose();
    this.helperSystem.dispose();
    this.synchronizer.dispose();
    this.materials.clear();
    this.removeViewportClickHandler();
  }

  /** gizmo 是否正在拖动（变换过程中）——其它交互可用此状态判断是否需要忽略 */
  get isGizmoDragging(): boolean {
    return this.gizmo.isDragging();
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
    applyLightSpawn(node);
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

  /**
   * 材质资产参数保存后：刷新引用该材质的所有网格外观并广播 material:changed。
   * rel 为空时刷新全部网格材质（装载/迁移后兜底用）。
   */
  refreshMaterialNodes(rel?: string | null): void {
    for (const node of this.graph.all()) {
      if (node instanceof MeshNode && (rel == null || node.material === rel)) {
        this.synchronizer.refreshMeshMaterial(node);
      }
    }
    this.events.emit("material:changed", { rel: rel ?? "" });
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
    this.helperSystem.onGraphChange(c, this.graph, this.synchronizer.getObjectMap());
    this.events.emit("graph:changed", c);
    this.syncPreviewView();
    // 新入图/属性变更引用了尚未解析的材质资产（如撤销/重做改回引用）→ 异步预取后刷新
    const n = this.graph.get(c.nodeId);
    if (n instanceof MeshNode && !this.materials.has(n.material)) {
      const rel = n.material;
      void this.materials.preload([rel]).then(() => this.refreshMaterialNodes(rel));
    }
  }

  rebuildAll(): void {
    this.synchronizer.rebuildAll(this.graph);
    this.helperSystem.rebuildAll(this.graph, this.synchronizer.getObjectMap());
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
    if (want) this.previewFallbackLogged = false;
    this.syncPreviewView();
  }

  /**
   * 控制编辑器后台渲染循环：
   * - active=true（场景编辑）→ 恢复 rAF 渲染；
   * - active=false（预览/脚本由中央区域独立面板接管）→ 暂停后台渲染，避免空转。
   */
  setRenderingActive(active: boolean): void {
    this.renderer.setPaused(!active);
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
    // 模型层保证 near ≥ 0.01、far ≥ 1；真实透视相机还需要 far > near，这里兜底
    const near = Math.max(0.01, node.near);
    const far = Math.max(node.far, near + 1e-4);
    cam.near = near;
    cam.far = far;
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
   * 有可用相机节点 → 用该节点渲染预览；
   * 无相机节点 → 用默认取景视角渲染（隐藏编辑器辅助物、禁用轨道）。
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
      if (!this.previewFallbackLogged) {
        logger.info("场景中没有 CameraNode，预览使用默认相机视角");
        this.previewFallbackLogged = true;
      }
      this.applyDefaultPreviewPose();
      this.overlayVisible = false;
      this.renderer.setActiveCamera(this.previewCamera);
      this.renderer.orbitControls.enabled = false;
      this.applyOverlayVisibility();
      return;
    }
    this.overlayVisible = false;
    this.syncPreviewCameraTo(node);
    this.renderer.setActiveCamera(this.previewCamera);
    this.renderer.orbitControls.enabled = false;
    this.applyOverlayVisibility();
  }

  /** 无场景相机时的预览取景：从斜上方望向场景中心 */
  private applyDefaultPreviewPose(): void {
    const cam = this.previewCamera;
    cam.fov = 50;
    cam.near = 0.1;
    cam.far = 2000;
    cam.position.set(7, 5, 8);
    cam.lookAt(0, 0.6, 0);
    cam.updateProjectionMatrix();
  }

  /**
   * 编辑器辅助物显隐（与真实渲染无关的装饰）：
   * 网格、相机体、灯光的辅助球/框、gizmo、选择框。
   */
  private applyOverlayVisibility(): void {
    const vis = this.overlayVisible;
    this.renderer.scene.traverse((o) => {
      if (o.name === "__grid" || o.name === "__camBody" || o.name === "__camIcon") {
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
    this.helperSystem.setVisible(vis);
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
