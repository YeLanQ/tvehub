// ---------------------------------------------------------------------------
// 物理域：物理组件卡（刚体 Rigid Body / 碰撞体 Collider）的字段编辑。
//
// 协作：只依赖 useInspectorNode 返回的 ctx（node / commit），域之间互不引用。
// 编辑走 commit → mutateNode（整节点快照进撤销历史），标签文案即历史文案；
// 刚体组件单实例（按类型查找首个），碰撞体按 compId 定位。
//
// 背景：从 InspectorPanel.vue 的「各类型组件的字段编辑」段落中按域抽出，
// 逐字搬运（含各字段的 Math.max/min 收敛与默认值）。
// ---------------------------------------------------------------------------
import {
  isColliderComponent,
  isRigidBodyComponent,
  type ColliderComponentRef,
} from "../../../framework/prototype/Node";
import type { ColliderSettings, RigidBodySettings } from "../../../framework/physics";
import type { InspectorNodeApi } from "./useInspectorNode";

export interface InspectorPhysicsApi {
  onRigidBodyUpdate: (label: string, value: unknown) => void;
  onColliderUpdate: (compId: string, label: string, value: unknown) => void;
}

export function useInspectorPhysics(ctx: InspectorNodeApi): InspectorPhysicsApi {
  const { node, commit } = ctx;

  function onRigidBodyUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n) return;
    commit((target) => {
      const comp = target.components.find(isRigidBodyComponent);
      if (!comp) return;
      const rb: RigidBodySettings = comp.rigidBody;
      switch (label) {
        case "Set RigidBody Mode":
          if (value === "static" || value === "kinematic" || value === "dynamic") rb.mode = value;
          break;
        case "Set RigidBody Mass":
          rb.mass = Math.max(0.001, typeof value === "number" ? value : 1);
          break;
        case "Set RigidBody LinearDamping":
          rb.linearDamping = Math.max(0, typeof value === "number" ? value : 0);
          break;
        case "Set RigidBody AngularDamping":
          rb.angularDamping = Math.max(0, typeof value === "number" ? value : 0);
          break;
        case "Set RigidBody GravityScale":
          rb.gravityScale = Math.max(0, typeof value === "number" ? value : 1);
          break;
        case "Set RigidBody CCD":
          rb.ccd = value === true;
          break;
        case "Set RigidBody LockRotation":
          rb.lockRotation = value === true;
          if (rb.lockRotation) rb.upright = false;
          break;
        case "Set RigidBody Upright":
          rb.upright = value === true;
          if (rb.upright) rb.lockRotation = false;
          break;
      }
    }, label);
  }

  function onColliderUpdate(compId: string, label: string, value: unknown): void {
    const n = node.value;
    if (!n) return;
    commit((target) => {
      const comp = target.components.find(
        (c): c is ColliderComponentRef => c.id === compId && isColliderComponent(c),
      );
      if (!comp) return;
      const col: ColliderSettings = comp.collider;
      const axis = (a: "x" | "y" | "z"): void => {
        col.size[a] = Math.max(0.1, typeof value === "number" ? value : 1);
      };
      const offsetAxis = (a: "x" | "y" | "z"): void => {
        col.offset[a] = typeof value === "number" ? value : 0;
      };
      switch (label) {
        case "Set Collider Shape":
          if (
            value === "box" || value === "sphere" || value === "capsule" ||
            value === "cylinder" || value === "convex"
          ) {
            col.shape = value;
          }
          break;
        case "Set Collider AutoSize":
          col.autoSize = value === true;
          break;
        case "Set Collider Size X": axis("x"); break;
        case "Set Collider Size Y": axis("y"); break;
        case "Set Collider Size Z": axis("z"); break;
        case "Set Collider Offset X": offsetAxis("x"); break;
        case "Set Collider Offset Y": offsetAxis("y"); break;
        case "Set Collider Offset Z": offsetAxis("z"); break;
        case "Set Collider Friction":
          col.friction = Math.max(0, Math.min(4, typeof value === "number" ? value : 0.6));
          break;
        case "Set Collider Restitution":
          col.restitution = Math.max(0, Math.min(1, typeof value === "number" ? value : 0.1));
          break;
        case "Set Collider Sensor":
          col.isSensor = value === true;
          break;
      }
    }, label);
  }

  return { onRigidBodyUpdate, onColliderUpdate };
}
