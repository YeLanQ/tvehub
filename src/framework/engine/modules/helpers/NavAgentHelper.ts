import * as THREE from "three";
import type { Node } from "../../../prototype/Node";
import { navAgentPathVisuals } from "../../../navigation/NavSystem";
import type { NodeHelper } from "./types";
import { applyHelperWorld } from "./types";

/**
 * 导航代理辅助绘制器：定位箭头（贴代理位姿，朝移动方向）+ 当前路径折线。
 * - 箭头以代理世界矩阵贴合（applyHelperWorld）；
 * - 路径线是世界系折线，数据来自导航系统的可视化注册表
 *   （navAgentPathVisuals，寻路/移动时更新，按版本号惰性重建几何）；
 * - 选中可见（HelperSystem 门控）：路径线常驻会遮挡场景，与碰撞体线框同策略。
 */
export class NavAgentHelper implements NodeHelper {
  /** 恒等矩阵的容器（箭头与路径线各自以世界系定位） */
  readonly object: THREE.Group;

  private arrow: THREE.Mesh;
  private line: THREE.Line;
  private lineGeom: THREE.BufferGeometry;
  private pathVersion = -1;

  constructor() {
    this.object = new THREE.Group();
    this.object.name = "__navAgentHelper";
    this.object.matrixAutoUpdate = false;
    this.object.matrix.identity();

    // 定位箭头：圆锥指向 +Z（与导航系统 yaw = atan2(dx, dz) 朝向约定一致）
    const coneGeom = new THREE.ConeGeometry(0.3, 0.8, 4);
    coneGeom.rotateX(Math.PI / 2);
    this.arrow = new THREE.Mesh(
      coneGeom,
      new THREE.MeshBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.9 }),
    );
    this.arrow.name = "__navAgentArrow";
    this.object.add(this.arrow);

    this.lineGeom = new THREE.BufferGeometry();
    this.line = new THREE.Line(
      this.lineGeom,
      new THREE.LineBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.85 }),
    );
    this.line.name = "__navAgentPath";
    this.line.visible = false;
    this.line.frustumCulled = false;
    this.object.add(this.line);
  }

  sync(node: Node, world: THREE.Object3D | undefined): void {
    // 箭头贴合代理位姿（无对象时回退节点自身 transform）
    applyHelperWorld(this.arrow, node, world);

    // 路径折线：版本号变化才重建（寻路/行进时导航系统发布）
    const viz = navAgentPathVisuals.get(node.id);
    if (!viz || viz.points.length < 2) {
      this.line.visible = false;
      return;
    }
    if (viz.version !== this.pathVersion) {
      this.pathVersion = viz.version;
      this.lineGeom.dispose();
      this.lineGeom = new THREE.BufferGeometry().setFromPoints(
        viz.points.map((p) => new THREE.Vector3(p.x, p.y + 0.15, p.z)),
      );
      this.line.geometry = this.lineGeom;
    }
    this.line.visible = true;
  }

  dispose(): void {
    this.arrow.geometry.dispose();
    (this.arrow.material as THREE.Material).dispose();
    this.lineGeom.dispose();
    (this.line.material as THREE.Material).dispose();
  }
}
