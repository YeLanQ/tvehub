import * as THREE from "three";
import type { Node } from "../../../prototype/Node";
import { navAgentPathVisuals } from "../../../navigation/NavSystem";
import type { NodeHelper } from "./types";

/**
 * 导航代理辅助绘制器：当前路径折线。
 * - 路径线是世界系折线，数据来自导航系统的可视化注册表
 *   （navAgentPathVisuals，寻路/移动时更新，按版本号惰性重建几何）；
 * - 选中可见（HelperSystem 门控）：路径线常驻会遮挡场景，与碰撞体线框同策略。
 * - 不渲染代理本体占位（蓝色锥体已移除——代理由导航运行时驱动，可见形象交给
 *   挂载的网格/角色模型，避免大面积半透明箭头遮挡场景）。
 */
export class NavAgentHelper implements NodeHelper {
  /** 恒等矩阵的容器（路径线以世界系定位） */
  readonly object: THREE.Group;

  private line: THREE.Line;
  private lineGeom: THREE.BufferGeometry;
  private pathVersion = -1;

  constructor() {
    this.object = new THREE.Group();
    this.object.name = "__navAgentHelper";
    this.object.matrixAutoUpdate = false;
    this.object.matrix.identity();

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

  sync(node: Node, _world: THREE.Object3D | undefined): void {
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
    this.lineGeom.dispose();
    (this.line.material as THREE.Material).dispose();
  }
}
