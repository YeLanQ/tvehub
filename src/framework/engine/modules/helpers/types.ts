import * as THREE from "three";
import type { Node } from "../../../prototype/Node";

/**
 * gizmo/helper 系统通用类型。
 *
 * 模块化约定：每种节点可注册一个 "辅助绘制器"（NodeHelper），负责创建并维护
 * 一个独立于真实网格的辅助对象（如相机视锥线框、灯光方向箭头等）。
 * 辅助对象始终与场景节点解除父子关系、以世界矩阵贴合（matrixAutoUpdate=false），
 * 因此不随节点的非等比缩放失真，也不会被点击拾取。
 */
export interface HelperContext {
  /** 视口当前宽高比（绘制相机视锥辅助线用） */
  getAspect(): number;
}

export interface NodeHelper {
  /** 挂到 helperRoot 下的辅助对象（世界空间定位） */
  readonly object: THREE.Object3D;
  /**
   * 将辅助对象同步到节点的当前状态（属性/变换）。
   * @param node   当前场景节点
   * @param world  该节点在渲染场景中对应的 Object3D（用于取世界变换）；缺失时回退节点自身 transform
   */
  sync(node: Node, world: THREE.Object3D | undefined, ctx: HelperContext): void;
  /** 释放几何与材质 */
  dispose(): void;
}

/**
 * 把辅助对象对齐到节点的世界矩阵（或回退节点本地 transform）。
 * 以四元数同步旋转，避免父级含非等比缩放的干扰。
 */
export function applyHelperWorld(
  helper: THREE.Object3D,
  node: Node,
  world: THREE.Object3D | undefined,
): void {
  helper.matrixAutoUpdate = false;
  const m = helper.matrix;
  if (world) {
    world.updateMatrixWorld(true);
    m.copy(world.matrixWorld);
  } else {
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        (node.transform.rotation.x * Math.PI) / 180,
        (node.transform.rotation.y * Math.PI) / 180,
        (node.transform.rotation.z * Math.PI) / 180,
        "XYZ",
      ),
    );
    m.compose(
      new THREE.Vector3(node.transform.position.x, node.transform.position.y, node.transform.position.z),
      q,
      new THREE.Vector3(node.transform.scale.x, node.transform.scale.y, node.transform.scale.z),
    );
  }
}
