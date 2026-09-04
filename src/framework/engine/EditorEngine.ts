import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

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
import { Node } from "../prototype/Node";
import {
  CameraNode,
  LightNode,
  MeshNode,
  type GeometryKind,
} from "../prototype/derived/Primitives";
import type { JsonRecord, Vec3 } from "../prototype/types";

export type GizmoMode = "translate" | "rotate" | "scale";

export interface EditorEvents extends Record<string, unknown> {
  "graph:changed": SceneChange;
  "select:changed": { nodeId: string | null };
  "gizmo:state": { mode: GizmoMode; space: "local" | "world" };
}

function snapshotTransform(node: Node): TransformSnapshot {
  return {
    position: { ...node.transform.position },
    rotation: { ...node.transform.rotation },
    scale: { ...node.transform.scale },
  };
}

function sameTransform(a: TransformSnapshot, b: TransformSnapshot): boolean {
  const EPS = 1e-6;
  return (
    Math.abs(a.position.x - b.position.x) < EPS &&
    Math.abs(a.position.y - b.position.y) < EPS &&
    Math.abs(a.position.z - b.position.z) < EPS &&
    Math.abs(a.rotation.x - b.rotation.x) < EPS &&
    Math.abs(a.rotation.y - b.rotation.y) < EPS &&
    Math.abs(a.rotation.z - b.rotation.z) < EPS &&
    Math.abs(a.scale.x - b.scale.x) < EPS &&
    Math.abs(a.scale.y - b.scale.y) < EPS &&
    Math.abs(a.scale.z - b.scale.z) < EPS
  );
}

/**
 * 编辑器引擎（框架层协调者）。
 * 组合 SceneGraph(数据) + NodeFactory(工厂) + CommandStack(命令/栈)，
 * 将数据原型镜像到 Three.js 世界，驱动拾取与 Gizmo。
 * 框架保持对 three 的最小感知：仅本文件与 derived 渲染映射依赖 three。
 */
export class EditorEngine {
  readonly graph = new SceneGraph();
  readonly factory: NodeFactory;
  readonly history = new CommandStack();
  readonly events = new EventBus<EditorEvents>();

  readonly scene = new THREE.Scene();
  camera!: THREE.PerspectiveCamera;
  renderer!: THREE.WebGLRenderer;
  private orbit!: OrbitControls;
  private gizmo!: TransformControls;
  private gizmoHelper!: THREE.Object3D;
  private selectionBox: THREE.BoxHelper | null = null;

  private objectMap = new Map<string, THREE.Object3D>();
  private container!: HTMLElement;
  private raf = 0;
  private resizeObs?: ResizeObserver;
  private dragging = false;
  private dragStart: TransformSnapshot | null = null;
  private disposed = false;

  selectedId: string | null = null;
  gizmoMode: GizmoMode = "translate";
  gizmoSpace: "local" | "world" = "local";

  constructor() {
    this.factory = createNodeFactory(createDefaultRegistry());
  }

  // ===================== 生命周期 =====================

