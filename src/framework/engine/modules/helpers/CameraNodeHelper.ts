import * as THREE from "three";
import type { CameraNode } from "../../../prototype/nodes/CameraNode";
import type { Node } from "../../../prototype/Node";
import type { HelperContext, NodeHelper } from "./types";

const FRUSTUM_COLOR = 0x55bbff;
const RAY_COLOR = 0xffcf5c;

/**
 * 相机辅助线（视锥线框，参照 LQEN drawCameraHelper）：
 * - 近/远平面矩形由相机真实 fov / near / far 与取景宽高比推导（近小远大）；
 *   取景宽高比 = 项目设计分辨率（designWidth/designHeight），未配置时回退视口宽高比，
 *   项目配置修改后宽高比变化 → 线框即时重建同步；
 * - 近矩形 + 远矩形 + 四角棱线 + 相机位置 → 远平面中心的“视向线段”；
 * - 全部在相机局部空间生成、随节点世界矩阵放置；
 * - 修改 Near / Far / Fov 或设计分辨率后立即重建线框（参数实时同步）。
 */
export class CameraNodeHelper implements NodeHelper {
  readonly object: THREE.Group;
  private frustum: THREE.LineSegments;
  private frustumGeom: THREE.BufferGeometry;
  private frustumMat: THREE.LineBasicMaterial;
  private ray: THREE.LineSegments;
  private rayGeom: THREE.BufferGeometry;
  private rayMat: THREE.LineBasicMaterial;
  private signature = "";
  private disposed = false;

  constructor() {
    this.frustumGeom = new THREE.BufferGeometry();
    this.frustumGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(24 * 3), 3),
    );
    this.frustumMat = new THREE.LineBasicMaterial({
      color: FRUSTUM_COLOR,
      transparent: true,
      opacity: 0.9,
    });
    this.frustum = new THREE.LineSegments(this.frustumGeom, this.frustumMat);
    this.frustum.frustumCulled = false;

    this.rayGeom = new THREE.BufferGeometry();
    this.rayGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(6), 3),
    );
    this.rayMat = new THREE.LineBasicMaterial({
      color: RAY_COLOR,
      transparent: true,
      opacity: 0.9,
    });
    this.ray = new THREE.LineSegments(this.rayGeom, this.rayMat);
    this.ray.frustumCulled = false;

    this.object = new THREE.Group();
    this.object.name = "__helper_camera";
    this.object.matrixAutoUpdate = false;
    this.object.add(this.frustum, this.ray);
  }

  sync(node: Node, world: THREE.Object3D | undefined, ctx: HelperContext): void {
    const cam = node as CameraNode;
    const isEditor = cam.isEditorCamera;
    this.frustumMat.color.setHex(isEditor ? 0x66ccff : FRUSTUM_COLOR);

    // 取景宽高比：优先项目设计分辨率（设计分辨率修改后此处随之变化 → 重建线框）
    const design = ctx.getDesignSize?.() ?? null;
    const aspect =
      design && design.width > 0 && design.height > 0
        ? design.width / design.height
        : Math.max(0.01, ctx.getAspect());
    const sig = `${cam.fov}|${cam.near}|${cam.far}|${aspect.toFixed(4)}`;
    if (sig !== this.signature) {
      this.signature = sig;
      this.writeFrustum(cam.fov, cam.near, cam.far, aspect);
    }

    // 局部线框 → 节点世界矩阵（含层级父级变换）
    if (world) {
      world.updateMatrixWorld(true);
      this.object.matrix.copy(world.matrixWorld);
    } else {
      this.object.matrixAutoUpdate = false;
      this.object.matrix.compose(
        new THREE.Vector3(node.transform.position.x, node.transform.position.y, node.transform.position.z),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(
            (node.transform.rotation.x * Math.PI) / 180,
            (node.transform.rotation.y * Math.PI) / 180,
            (node.transform.rotation.z * Math.PI) / 180,
            "XYZ",
          ),
        ),
        new THREE.Vector3(1, 1, 1),
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frustumGeom.dispose();
    this.frustumMat.dispose();
    this.rayGeom.dispose();
    this.rayMat.dispose();
  }

  /** 用真实 fov/near/far/aspect 生成：近矩形 + 远矩形 + 四角棱线 + 视向线段 */
  private writeFrustum(fovDeg: number, near: number, far: number, aspect: number): void {
    const n = Math.max(1e-4, near);
    const f = Math.max(n + 1e-4, far);
    const tanHalf = Math.tan((fovDeg * Math.PI) / 360);

    const nH = 2 * tanHalf * n;
    const nW = nH * aspect;
    const fH = 2 * tanHalf * f;
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

    // 12 条线段：近矩形 4 + 远矩形 4 + 四角棱线 4
    const pos = new Float32Array(24 * 3);
    const seg = (a: number[], b: number[], k: number): void => {
      pos.set(a, k * 6);
      pos.set(b, k * 6 + 3);
    };
    seg(at(n0, 0), at(n0, 1), 0);
    seg(at(n0, 1), at(n0, 2), 1);
    seg(at(n0, 2), at(n0, 3), 2);
    seg(at(n0, 3), at(n0, 0), 3);
    seg(at(f0, 0), at(f0, 1), 4);
    seg(at(f0, 1), at(f0, 2), 5);
    seg(at(f0, 2), at(f0, 3), 6);
    seg(at(f0, 3), at(f0, 0), 7);
    for (let i = 0; i < 4; i++) {
      seg(at(n0, i), at(f0, i), 8 + i);
    }

    const fattr = this.frustumGeom.getAttribute("position") as THREE.BufferAttribute;
    fattr.array = pos;
    fattr.needsUpdate = true;
    this.frustumGeom.computeBoundingSphere();

    // 视向线段：相机位置(原点) → 远平面中心(0,0,-far)
    const rayArr = new Float32Array([0, 0, 0, 0, 0, -f]);
    const rattr = this.rayGeom.getAttribute("position") as THREE.BufferAttribute;
    rattr.array = rayArr;
    rattr.needsUpdate = true;
    this.rayGeom.computeBoundingSphere();
  }
}
