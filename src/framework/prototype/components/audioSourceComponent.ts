// 音源组件描述符：给任意节点附加一个声音发射器（复用 AudioNode 的音源设置）。
// 编辑器由 AudioSystem 以组件 id 绑定（播放/暂停等运行时控制按组件 id 寻址）；
// 播放器由 nodes.mjs 收集、audio.mjs 绑定（节点 id 命中首个音源，兼容 SDK 寻址）。

import { nextId } from "../../../platform_abstraction/id";
import { DEFAULT_AUDIO_SETTINGS, cloneAudioSettings, parseAudioSettings } from "../../audio/types";
import type { AudioSourceComponentRef, ComponentDescriptor } from "./types";

export const audioSourceDescriptor: ComponentDescriptor<AudioSourceComponentRef> = {
  type: "audioSource",
  parse(raw, base) {
    return {
      id: base.id,
      type: "audioSource",
      enabled: base.enabled,
      audio: parseAudioSettings(raw.audio),
    };
  },
  createDefault() {
    return {
      id: nextId("comp"),
      type: "audioSource",
      enabled: true,
      audio: { ...DEFAULT_AUDIO_SETTINGS },
    };
  },
  cloneForInstance(c) {
    return { ...c, id: nextId("comp"), audio: cloneAudioSettings(c.audio) };
  },
  cloneForWrite(c) {
    return { ...c, audio: cloneAudioSettings(c.audio) };
  },
  resetSettings(c) {
    c.audio = { ...DEFAULT_AUDIO_SETTINGS };
  },
};
