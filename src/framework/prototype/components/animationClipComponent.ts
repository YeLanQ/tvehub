// 关键帧动画剪辑组件描述符：给任意节点附加一段自制关键帧动画
// （.anim 资产，变换通道关键帧；与模型自带剪辑的 anim/animGraph 并存）。
// 编辑器由动画编辑窗口制作剪辑；播放器每帧采样并应用到节点对象变换。

import { nextId } from "../../../platform_abstraction/id";
import type {
  AnimClipBinding,
  AnimationClipComponentRef,
  ComponentCreateOptions,
  ComponentDescriptor,
} from "./types";

/** 动画剪辑绑定收敛（缺失/非法字段回退默认） */
export function parseAnimClipBinding(v: unknown): AnimClipBinding {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    clip: typeof o.clip === "string" ? o.clip : "",
    autoplay: o.autoplay !== false,
    loop: o.loop !== false,
    speed: typeof o.speed === "number" && Number.isFinite(o.speed) ? Math.max(0, o.speed) : 1,
  };
}

export const animationClipDescriptor: ComponentDescriptor<AnimationClipComponentRef> = {
  type: "animationClip",
  parse(raw, base) {
    return {
      id: base.id,
      type: "animationClip",
      enabled: base.enabled,
      clip: parseAnimClipBinding(raw.clip),
    };
  },
  createDefault(opts?: ComponentCreateOptions) {
    return {
      id: nextId("comp"),
      type: "animationClip",
      enabled: true,
      clip: { clip: opts?.clip ?? "", autoplay: true, loop: true, speed: 1 },
    };
  },
  cloneForInstance(c) {
    return { ...c, id: nextId("comp"), clip: { ...c.clip } };
  },
  cloneForWrite(c) {
    return { ...c, clip: { ...c.clip } };
  },
  resetSettings(c) {
    c.clip = { clip: "", autoplay: true, loop: true, speed: 1 };
  },
};
