import * as THREE from "three";
import type { LightNode } from "../../../prototype/nodes/LightNode";
import { PointLightNode } from "../../../prototype/nodes/PointLightNode";
import { SpotLightNode } from "../../../prototype/nodes/SpotLightNode";
import type { Node } from "../../../prototype/Node";
import {
  applyHelperWorld,
  type HelperContext,
  type NodeHelper,
} from "./types";

const ARROW_LENGTH = 2.2;
const CONE_LENGTH = 1.6;
const CONE_SEGMENTS = 20;
const RING_SEGMENTS = 24;

/**
 * 灯光辅助线（线框形式，不参与拾取），按灯光类型绘制：
 * - point       → 仅当 distance > 0 时绘制两个相互垂直的圆环（半径 = distance），
 *                  distance = 0（无限）时无线框
 * - directional → 沿灯光本地 -Z 的方向箭头
 * - spot        → 沿本地 -Z 的圆锥光束线框（角度随节点参数变化）
 * - ambient     → 无方向无范围，不绘制任何线框，仅保留图标
 * 颜色跟随灯光颜色实时更新。
 */
export class LightNodeHelper implements NodeHelper {
  readonly object: THREE.Group;
  private kindKey = "";
  private lineMat: THREE.LineBasicMaterial;
  private arrow: THREE.ArrowHelper | null = null;

  /** 点光范围圆环（随 distance 变化） */
  private rangeSeg: THREE.LineSegments | null = null;
  private rangeGeom: THREE.BufferGeometry | null = null;
  private rangeSig = "";

  /** 聚光灯锥形线 */
  private coneSeg: THREE.LineSegments | null = null;
  private coneGeom: THREE.BufferGeometry | null = null;
  private coneSig = "";

  private disposed = false;

  constructor() {
    this.lineMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
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
    if (light.lightKind === "point" && node instanceof PointLightNode) {
      this.updateRangeSphere(node.distance);
    } else if (light.lightKind === "spot" && node instanceof SpotLightNode) {
      this.updateSpotCone(node.angle);
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
    this.rangeSeg = null;
    this.rangeGeom = null;
    this.rangeSig = "";
    this.coneSeg = null;
    this.coneGeom = null;
    this.coneSig = "";

    if (kind === "point") {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
      const seg = new THREE.LineSegments(geom, this.lineMat);
      seg.frustumCulled = false;
      this.rangeSeg = seg;
      this.rangeGeom = geom;
      this.object.add(seg);
    } else if (kind === "directional") {
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
    } else if (kind === "spot") {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
      const seg = new THREE.LineSegments(geom, this.lineMat);
      seg.frustumCulled = false;
      this.coneSeg = seg;
      this.coneGeom = geom;
      this.object.add(seg);
    }
    // ambient：无方向、无范围，不绘制线框
  }

  /** 点光范围：distance>0 时绘制两个垂直圆环（半径=distance）；distance=0（无限）时清空 */
  private updateRangeSphere(distance: number): void {
    const radius = distance > 0 ? distance : 0;
    const sig = radius.toFixed(3);
    if (sig === this.rangeSig || !this.rangeSeg || !this.rangeGeom) return;
    this.rangeSig = sig;
    this.rangeGeom.dispose();

    if (radius <= 0) {
      this.rangeGeom = new THREE.BufferGeometry();
    } else {
      this.rangeGeom = buildRangeRings(radius, RING_SEGMENTS);
    }
    this.rangeSeg.geometry = this.rangeGeom;
  }

  /** 依据光束半角（度）更新锥形辅助线：顶点在原点，向 -Z 张开 */
  private updateSpotCone(angleDeg: number): void {
    const sig = angleDeg.toFixed(3);
    if (sig === this.coneSig || !this.coneSeg || !this.coneGeom) return;
    this.coneSig = sig;

    const angle = Math.max(0.5, Math.min(89, angleDeg));
    const radius = Math.tan((angle * Math.PI) / 180) * CONE_LENGTH;
    const n = CONE_SEGMENTS;
    const vertices = n * 4; // 环边 n 段 × 2 + 顶角连线 n 段 × 2
    const pos = new Float32Array(vertices * 3);
    const k = (i: number): number => i % n;
    let w = 0;
    const put = (a: THREE.Vector3, b: THREE.Vector3): void => {
      pos[w++] = a.x;
      pos[w++] = a.y;
      pos[w++] = a.z;
      pos[w++] = b.x;
      pos[w++] = b.y;
      pos[w++] = b.z;
    };
    const apex = new THREE.Vector3(0, 0, 0);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      pts.push(
        new THREE.Vector3(Math.cos(t) * radius, Math.sin(t) * radius, -CONE_LENGTH),
      );
    }
    for (let i = 0; i < n; i++) put(pts[k(i)], pts[k(i + 1)]);
    for (let i = 0; i < n; i++) put(apex, pts[i]);

    this.coneGeom.dispose();
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.computeBoundingSphere();
    this.coneGeom = geom;
    this.coneSeg.geometry = geom;
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
  }
}

/**
 * 生成两个相互垂直的圆环线框（不含球体网格）：
 * - 环 A：XZ 平面（水平环绕，y = 0）
 * - 环 B：XY 平面（垂直环绕，z = 0）
 * 每个环由 segments 条首尾相接的线段组成。
 */
function buildRangeRings(radius: number, segments: number): THREE.BufferGeometry {
  const count = segments * 2; // 每环 segments 段 × 2 顶点
  const pos = new Float32Array(count * 2 * 3);
  let w = 0;
  const put = (a: THREE.Vector3, b: THREE.Vector3): void => {
    pos[w++] = a.x;
    pos[w++] = a.y;
    pos[w++] = a.z;
    pos[w++] = b.x;
    pos[w++] = b.y;
    pos[w++] = b.z;
  };
  const angle = (i: number): number => ((i % segments) / segments) * Math.PI * 2;
  // 环 A：XZ 平面（水平环绕，y = 0）
  for (let i = 0; i < segments; i++) {
    const a = angle(i);
    const b = angle(i + 1);
    put(
      new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius),
      new THREE.Vector3(Math.cos(b) * radius, 0, Math.sin(b) * radius),
    );
  }
  // 环 B：XY 平面（垂直环绕，z = 0）
  for (let i = 0; i < segments; i++) {
    const a = angle(i);
    const b = angle(i + 1);
    put(
      new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0),
      new THREE.Vector3(Math.cos(b) * radius, Math.sin(b) * radius, 0),
    );
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.computeBoundingSphere();
  return geom;
}
