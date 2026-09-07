import type { Node } from "../../../prototype/Node";
import { isColliderComponent } from "../../../prototype/Node";
import { CameraNode } from "../../../prototype/nodes/CameraNode";
import { LightNode } from "../../../prototype/nodes/LightNode";
import { CameraNodeHelper } from "./CameraNodeHelper";
import { ColliderNodeHelper } from "./ColliderNodeHelper";
import { LightNodeHelper } from "./LightNodeHelper";
import type { NodeHelper } from "./types";

/**
 * NodeHelper 工厂：按节点类型注册对应的辅助绘制器。
 * 新增辅助线类型时只需在这里登记（模块化扩展点）。
 */
export function createNodeHelper(node: Node): NodeHelper | null {
  if (node instanceof CameraNode) return new CameraNodeHelper();
  if (node instanceof LightNode) return new LightNodeHelper();
  // 碰撞体线框：挂在任意网格节点上（相机/灯光节点优先各自的视锥/灯光辅助线）
  if (node.components.some(isColliderComponent)) return new ColliderNodeHelper();
  return null;
}
