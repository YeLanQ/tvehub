import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { TransformSnapshot } from "../../scene/SceneClient";
import { radToDeg } from "../../prototype/types";
import { sameTransform } from "./utils";

export type GizmoMode = "translate" | "rotate" | "scale";

export class GizmoController {
  readonly gizmo: TransformControls;
  private gizmoHelper!: THREE.Object3D;

  private mode: GizmoMode = "translate";
  private space: "local" | "world" = "local";
  private dragging = false;
  private dragStart: TransformSnapshot | null = null;
  private selectedId: string | null = null;
  private objectMap: Map<string, THREE.Object3D> = new Map();

  private onDraggingChangedCb?: (val: boolean) => void;
  private onGizmoObjectChangeCb?: () => void;
  /** UI 2D 模式（布局视口）：变换工具只显示 UI 语义轴（见 setUI2DMode） */
  private ui2d = false;

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.gizmo = new TransformControls(camera, domElement);
    this.gizmo.setSize(0.7);
    this.gizmo.setSpace(this.space);
    this.gizmoHelper = this.resolveGizmoHelper();
    this.gizmo.addEventListener("dragging-changed", this.onDraggingChanged);
    this.gizmo.addEventListener("objectChange", this.onGizmoObjectChange);
  }

  private resolveGizmoHelper(): THREE.Object3D {
    const maybe = this.gizmo as unknown as { getHelper?: () => THREE.Object3D };
    return maybe.getHelper ? maybe.getHelper() : (this.gizmo as unknown as THREE.Object3D);
  }

  attachToScene(scene: THREE.Scene): void {
    scene.add(this.gizmoHelper);
  }

  /** gizmo 顶层渲染对象（UI 布局视图独占渲染时保持可见的编辑辅助） */
  getGizmoHelper(): THREE.Object3D {
    return this.gizmoHelper;
  }

  detachFromScene(scene: THREE.Scene): void {
    scene.remove(this.gizmoHelper);
  }

  setCallbacks(callbacks: {
    onDraggingChanged?: (val: boolean) => void;
    onGizmoObjectChange?: () => void;
  }): void {
    this.onDraggingChangedCb = callbacks.onDraggingChanged;
    this.onGizmoObjectChangeCb = callbacks.onGizmoObjectChange;
  }

  private onDraggingChanged = (e: { value: unknown }): void => {
    const val = !!e.value;
    this.dragging = val;
    this.onDraggingChangedCb?.(val);
    if (val) {
      this.dragStart = this.selectedId ? this.getTransformSnapshot() : null;
    } else {
      this.commitDrag();
    }
  };

  private onGizmoObjectChange = (): void => {
    this.onGizmoObjectChangeCb?.();
  };

  setMode(mode: GizmoMode): void {
    this.mode = mode;
    this.gizmo.setMode(mode);
    // UI 2D 模式下模式切换后重取轴（平移/缩放 = X/Y，旋转 = Z）
    this.applyUI2DAxes();
  }

  /**
   * UI 2D 模式（布局视口）：变换工具按 UI 语义显示——平移/缩放只显示 X/Y 轴
   * （UI 上下左右定位），旋转只显示 Z 轴（UI 旋转即绕 Z），全部平面手柄关闭
   * （叠在 Widget 中心的方块很杂乱），手柄加大便于点抓；退出恢复 3D 全轴。
   */
  setUI2DMode(active: boolean): void {
    if (this.ui2d === active) return;
    this.ui2d = active;
    this.gizmo.setSize(active ? 1.2 : 0.7);
    this.applyUI2DAxes();
  }

  private applyUI2DAxes(): void {
    const g = this.gizmo as unknown as Record<string, boolean>;
    if (!this.ui2d) {
      g.showX = true;
      g.showY = true;
      g.showZ = true;
      g.showXY = true;
      g.showYZ = true;
      g.showXZ = true;
      return;
    }
    if (this.mode === "rotate") {
      g.showX = false;
      g.showY = false;
      g.showZ = true;
    } else {
      g.showX = true;
      g.showY = true;
      g.showZ = false;
    }
    g.showXY = false;
    g.showYZ = false;
    g.showXZ = false;
  }

  /** 预览等编辑器场景下禁用并隐藏变换工具 */
  setEditorEnabled(enabled: boolean): void {
    this.gizmo.enabled = enabled;
    this.gizmoHelper.visible = enabled;
  }

  setSpace(space: "local" | "world"): void {
    this.space = space;
    this.gizmo.setSpace(space);
  }

  getMode(): GizmoMode {
    return this.mode;
  }

  getSpace(): "local" | "world" {
    return this.space;
  }

  isDragging(): boolean {
    return this.dragging;
  }

  select(
    id: string | null,
    objectMap: Map<string, THREE.Object3D>
  ): void {
    this.selectedId = id;
    this.objectMap = objectMap;
    if (id) {
      const obj = objectMap.get(id);
      if (obj) this.gizmo.attach(obj);
    } else {
      this.gizmo.detach();
    }
  }

  private getTransformSnapshot(): TransformSnapshot | null {
    const obj = this.selectedId ? this.objectMap.get(this.selectedId) ?? null : null;
    if (!obj) return null;
    const rotation = radToDeg({ x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z });
    return {
      position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
      rotation,
      scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
    };
  }

  private commitDrag(): void {
    const before = this.dragStart;
    const id = this.selectedId;
    this.dragStart = null;
    if (!id || !before) return;
    const obj = this.objectMap.get(id) ?? null;
    if (!obj) return;
    const rotation = radToDeg({ x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z });
    const after: TransformSnapshot = {
      position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
      rotation,
      scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
    };
    if (sameTransform(before, after)) return;
    this.onCommitTransform?.(id, after, before);
  }

  onCommitTransform?: (id: string, after: TransformSnapshot, before: TransformSnapshot) => void;

  dispose(): void {
    this.gizmo.removeEventListener("dragging-changed", this.onDraggingChanged);
    this.gizmo.removeEventListener("objectChange", this.onGizmoObjectChange);
  }
}