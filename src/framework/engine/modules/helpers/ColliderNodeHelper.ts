import * as THREE from "three";
import { isColliderComponent, type ColliderComponentRef } from "../../../prototype/Node";
import { computeColliderShapeDesc, terrainMeshSigOf } from "../../../physics/colliderShape";
import { parseColliderSettings } from "../../../physics/types";
import { buildColliderWireframe } from "./colliderWireframe";
import type { HelperContext, NodeHelper } from "./types";
import type { Node } from "../../../prototype/Node";

/** 常规碰撞体：绿色 */
const COLOR_SOLID = 0x35c26f;
/** 传感器（只触发不碰撞）：青色 */
const COLOR_SENSOR = 0x38bdf8;

// —— 复用临时对象（sync 每帧调用，避免分配） ——
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

interface ColliderPart {
  seg: THREE.LineSegments;
  geom: THREE.BufferGeometry;
}

/**
 * 碰撞体辅助线框：为节点上每个启用的碰撞体组件画一条形状线框（同节点多碰撞体 = 复合）。
 *
 * - 形状/尺寸/偏移经 physics/colliderShape.ts 计算（与 PhysicsSystem 建体同一实现），
 *   保证线框与物理体完全吻合（含 autoSize 包围盒与世界缩放烘焙）；
 * - 世界缩放烘进几何后，辅助对象仅贴合节点世界位置与旋转（缩放恒为单位，避免二次缩放）；
 * - 设置 + 世界缩放构成签名，变化才重建几何（tick 每帧仅做矩阵贴合）；
 * - 无启用碰撞体时隐藏（组件禁用/删除即消失）；挂 helperRoot 下随预览整体隐藏。
 */
export class ColliderNodeHelper implements NodeHelper {
  readonly object: THREE.Group;
  private matSolid: THREE.LineBasicMaterial;
  private matSensor: THREE.LineBasicMaterial;
  /** 组件 id → 线段对象（几何随签名重建） */
  private parts = new Map<string, ColliderPart>();
  /** 全节点数据签名（设置 + 世界缩放 + 数量） */
  private sig = "";
  private disposed = false;

  constructor() {
    this.matSolid = new THREE.LineBasicMaterial({ color: COLOR_SOLID, transparent: true, opacity: 0.9 });
    this.matSensor = new THREE.LineBasicMaterial({ color: COLOR_SENSOR, transparent: true, opacity: 0.9 });
    this.object = new THREE.Group();
    this.object.name = "__helper_colliders";
    this.object.matrixAutoUpdate = false;
  }

  sync(node: Node, world: THREE.Object3D | undefined, _ctx: HelperContext): void {
    const comps = node.components
      .filter(isColliderComponent)
      .filter((c) => c.enabled);
    if (comps.length === 0) {
      if (this.parts.size || this.sig) {
        this.clearParts();
        this.sig = "";
      }
      this.object.visible = false;
      return;
    }
    this.object.visible = true;

    // 场景对象世界矩阵刷新一次（签名取世界缩放、位姿贴合共用）
    if (world) world.updateWorldMatrix(true, false);
    let sx = 1;
    let sy = 1;
    let sz = 1;
    if (world) {
      world.getWorldScale(tmpScale);
      sx = Math.abs(tmpScale.x) || 1;
      sy = Math.abs(tmpScale.y) || 1;
      sz = Math.abs(tmpScale.z) || 1;
    }

    // 签名与 PhysicsSystem.bindingSig 同口径：设置 + 世界缩放 + 地形内容
    // （autoSize 包围盒随缩放变化；地形参数变化混 terrainSig 才能触发线框重建）
    const parts: string[] = [`n:${comps.length}`];
    for (const c of comps) {
      const s = parseColliderSettings(c.collider);
      parts.push(
        c.id,
        s.shape,
        String(s.autoSize),
        s.autoSize ? "" : `${s.size.x.toFixed(3)}|${s.size.y.toFixed(3)}|${s.size.z.toFixed(3)}`,
        `${s.offset.x.toFixed(3)}|${s.offset.y.toFixed(3)}|${s.offset.z.toFixed(3)}`,
        String(s.isSensor),
        s.shape === "heightfield" ? String(s.resolution) : "",
      );
    }
    parts.push(`s:${sx.toFixed(3)}|${sy.toFixed(3)}|${sz.toFixed(3)}`);
    if (world) parts.push(`t:${terrainMeshSigOf(world)}`);
    const sig = parts.join("§");
    if (sig !== this.sig) {
      this.sig = sig;
      this.rebuild(comps, world);
    }
    this.applyWorldPose(node, world);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearParts();
    this.matSolid.dispose();
    this.matSensor.dispose();
  }

  /** 按当前设置重建全部线框（组件数少、几何廉价，整体重建即可） */
  private rebuild(comps: ColliderComponentRef[], world: THREE.Object3D | undefined): void {
    this.clearParts();
    // 无场景对象时按空对象兜底（包围盒缺失 → 单位半尺寸，与建体路径一致）
    const boundsObj = world ?? new THREE.Object3D();
    for (const c of comps) {
      const settings = parseColliderSettings(c.collider);
      const desc = computeColliderShapeDesc(settings, boundsObj);
      const geom = buildColliderWireframe(desc);
      const seg = new THREE.LineSegments(geom, desc.isSensor ? this.matSensor : this.matSolid);
      seg.position.set(desc.offset.x, desc.offset.y, desc.offset.z);
      seg.frustumCulled = false;
      this.object.add(seg);
      this.parts.set(c.id, { seg, geom });
    }
  }

  /** 贴合节点世界位姿：形状已烘焙世界缩放，仅取位置与旋转 */
  private applyWorldPose(node: Node, world: THREE.Object3D | undefined): void {
    this.object.matrixAutoUpdate = false;
    if (world) {
      world.matrixWorld.decompose(tmpPos, tmpQuat, tmpScale);
      this.object.matrix.compose(tmpPos, tmpQuat, UNIT_SCALE);
    } else {
      const t = node.transform;
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          (t.rotation.x * Math.PI) / 180,
          (t.rotation.y * Math.PI) / 180,
          (t.rotation.z * Math.PI) / 180,
          "XYZ",
        ),
      );
      this.object.matrix.compose(
        new THREE.Vector3(t.position.x, t.position.y, t.position.z),
        q,
        UNIT_SCALE,
      );
    }
  }

  private clearParts(): void {
    for (const p of this.parts.values()) {
      this.object.remove(p.seg);
      p.geom.dispose();
    }
    this.parts.clear();
  }
}
