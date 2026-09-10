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

/** 平行光：方向箭头长度（世界单位） */
const ARROW_LENGTH = 2.2;
/** 点光范围环的分段数 */
const RING_SEGMENTS = 24;
/** 聚光底圆的分段数 */
const CIRCLE_SEGMENTS = 32;

/**
 * 灯光辅助线（线框形式，不参与拾取），按灯光类型绘制，全部跟随节点参数实时变化：
 * - point       → 两个相互垂直的范围圆环（半径 = Range；Range=0 无限远时收拢隐藏）；
 * - directional → 沿灯光本地 -Z 的方向箭头；
 * - spot        → 光锥 = 底圆 + 四条斜线：长度跟随 Range（0 = 收拢隐藏），
 *                 底圆半径 = tan(Spot Angle) × 长度。
 * 颜色跟随灯光颜色实时更新；显示时机由 HelperSystem 门控（仅选中该灯时可见）。
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
      this.updatePointRange(node.distance);
    } else if (light.lightKind === "spot" && node instanceof SpotLightNode) {
      this.updateSpotCone(node.angle, node.distance);
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
    // ambient：无方向无范围，不绘制线框
  }

  /** 点光范围环：半径跟随 Range；Range=0（无限远）时收拢隐藏（不弹回示意尺寸） */
  private updatePointRange(distance: number): void {
    const radius = Math.max(0, distance);
    const sig = radius.toFixed(3);
    if (sig === this.rangeSig || !this.rangeSeg || !this.rangeGeom) return;
    this.rangeSig = sig;
    this.rangeGeom.dispose();
    this.rangeGeom = radius > 0 ? buildRangeRings(radius, RING_SEGMENTS) : new THREE.BufferGeometry();
    this.rangeSeg.geometry = this.rangeGeom;
  }

  /** 聚光光锥：长度跟随 Range（0 = 收拢隐藏），底圆半径 = tan(Spot Angle) × 长度 */
  private updateSpotCone(angleDeg: number, distance: number): void {
    const length = Math.max(0, distance);
    const sig = `${angleDeg.toFixed(3)}|${length.toFixed(3)}`;
    if (sig === this.coneSig || !this.coneSeg || !this.coneGeom) return;
    this.coneSig = sig;
    this.coneGeom.dispose();
    this.coneGeom = length > 0 ? buildSpotCone(angleDeg, length) : new THREE.BufferGeometry();
    this.coneSeg.geometry = this.coneGeom;
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

/**
 * 聚光光锥线框：底圆 + 四条斜线。
 * - 底圆：CIRCLE_SEGMENTS 段，位于本地 -Z 的 length 处，半径 = tan(半角) × length；
 * - 四条斜线：顶点（原点）连到底圆 0°/90°/180°/270° 四个点。
 */
function buildSpotCone(angleDeg: number, length: number): THREE.BufferGeometry {
  const angle = Math.max(0.5, Math.min(89, angleDeg));
  const radius = Math.tan((angle * Math.PI) / 180) * length;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const t = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(t) * radius, Math.sin(t) * radius, -length));
  }
  const pos: number[] = [];
  const put = (a: THREE.Vector3, b: THREE.Vector3): void => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
  };
  // 底圆
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    put(pts[i], pts[(i + 1) % CIRCLE_SEGMENTS]);
  }
  // 四条斜线（0°/90°/180°/270°）
  put(new THREE.Vector3(0, 0, 0), new THREE.Vector3(radius, 0, -length));
  put(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, radius, -length));
  put(new THREE.Vector3(0, 0, 0), new THREE.Vector3(-radius, 0, -length));
  put(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -radius, -length));

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geom.computeBoundingSphere();
  return geom;
}
