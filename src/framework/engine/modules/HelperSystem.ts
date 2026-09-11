import * as THREE from "three";
import type { Node } from "../../prototype/Node";
import type { GraphLike, SceneChange } from "../../scene/SceneClient";
import { ColliderNodeHelper } from "./helpers/ColliderNodeHelper";
import { LightNodeHelper } from "./helpers/LightNodeHelper";
import { CameraNodeHelper } from "./helpers/CameraNodeHelper";
import { createNodeHelper } from "./helpers/createNodeHelper";
import type { HelperContext, NodeHelper } from "./helpers/types";

interface HelperEntry {
  node: Node;
  helper: NodeHelper;
}

/**
 * 选中可见的辅助线类型（只在节点被选中时显示，未选中一律隐藏）：
 * - 碰撞体线框；
 * - 灯光辅助线/方向线（范围环/光锥/方向箭头，常驻会遮挡场景）；
 * - 相机视锥 + 视向线（同为线框绘制器，常驻同样遮挡视线）。
 * sync 自身不管理可见性的两类（灯光/相机）直接按选中集开关；碰撞体线框的 sync
 * 会按组件启停自设 visible，门控时只在其未选中时强制隐藏（见 syncEntry）。
 */
function isSelectionGatedHelper(helper: NodeHelper): boolean {
  return (
    helper instanceof ColliderNodeHelper ||
    helper instanceof LightNodeHelper ||
    helper instanceof CameraNodeHelper
  );
}

/**
 * 编辑器 gizmo/辅助线系统（调度器）。
 *
 * 模块化职责：
 * - 持有一个独立于场景节点树的 helperRoot（world 空间定位，可整体显隐/拾取豁免）；
 * - 按 SceneGraph 事件维护 CameraNode/LightNode 的辅助线实例（增删/变换/属性）；
 * - 碰撞体线框只在节点选中时显示（setSelectedIds 由引擎选择变化时调用）；
 * - 每帧 tick 轻量贴合世界变换，保证 gizmo 拖拽过程辅助线实时跟随；
 * - 不感知具体绘制内容，具体形状由 helpers/* 里的 NodeHelper 负责。
 */
export class HelperSystem {
  private readonly root: THREE.Group;
  private entries = new Map<string, HelperEntry>();
  /** 当前选中节点（碰撞体线框仅对这些节点显示；空 = 无选中） */
  private selectedIds = new Set<string>();

  constructor(scene: THREE.Scene, private readonly ctx: HelperContext) {
    this.root = new THREE.Group();
    this.root.name = "__editor_helpers";
    this.root.matrixAutoUpdate = false;
    this.root.matrix.identity();
    scene.add(this.root);
  }

  getVisible(): boolean {
    return this.root.visible;
  }

  /** 编辑器辅助物整体显隐（预览渲染时隐藏） */
  setVisible(v: boolean): void {
    this.root.visible = v;
  }

  /** 全量重建（场景替换/加载后调用） */
  rebuildAll(graph: GraphLike, objectMap: Map<string, THREE.Object3D>): void {
    this.clearAll();
    for (const node of graph.all()) {
      if (createNodeHelper(node)) this.ensureEntry(node, objectMap);
    }
  }

  /** 图事件增量维护 */
  onGraphChange(c: SceneChange, graph: GraphLike, objectMap: Map<string, THREE.Object3D>): void {
    if (c.kind === "add") {
      const node = graph.get(c.nodeId);
      if (node) this.ensureEntry(node, objectMap);
      return;
    }
    if (c.kind === "remove") {
      this.removeEntry(c.nodeId);
      return;
    }
    // transform / properties / reparent → 需要时补建（如节点首次挂上碰撞体组件）
    const node = graph.get(c.nodeId);
    if (!node) return;
    if (!this.entries.has(node.id)) this.ensureEntry(node, objectMap);
    const entry = this.entries.get(node.id);
    if (entry) this.syncEntry(entry, objectMap.get(node.id));
  }

  /** 渲染循环内每帧调用：让辅助线实时贴合 gizmo 拖拽等直接作用于 Object3D 的变换 */
  tick(objectMap: Map<string, THREE.Object3D>): void {
    if (!this.root.visible) return;
    for (const entry of this.entries.values()) {
      this.syncEntry(entry, objectMap.get(entry.node.id));
    }
  }

  /**
   * 选中集变化（引擎选择变化时调用）：选中可见的辅助线（碰撞体线框、灯光
   * 辅助线/方向线）只对选中节点显示。立即切换显隐（不等下一帧 tick）。
   */
  setSelectedIds(ids: string[]): void {
    this.selectedIds = new Set(ids);
    for (const entry of this.entries.values()) {
      if (isSelectionGatedHelper(entry.helper)) {
        entry.helper.object.visible = this.selectedIds.has(entry.node.id);
      }
    }
  }

  dispose(): void {
    this.clearAll();
    this.root.parent?.remove(this.root);
  }

  private ensureEntry(node: Node, objectMap: Map<string, THREE.Object3D>): void {
    if (this.entries.has(node.id)) return;
    const helper = createNodeHelper(node);
    if (!helper) return;
    this.entries.set(node.id, { node, helper });
    this.root.add(helper.object);
    this.syncEntry({ node, helper }, objectMap.get(node.id));
  }

  private removeEntry(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.root.remove(entry.helper.object);
    entry.helper.dispose();
  }

  private syncEntry(entry: HelperEntry, obj: THREE.Object3D | undefined): void {
    entry.helper.sync(entry.node, obj, this.ctx);
    // 选中可见的辅助线在此门控（未选中的保持同步，选中即现、数据变化照常重建）：
    // - 碰撞体线框：helper.sync 会按组件启停自设 visible，这里只在其未选中时强制隐藏；
    // - 灯光/相机辅助线：sync 不管可见性，直接按选中集开关。
    if (entry.helper instanceof ColliderNodeHelper) {
      if (!this.selectedIds.has(entry.node.id)) entry.helper.object.visible = false;
    } else if (entry.helper instanceof LightNodeHelper || entry.helper instanceof CameraNodeHelper) {
      entry.helper.object.visible = this.selectedIds.has(entry.node.id);
    }
  }

  private clearAll(): void {
    for (const id of [...this.entries.keys()]) this.removeEntry(id);
  }
}
