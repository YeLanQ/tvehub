import * as THREE from "three";
import type { CameraNode } from "../../../prototype/nodes/CameraNode";
import type { Node } from "../../../prototype/Node";
import {
  applyHelperWorld,
  type HelperContext,
  type NodeHelper,
} from "./types";

const FRUSTUM_COLOR = 0x55bbff;

/**
 * 相机辅助线：从相机位置沿其 -Z（three 相机观察方向）绘制的近/远裁剪视锥线框。
 * 近/远平面尺寸由 fov / near / far / 视口宽高比推导，纯线框装饰，不参与拾取。
 */
export class CameraNodeHelper implements NodeHelper {
  readonly object: THREE.Group;
  private frustum: THREE.LineSegments;
  private frustumGeom: THREE.BufferGeometry;
  private material: THREE.LineBasicMaterial;
  private signature = "";
  private disposed = false;

  constructor() {
    this.frustumGeom = new THREE.BufferGeometry();
    this.frustumGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(24 * 3), 3),
    );
    this.material = new THREE.LineBasicMaterial({
      color: FRUSTUM_COLOR,
      transparent: true,
      opacity: 0.85,
    });
    this.frustum = new THREE.LineSegments(this.frustumGeom, this.material);
    this.frustum.frustumCulled = false;

    this.object = new THREE.Group();
    this.object.name = "__helper_camera";
    this.object.matrixAutoUpdate = false;
    this.object.add(this.frustum);
  }

  sync(node: Node, world: THREE.Object3D | undefined, ctx: HelperContext): void {
    const cam = node as CameraNode;
    this.material.color.setHex(cam.isEditorCamera ? 0x66ccff : FRUSTUM_COLOR);

    const aspect = Math.max(0.1, ctx.getAspect());
    const sig = `${cam.fov}|${cam.near}|${cam.far}|${aspect.toFixed(4)}`;
    if (sig !== this.signature) {
      this.signature = sig;
      this.writeFrustum(cam.fov, aspect, cam.near, cam.far);
    }

    applyHelperWorld(this.object, node, world);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frustumGeom.dispose();
    this.material.dispose();
  }

  /** 依据 fov(度)/aspect/near/far 生成 12 条线段（近矩形 + 远矩形 + 四角连线） */
  private writeFrustum(fovDeg: number, aspect: number, near: number, far: number): void {
    const n = Math.max(1e-4, near);
    const f = Math.max(n + 1e-4, far);
    const halfH = Math.tan((fovDeg * Math.PI) / 360); // tan(verticalFov/2)
    const nH = 2 * n * halfH;
    const nW = nH * aspect;
    const fH = 2 * f * halfH;
    const fW = fH * aspect;

    const corners = (w: number, h: number, d: number): number[] => [
      -w / 2, -h / 2, -d,
      w / 2, -h / 2, -d,
      w / 2, h / 2, -d,
      -w / 2, h / 2, -d,
    ];
    const n0 = corners(nW, nH, n);
    const f0 = corners(fW, fH, f);
    const at = (arr: number[], i: number): number[] => arr.slice(i * 3, i * 3 + 3);

    // 24 个顶点 = 12 段 × 2
    const pos = new Float32Array(24 * 3);
    const seg = (a: number[], b: number[], k: number): void => {
      pos.set(a, k * 6);
      pos.set(b, k * 6 + 3);
    };
    // 近矩形边
    seg(at(n0, 0), at(n0, 1), 0);
    seg(at(n0, 1), at(n0, 2), 1);
    seg(at(n0, 2), at(n0, 3), 2);
    seg(at(n0, 3), at(n0, 0), 3);
    // 远矩形边
    seg(at(f0, 0), at(f0, 1), 4);
    seg(at(f0, 1), at(f0, 2), 5);
    seg(at(f0, 2), at(f0, 3), 6);
    seg(at(f0, 3), at(f0, 0), 7);
    // 近↔远四角连线
    for (let i = 0; i < 4; i++) {
      seg(at(n0, i), at(f0, i), 8 + i);
    }

    const attr = this.frustumGeom.getAttribute("position") as THREE.BufferAttribute;
    attr.array = pos;
    attr.needsUpdate = true;
    this.frustumGeom.computeBoundingSphere();
  }
}
