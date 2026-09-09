// 刚体组件描述符：声明节点的运动学形态（static/kinematic/dynamic）。
// 模拟由物理系统在预览/播放时驱动（编辑态只同步数据）。

import { nextId } from "../../../platform_abstraction/id";
import {
  DEFAULT_RIGID_BODY_SETTINGS,
  cloneRigidBodySettings,
  parseRigidBodySettings,
} from "../../physics/types";
import type { ComponentDescriptor, RigidBodyComponentRef } from "./types";

export const rigidBodyDescriptor: ComponentDescriptor<RigidBodyComponentRef> = {
  type: "rigidBody",
  parse(raw, base) {
    return {
      id: base.id,
      type: "rigidBody",
      enabled: base.enabled,
      rigidBody: parseRigidBodySettings(raw.rigidBody),
    };
  },
  createDefault() {
    return {
      id: nextId("comp"),
      type: "rigidBody",
      enabled: true,
      rigidBody: { ...DEFAULT_RIGID_BODY_SETTINGS },
    };
  },
  cloneForInstance(c) {
    return { ...c, id: nextId("comp"), rigidBody: cloneRigidBodySettings(c.rigidBody) };
  },
  cloneForWrite(c) {
    return { ...c, rigidBody: cloneRigidBodySettings(c.rigidBody) };
  },
  resetSettings(c) {
    c.rigidBody = { ...DEFAULT_RIGID_BODY_SETTINGS };
  },
};
