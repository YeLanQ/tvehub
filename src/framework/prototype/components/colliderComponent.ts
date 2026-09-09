// 碰撞体组件描述符：声明节点的碰撞形状与表面材质。
// 同节点可挂多个碰撞体（复合形状）；无刚体只有碰撞体 = 隐式静态碰撞体。

import { nextId } from "../../../platform_abstraction/id";
import {
  DEFAULT_COLLIDER_SETTINGS,
  cloneColliderSettings,
  parseColliderSettings,
} from "../../physics/types";
import type { ComponentDescriptor, ColliderComponentRef } from "./types";

/** 默认碰撞体设置（size/offset 为 Vec3，须深拷贝避免共享引用） */
function defaultCollider() {
  return {
    ...DEFAULT_COLLIDER_SETTINGS,
    size: { ...DEFAULT_COLLIDER_SETTINGS.size },
    offset: { ...DEFAULT_COLLIDER_SETTINGS.offset },
  };
}

export const colliderDescriptor: ComponentDescriptor<ColliderComponentRef> = {
  type: "collider",
  parse(raw, base) {
    return {
      id: base.id,
      type: "collider",
      enabled: base.enabled,
      collider: parseColliderSettings(raw.collider),
    };
  },
  createDefault() {
    return {
      id: nextId("comp"),
      type: "collider",
      enabled: true,
      collider: defaultCollider(),
    };
  },
  cloneForInstance(c) {
    return { ...c, id: nextId("comp"), collider: cloneColliderSettings(c.collider) };
  },
  cloneForWrite(c) {
    return { ...c, collider: cloneColliderSettings(c.collider) };
  },
  resetSettings(c) {
    c.collider = defaultCollider();
  },
};
