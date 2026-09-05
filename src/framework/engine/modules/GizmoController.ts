import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { TransformSnapshot } from "../../command/commands";
import { radToDeg } from "../../prototype/types";
import { sameTransform } from "./utils";

export type GizmoMode = "translate" | "rotate" | "scale";

export class GizmoController {
  readonly gizmo: TransformControls;
  private gizmoHelper!: THREE.Object3D;
  private selectionBox: THREE.BoxHelper | null = null;

  private mode: GizmoMode = "translate";
  private space: "local" | "world" = "local";
  private dragging = false;
  private dragStart: TransformSnapshot | null = null;
  private selectedId: string | null = null;
  private objectMap: Map<string, THREE.Object3D> = new Map();

  private onDraggingChangedCb?: (val: boolean) => void;
  private onGizmoObjectChangeCb?: () => void;

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.gizmo = new TransformControls(camera, domElement);
    this.gizmo.setSize(0.7);
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
      if (obj) {
        this.gizmo.attach(obj);
        if (!this.selectionBox) {
          this.selectionBox = new THREE.BoxHelper(obj as THREE.Mesh, 0x757575);
          obj.parent?.add(this.selectionBox);
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
  }

  private clearSelectionBox(): void {
    if (this.selectionBox) {
      this.selectionBox.parent?.remove(this.selectionBox);
      this.selectionBox.geometry.dispose();
      (this.selectionBox.material as THREE.Material).dispose();
      this.selectionBox = null;
    }
  }

  updateSelectionBox(): void {
    this.selectionBox?.update();
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
    this.clearSelectionBox();
  }
}