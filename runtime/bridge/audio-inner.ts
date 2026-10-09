// 桥接核心 · 平台原生音频发射器：2D 音源经 __tveCreateAudioEmitter 钩子整条交
// InnerAudioContext（微信小游戏的 BGM 标准路径——真机 WebAudio 输出通路不可靠时
// 的对侧通路，obeyMuteSwitch:false 兼顾 iOS 静音键）。引擎 attachSource 门控调用
//（web 渠道钩子缺席零开销）；文件化资产直用包内路径，内联资产落用户目录临时文件。
// 3D 空间音源不适用（无声像 pans），引擎侧不调本钩子，继续走共享 WebAudio 链。

import { bridgeActive, host } from "./host.ts";
import { setGlobal } from "./install.ts";
import { base64ToBytes } from "./codec.ts";
import { innerCounters } from "./audio-diag.ts";

/** 引擎发射器消费的鸭子形态（src/runtime/runtime/audio.ts 门控消费面） */
export interface ChannelAudioEmitter {
  __tveChannelAudio: true;
  setVolume(v: number): void;
  setLoop(v: boolean): void;
  setPlaybackRate(r: number): void;
  readonly isPlaying: boolean;
  offset: number;
  play(): void;
  stop(): void;
  pause(): void;
  destroy(): void;
}

/** 钩子形态：引擎 attachSource 以 settings 调用，拒绝（null）时引擎回退 WebAudio 链 */
export type ChannelAudioEmitterFactory = (settings: unknown) => ChannelAudioEmitter | null;

/** InnerAudioContext 鸭子形态（真机缺成员逐个容错；未列成员经索引透传） */
interface InnerAudioLike {
  src: string;
  loop: boolean;
  volume: number;
  playbackRate: number;
  currentTime: number;
  duration?: number;
  play(): void;
  stop(): void;
  pause(): void;
  destroy(): void;
  seek(time: number): void;
  onPlay?(cb: () => void): void;
  onEnded?(cb: () => void): void;
  onPause?(cb: () => void): void;
  onStop?(cb: () => void): void;
  onError?(cb: () => void): void;
  [key: string]: unknown;
}

/** 音频代管所需端点扩展（HostEndpoint 之外的非契约方法；其他渠道可不实现） */
type AudioEndpoint = {
  createInnerAudio?: () => unknown;
  setInnerAudioOptions?: (opts: { obeyMuteSwitch?: boolean }) => void;
  writeUserFile?: (name: string, bytes: Uint8Array) => string | null;
};

/** rel → 播放源：文件化资产回包内路径；内联 base64 落用户目录（同步写，稳定名）。 */
function resolveSourcePath(rel: string): string | null {
  const data = (globalThis as unknown as {
    __TVE_BUILD_DATA?: { assetFiles?: Record<string, string>; assets?: Record<string, string> };
  }).__TVE_BUILD_DATA;
  if (!data) return null;
  const files = data.assetFiles;
  if (files && typeof files[rel] === "string") return files[rel];
  const inlined = data.assets && typeof data.assets[rel] === "string" ? data.assets[rel] : null;
  if (!inlined) return null;
  const endpoint = host() as AudioEndpoint | null;
  if (!endpoint || typeof endpoint.writeUserFile !== "function") return null;
  const bytes = base64ToBytes(inlined);
  const ext = (rel.match(/\.[a-z0-9]+$/i) || [".mp3"])[0].toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = (h * 0x01000193) >>> 0;
  }
  return endpoint.writeUserFile(`tve-audio-${h.toString(16).padStart(8, "0")}${ext}`, bytes);
}

/** InnerAudio 实例 → 引擎发射器鸭子形态（THREE.Audio 消费面子集 + destroy）。 */
function makeInnerEmitter(inner: InnerAudioLike): ChannelAudioEmitter {
  let playing = false;
  const bind = (api: string, mark: boolean): void => {
    try {
      const fn = inner[api];
      if (typeof fn === "function") (fn as (cb: () => void) => void).call(inner, () => (playing = mark));
    } catch {
      /* 事件缺席按手动状态机 */
    }
  };
  bind("onPlay", true);
  bind("onEnded", false);
  bind("onPause", false);
  bind("onStop", false);
  bind("onError", false);
  return {
    __tveChannelAudio: true,
    setVolume(v: number): void {
      try {
        inner.volume = Math.max(0, Math.min(1, Number(v) || 0));
      } catch {
        /* 平台拒绝按静默 */
      }
    },
    setLoop(v: boolean): void {
      try {
        inner.loop = !!v;
      } catch {
        /* 同上 */
      }
    },
    setPlaybackRate(r: number): void {
      try {
        inner.playbackRate = Math.max(0.5, Math.min(2, Number(r) || 1));
      } catch {
        /* 平台不支持倍速按原速 */
      }
    },
    get isPlaying(): boolean {
      return playing;
    },
    get offset(): number {
      try {
        const t = inner.currentTime;
        return typeof t === "number" && Number.isFinite(t) && t >= 0 ? t : 0;
      } catch {
        return 0;
      }
    },
    set offset(v: number) {
      try {
        inner.seek(Math.max(0, Number(v) || 0));
      } catch {
        /* seek 失败按从头播 */
      }
    },
    play(): void {
      try {
        inner.play();
        innerCounters.innerPlay++;
        playing = true;
      } catch {
        /* 平台拒绝按静默（引擎按未起播处理） */
      }
    },
    stop(): void {
      try {
        inner.stop();
        playing = false;
      } catch {
        /* 同上 */
      }
    },
    pause(): void {
      try {
        inner.pause();
        playing = false;
      } catch {
        /* 同上 */
      }
    },
    destroy(): void {
      try {
        inner.destroy();
      } catch {
        /* 平台已自灭按释放 */
      }
    },
  };
}

export function installInnerAudioFactory(): void {
  if (!bridgeActive()) return;
  const endpoint = host() as AudioEndpoint | null;
  if (!endpoint || typeof endpoint.createInnerAudio !== "function") return;
  try {
    if (typeof endpoint.setInnerAudioOptions === "function") {
      // iOS 静音键不拦游戏音频（小游戏 BGM 常规口径）；Android 无此语义忽略
      endpoint.setInnerAudioOptions({ obeyMuteSwitch: false });
    }
  } catch {
    /* 选项失败按平台缺省 */
  }
  const factory: ChannelAudioEmitterFactory = (settings) => {
    try {
      const src = resolveSourcePath(String((settings as { source?: unknown } | null)?.source ?? ""));
      if (!src) return null;
      const inner = endpoint.createInnerAudio?.() as InnerAudioLike | null | undefined;
      if (!inner) return null;
      inner.src = src;
      innerCounters.innerMade++;
      return makeInnerEmitter(inner);
    } catch {
      return null;
    }
  };
  setGlobal("__tveCreateAudioEmitter", factory);
}