  mount(container: HTMLElement): void {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.position = "absolute";
    this.renderer.domElement.style.top = "0";
    this.renderer.domElement.style.left = "0";
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x141414);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    this.camera.position.set(6, 6, 9);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.7);
    this.gizmoHelper = this.resolveGizmoHelper();
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener("dragging-changed", this.onDraggingChanged);
    this.gizmo.addEventListener("objectChange", this.onGizmoObjectChange);

    const grid = new THREE.GridHelper(40, 40, 0x3f3f3f, 0x262626);
    grid.name = "__grid";
    this.scene.add(grid);

    this.graph.onChange((c) => this.onGraphChange(c));
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.resize();
    this.loop();
    logger.info("EditorEngine mounted");
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObs?.disconnect();
    this.gizmo?.removeEventListener("dragging-changed", this.onDraggingChanged);
    this.gizmo?.removeEventListener("objectChange", this.onGizmoObjectChange);
    if (this.renderer) {
      this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
      this.renderer.domElement.parentElement?.removeChild(this.renderer.domElement);
      this.renderer.dispose();
    }
    this.objectMap.forEach((o) => disposeObject3D(o));
    this.objectMap.clear();
  }

  private resolveGizmoHelper(): THREE.Object3D {
    const maybe = this.gizmo as unknown as { getHelper?: () => THREE.Object3D };
    return maybe.getHelper ? maybe.getHelper() : (this.gizmo as unknown as THREE.Object3D);
  }

  private resize = (): void => {
    if (!this.renderer) return;
    const w = this.container.clientWidth || 512;
    const h = this.container.clientHeight || 512;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    this.orbit?.update();
    if (this.selectedId) this.selectionBox?.update();
    if (this.renderer) this.renderer.render(this.scene, this.camera);
  };

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
    if (id) {
      const obj = this.objectMap.get(id);
      if (obj) {
        this.gizmo.attach(obj);
        if (!this.selectionBox) {
          this.selectionBox = new THREE.BoxHelper(obj as THREE.Mesh, 0x757575);
          this.scene.add(this.selectionBox);
        } else {
          this.selectionBox.setFromObject(obj);
        }
        (this.selectionBox.material as THREE.Material).depthTest = false;
        this.selectionBox.renderOrder = 999;
        this.selectionBox.update();
      }
    } else {
      this.gizmo.detach();
      this.clearSelectionBox();
    }
    this.events.emit("select:changed", { nodeId: this.selectedId });
  }

  private clearSelectionBox(): void {
    if (this.selectionBox) {
      this.scene.remove(this.selectionBox);
      this.selectionBox.geometry.dispose();
      (this.selectionBox.material as THREE.Material).dispose();
      this.selectionBox = null;
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.renderer || this.dragging) return;
    if ((e.target as HTMLElement) !== this.renderer.domElement) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const hit = this.pickAt(e.clientX - rect.left, e.clientY - rect.top);
    this.select(hit);
  };

  private pickAt(px: number, py: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      (px / rect.width) * 2 - 1,
      -(py / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const roots = [...this.objectMap.values()];
    const hits = ray.intersectObjects(roots, true);
    for (const h of hits) {
      const owner = findNodeOwner(h.object, this.objectMap);
      if (owner) return owner;
    }
    return null;
  }

  // ===================== 数据 → Three 同步 =====================

  rebuildAll(): void {
    this.objectMap.forEach((o) => {
      o.parent?.remove(o);
      disposeObject3D(o);
    });
    this.objectMap.clear();
    this.clearSelectionBox();
    this.graph.all().forEach((n) => this.createObjectOnly(n));
    this.graph.all().forEach((n) => this.attachParent(n));
    this.graph.all().forEach((n) => this.refreshNode(n));
    this.gizmo?.detach();
    this.selectedId = this.selectedId && this.graph.has(this.selectedId) ? this.selectedId : null;
    if (this.selectedId) this.select(this.selectedId);
  }

  private onGraphChange(c: SceneChange): void {
    const node = this.graph.get(c.nodeId);
    switch (c.kind) {
      case "add":
        if (node) this.syncRecursively(node);
        break;
      case "remove":
        this.disposeMapped(c.nodeId);
        break;
      case "reparent":
        if (node) this.remount(node);
        break;
      case "transform":
        if (node) this.applyTransform(node);
        break;
      case "rename":
        if (node) this.renameObject(node);
        break;
      case "properties":
        if (node) this.refreshNode(node);
        break;
      default:
        break;
    }
    this.events.emit("graph:changed", c);
  }

  private createObjectOnly(node: Node): THREE.Object3D {
    let obj: THREE.Object3D;
    if (node instanceof MeshNode) obj = new THREE.Mesh();
    else if (node instanceof LightNode) obj = new THREE.Group();
    else if (node instanceof CameraNode) obj = new THREE.Group();
    else obj = new THREE.Group();
    obj.name = node.name;
    obj.userData.nodeId = node.id;
    obj.userData.nodeKind = node.typeKey;
    this.objectMap.set(node.id, obj);
    return obj;
  }

  private ensureObject(node: Node): void {
    if (!this.objectMap.has(node.id)) this.createObjectOnly(node);
  }

  /** 确保节点自身对象已建、父挂载正确、且子对象都已递归 */
  private syncRecursively(node: Node): void {
    this.ensureObject(node);
    this.attachParent(node);
    node.childIds.forEach((cid) => {
      const child = this.graph.get(cid);
      if (child) this.syncRecursively(child);
    });
    this.refreshNode(node);
  }

  private attachParent(node: Node): void {
    const obj = this.objectMap.get(node.id);
    if (!obj) return;
    const newParent = node.parentId ? this.objectMap.get(node.parentId) : undefined;
    const host = newParent ?? this.scene;
    if (obj.parent !== host) host.add(obj);
  }

  private disposeMapped(id: string): void {
    const subIds = collectSubtree(this.graph, id);
    subIds.forEach((sid) => {
      const obj = this.objectMap.get(sid);
      if (obj) {
        obj.parent?.remove(obj);
        disposeObject3D(obj);
        this.objectMap.delete(sid);
      }
    });
  }

  private remount(node: Node): void {
    this.attachParent(node);
    this.renameObject(node);
  }

  private renameObject(node: Node): void {
    const obj = this.objectMap.get(node.id);
    if (obj) obj.name = node.name;
  }

  private applyTransform(node: Node): void {
    const obj = this.objectMap.get(node.id);
    if (!obj) return;
    obj.position.set(node.transform.position.x, node.transform.position.y, node.transform.position.z);
    obj.rotation.set(node.transform.rotation.x, node.transform.rotation.y, node.transform.rotation.z);
    obj.scale.set(node.transform.scale.x, node.transform.scale.y, node.transform.scale.z);
  }

  private refreshNode(node: Node): void {
    const obj = this.objectMap.get(node.id);
    if (!obj) return;
    obj.visible = node.visible && node.active;
    if (node instanceof MeshNode) this.refreshMesh(node, obj as THREE.Mesh);
    else if (node instanceof LightNode) this.refreshLight(node, obj);
    else if (node instanceof CameraNode) this.refreshCamera(node, obj);
    this.applyTransform(node);
  }

  private refreshMesh(mesh: MeshNode, obj: THREE.Mesh): void {
    const geom = buildGeometry(mesh.geometry, mesh.size);
    obj.geometry.dispose();
    obj.geometry = geom;
    let mat = obj.material as THREE.MeshStandardMaterial;
    if (!(mat instanceof THREE.MeshStandardMaterial)) {
      mat = new THREE.MeshStandardMaterial();
      obj.material = mat;
    }
    mat.color.setHex(mesh.color);
    mat.metalness = mesh.metalness;
    mat.roughness = mesh.roughness;
    mat.emissive.setHex(mesh.emissive);
    mat.wireframe = mesh.wireframe;
    mat.needsUpdate = true;
  }

  private refreshLight(light: LightNode, obj: THREE.Object3D): void {
    obj.children
      .slice()
      .filter((c) => (c.userData as { lamp?: boolean }).lamp)
      .forEach((c) => {
        obj.remove(c);
        disposeObject3D(c);
      });
    const lamp = new THREE.Group();
    lamp.userData.lamp = true;
    if (light.lightKind === "point") {
      lamp.add(new THREE.PointLight(light.lightColor, light.intensity));
      lamp.add(new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), emissiveMat(light.lightColor)));
    } else if (light.lightKind === "directional") {
      const dl = new THREE.DirectionalLight(light.lightColor, light.intensity);
      dl.castShadow = light.castShadow;
      lamp.add(dl);
      lamp.add(new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), emissiveMat(light.lightColor)));
    } else {
      lamp.add(new THREE.AmbientLight(light.lightColor, light.intensity));
    }
    obj.add(lamp);
  }

  private refreshCamera(node: CameraNode, obj: THREE.Object3D): void {
    let body = obj.children.find((c) => c.name === "__camBody");
    if (!body) {
      body = new THREE.Mesh();
      body.name = "__camBody";
      obj.add(body);
    }
    const mesh = body as THREE.Mesh;
    const geom = new THREE.BoxGeometry(0.7, 0.5, 1.0);
    mesh.geometry.dispose();
    mesh.geometry = geom;
    mesh.material = emissiveMat(node.isEditorCamera ? 0x44aaff : 0xcccccc);
  }

  // ===================== Gizmo =====================

  setGizmoMode(mode: GizmoMode): void {
    this.gizmoMode = mode;
    this.gizmo.setMode(mode);
    this.events.emit("gizmo:state", { mode, space: this.gizmoSpace });
  }

  setGizmoSpace(space: "local" | "world"): void {
    this.gizmoSpace = space;
    this.gizmo.setSpace(space);
    this.events.emit("gizmo:state", { mode: this.gizmoMode, space });
  }

  private onDraggingChanged = (e: { value: unknown }): void => {
    const val = !!e.value;
    this.dragging = val;
    this.orbit.enabled = !val;
    if (val) {
      this.dragStart = this.selectedId ? snapshotTransform(this.graph.get(this.selectedId)!) : null;
    } else {
      this.commitDrag();
    }
  };

  private onGizmoObjectChange = (): void => {
    if (!this.selectedId) return;
    // 只读视图：拖动过程仅由 TransformControls 驱动 Three 对象（objectMap 镜像）做预览，
    // 不写 model（node.transform）、不发 graph:changed；松手后经 TransformCommand 落地。
    this.selectionBox?.update();
  };

  private commitDrag(): void {
    const before = this.dragStart;
    const id = this.selectedId;
    this.dragStart = null;
    if (!id || !before) return;
    const obj = this.objectMap.get(id);
    const node = this.graph.get(id);
    if (!obj || !node) return;
    const after: TransformSnapshot = {
      position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
      rotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z },
      scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
    };
    if (sameTransform(before, after)) return;
    // 视口变换本质是一条 diff 命令：记录拖动前后差异，走命令栈（可撤销/重做）
    const cmd = new TransformCommand(this.graph, id, after);
    cmd.setBefore(before);
    this.run(cmd);
  }

  getTransform(id: string): TransformSnapshot | null {
    const node = this.graph.get(id);
    return node ? snapshotTransform(node) : null;
  }

  getSelectedNode(): Node | undefined {
    return this.selectedId ? this.graph.get(this.selectedId) : undefined;
  }
}

