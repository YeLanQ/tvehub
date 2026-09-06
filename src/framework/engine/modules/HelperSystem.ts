import * as THREE from "three";
import type { Node } from "../../prototype/Node";
import type { GraphLike, SceneChange } from "../../scene/SceneClient";
import { createNodeHelper } from "./helpers/createNodeHelper";
import type { HelperContext, NodeHelper } from "./helpers/types";

interface HelperEntry {
  node: Node;
  helper: NodeHelper;
}

/**
 * 编辑器 gizmo/辅助线系统（调度器）。
 *
 * 模块化职责：
 * - 持有一个独立于场景节点树的 helperRoot（world 空间定位，可整体显隐/拾取豁免）；
 * - 按 SceneGraph 事件维护 CameraNode/LightNode 的辅助线实例（增删/变换/属性）；
 * - 每帧 tick 轻量贴合世界变换，保证 gizmo 拖拽过程辅助线实时跟随；
 * - 不感知具体绘制内容，具体形状由 helpers/* 里的 NodeHelper 负责。
 */
export class HelperSystem {
  private readonly root: THREE.Group;
  private entries = new Map<string, HelperEntry>();

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
    // transform / properties / reparent → 同步形状与贴合世界变换
    const node = graph.get(c.nodeId);
    if (!node) return;
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
  }

  private clearAll(): void {
    for (const id of [...this.entries.keys()]) this.removeEntry(id);
  }
}
