// 灯光组件描述符：给任意节点附加一盏灯（组件模式；与灯光节点类层级并存）。
// 编辑器由 SceneSynchronizer 在节点对象下同步真实 three 灯光 + 图标；
// 播放器由 nodes.mjs 按组件数据重建灯光（与灯光节点同一光照语义）。

import { nextId } from "../../../platform_abstraction/id";
import {
  DEFAULT_LIGHT_COMPONENT_SETTINGS,
  cloneLightComponentSettings,
  parseLightComponentSettings,
} from "../../lighting/types";
import type { ComponentCreateOptions, ComponentDescriptor, LightComponentRef } from "./types";

export const lightDescriptor: ComponentDescriptor<LightComponentRef> = {
  type: "light",
  parse(raw, base) {
    return {
      id: base.id,
      type: "light",
      enabled: base.enabled,
      light: parseLightComponentSettings(raw.light),
    };
  },
  createDefault(opts?: ComponentCreateOptions) {
    return {
      id: nextId("comp"),
      type: "light",
      enabled: true,
      light: parseLightComponentSettings({
        ...DEFAULT_LIGHT_COMPONENT_SETTINGS,
        ...(opts?.lightKind ? { kind: opts.lightKind } : null),
      }),
    };
  },
  cloneForInstance(c) {
    return { ...c, id: nextId("comp"), light: cloneLightComponentSettings(c.light) };
  },
  cloneForWrite(c) {
    return { ...c, light: cloneLightComponentSettings(c.light) };
  },
  resetSettings(c) {
    c.light = cloneLightComponentSettings(DEFAULT_LIGHT_COMPONENT_SETTINGS);
  },
};