// ===================== 无状态辅助 =====================

function applySpawnOffset(node: Node): void {
  const r = () => (Math.random() - 0.5) * 3;
  node.transform.setPosition(r(), 0.5 + Math.random(), r());
}

function collectSubtree(graph: SceneGraph, id: string): string[] {
  const out: string[] = [];
  const walk = (cur: string) => {
    out.push(cur);
    graph.childrenOf(cur).forEach((c) => walk(c.id));
  };
  if (graph.has(id)) walk(id);
  return out;
}

function findNodeOwner(obj: THREE.Object3D, map: Map<string, THREE.Object3D>): string | null {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (cur.userData?.nodeId && map.get(cur.userData.nodeId as string) === cur) {
      return cur.userData.nodeId as string;
    }
    cur = cur.parent;
  }
  return null;
}

function buildGeometry(kind: GeometryKind, size: Vec3): THREE.BufferGeometry {
  const x = Math.max(0.01, size.x);
  const y = Math.max(0.01, size.y);
  const z = Math.max(0.01, size.z);
  switch (kind) {
    case "sphere":
      return new THREE.SphereGeometry(x / 2, 32, 24);
    case "plane":
      return new THREE.PlaneGeometry(x, z);
    case "cylinder":
      return new THREE.CylinderGeometry(x / 2, x / 2, y, 24);
    default:
      return new THREE.BoxGeometry(x, y, z);
  }
}

function emissiveMat(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, wireframe: false });
}


function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) mat.dispose();
  });
}
