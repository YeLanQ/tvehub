import * as THREE from "three";
import type { LightNode } from "../../../prototype/nodes/LightNode";
import type { Node } from "../../../prototype/Node";
import {
  applyHelperWorld,
  type HelperContext,
  type NodeHelper,
} from "./types";

const ARROW_LENGTH = 2.2;

/**
 * 灯光辅助线（线框形式，不参与拾取）：
 * - point       → 点光球体线框（半径约 0.45）
 * - directional → 沿灯光本地 -Z 的方向箭头
 * - ambient     → 环境光小二十面体线框
 * 颜色跟随灯光颜色实时更新。
 */
export class LightNodeHelper implements NodeHelper {
  readonly object: THREE.Group;
  private kindKey = "";
  private lineMat: THREE.LineBasicMaterial;
  private arrow: THREE.ArrowHelper | null = null;
  /** WireframeGeometry 的源几何（Sphere/Icosahedron），单独持有以便释放 */
  private baseGeoms: THREE.BufferGeometry[] = [];
  private disposed = false;

  constructor() {
    this.lineMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
    });
    this.object = new THREE.Group();
    this.object.name = "__helper_light";
    this.object.matrixAutoUpdate = false;
  }

  sync(node: Node, world: THREE.Object3D | undefined, _ctx: HelperContext): void {
    const light = node as LightNode;
    if (light.lightKind !== this.kindKey) {
      this.rebuild(light.lightKind);
      this.kindKey = light.lightKind;
    }
    this.lineMat.color.setHex(light.lightColor);
    if (this.arrow) this.arrow.setColor(light.lightColor);
    applyHelperWorld(this.object, node, world);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearChildren();
    this.lineMat.dispose();
  }

  private rebuild(kind: LightNode["lightKind"]): void {
    this.clearChildren();
    this.arrow = null;
    if (kind === "point") {
      const base = new THREE.SphereGeometry(0.45, 16, 10);
      this.baseGeoms.push(base);
      this.object.add(new THREE.LineSegments(new THREE.WireframeGeometry(base), this.lineMat));
    } else if (kind === "directional") {
      // 箭头本体（杆 + 锥头）由 ArrowHelper 自管理几何/材质
      const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 0, -1),
        new THREE.Vector3(),
        ARROW_LENGTH,
        0xffffff,
        0.45,
        0.3,
      );
      this.arrow = arrow;
      this.object.add(arrow);
    } else {
      // ambient
      const base = new THREE.IcosahedronGeometry(0.6, 1);
      this.baseGeoms.push(base);
      this.object.add(new THREE.LineSegments(new THREE.WireframeGeometry(base), this.lineMat));
    }
  }

  private clearChildren(): void {
    const kids = [...this.object.children];
    for (const k of kids) {
      this.object.remove(k);
      // 释放几何与独占材质；lineMat 为共享材质，由本类统一释放，避免重复 dispose
      k.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m !== this.lineMat && m.dispose());
        else if (mat && mat !== this.lineMat) mat.dispose();
      });
    }
    this.baseGeoms.forEach((g) => g.dispose());
    this.baseGeoms = [];
  }
}
