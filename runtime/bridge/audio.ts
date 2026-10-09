// 桥接核心 · 音频：three 的 AudioContext.getContext() 走 `new (window.AudioContext ||
// window.webkitAudioContext)()`——构造器返回 Proxy 门面（转发原生平台 AudioContext，
// 覆写 resume/state/suspend/close/decodeAudioData）。不直接改写平台 ctx：resume 等
// 可能是只读访问器（赋值即抛 "which has only a getter"），引擎的 `ctx.resume().catch()`
// 又要求 Promise 返回值。state 在首次 resume 后恒报 running（对齐浏览器解锁语义，
// 防平台 state 永久 suspended 卡死自动播放判定）；iOS 真机的手势内解锁由
// installAudioGlobals 自挂的手势监听补位（见该函数内注释）。
// 解码兜底见 audio-decode.ts；真机读出面见 audio-diag.ts；2D 平台代管见 audio-inner.ts。

import { host, bridgeActive } from "./host.ts";
import { setGlobal, windowRef } from "./install.ts";
import { winEvents } from "./env.ts";
import { createDecodeShim } from "./audio-decode.ts";
import { createAudioDiag } from "./audio-diag.ts";
import { installInnerAudioFactory } from "./audio-inner.ts";
import type { AudioDiag } from "./audio-diag.ts";
import type { DecodeShim } from "./audio-decode.ts";

/** 平台 WebAudio 上下文鸭子形态（WXAudio 真机实现残缺容错；未列成员经索引透传） */
export interface NativeAudioContext {
  state?: unknown;
  currentTime?: unknown;
  destination?: unknown;
  listener?: unknown;
  sampleRate?: number;
  resume?: () => unknown;
  suspend?: () => unknown;
  close?: () => unknown;
  decodeAudioData?: (
    buffer: ArrayBuffer,
    success?: (buffer: unknown) => void,
    error?: (error: unknown) => void,
  ) => unknown;
  /** 解码超时毫秒（spec 注入用；生产缺省 10s，见 audio-decode.ts） */
  __tveDecodeTimeoutMs?: number;
  [key: string]: unknown;
}

/** 引擎侧消费的 AudioContext 门面形态（THREE.AudioContext.getContext 返回值；
 *  未列成员（createGain/createBufferSource 等）经索引签名转发原生 */
export interface TveAudioContext {
  state: string;
  currentTime: number;
  destination: unknown;
  listener: unknown;
  resume(): Promise<unknown>;
  suspend(): Promise<unknown>;
  close(): Promise<unknown>;
  decodeAudioData: DecodeShim;
  /** 原生平台 ctx（纹理/调试等需要原生身份的消费面） */
  __tveNative: NativeAudioContext;
  /** 音频诊断计数与采样（audio-diag.ts） */
  __tveAudioDiag: AudioDiag;
  [key: string]: unknown;
}

/** 鸭子型 AudioParam（真机 WXAudio 可能缺标准成员；桥接只消费调度族与 value） */
interface AudioParamLike {
  value: number;
  [key: string]: unknown;
}

function ensurePromise(value: unknown): Promise<unknown> {
  if (value && typeof (value as { then?: unknown }).then === "function") {
    return value as Promise<unknown>;
  }
  return Promise.resolve(value);
}

/**
 * AudioParam 安全壳：WXAudio 部分真机对 value/endTime 校验比标准严（NaN 直接
 * RangeError、非单调调度被拒），而 three 的 AudioListener 每帧对 listener 的
 * 九个自由度做 linearRamp——任一参数异常即每帧报错。壳的语义：非有限 value
 * 直接丢弃（保持上次值），endTime 一律换门面侧严格递增时钟，原生仍拒绝则吞掉。
 */
function makeSafeParam(param: AudioParamLike, nowTime: () => number): AudioParamLike {
  let last = 0;
  const nextTime = (): number => {
    const v = nowTime();
    last = v > last ? v : last + 0.016;
    return last;
  };
  const safe = (fn: (value: number, ...rest: unknown[]) => unknown) =>
    (value: unknown, ...rest: unknown[]): undefined | unknown => {
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
      try {
        return fn(value, nextTime(), ...rest);
      } catch {
        return undefined;
      }
    };
  const shell: Record<string, unknown> = {};
  const keys = [
    "setValueAtTime",
    "linearRampToValueAtTime",
    "exponentialRampToValueAtTime",
    "setTargetAtTime",
    "setValueCurveAtTime",
  ] as const;
  for (const k of keys) {
    const fn = param[k];
    if (typeof fn === "function") shell[k] = safe(fn.bind(param) as (value: number, ...rest: unknown[]) => unknown);
  }
  return new Proxy(shell, {
    get(_t, key) {
      if (typeof key !== "string") return undefined;
      if (key in shell) return shell[key];
      if (key === "value") {
        try {
          return param.value;
        } catch {
          return 0;
        }
      }
      let v: unknown;
      try {
        v = param[key];
      } catch {
        return undefined;
      }
      return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(param) : v;
    },
    set(_t, key, value) {
      if (typeof key === "string" && key === "value") {
        if (typeof value !== "number" || !Number.isFinite(value)) return true;
      }
      try {
        (param as Record<string, unknown>)[key as string] = value;
      } catch {
        /* 平台只读属性静默丢弃 */
      }
      return true;
    },
  }) as AudioParamLike;
}

/** 包装 listener：其成员凡是鸭子型 AudioParam（有 setValueAtTime）都换安全壳 */
function makeSafeListener(listener: unknown, nowTime: () => number): unknown {
  if (!listener || typeof listener !== "object") return listener;
  const src = listener as Record<string, unknown>;
  return new Proxy(
    {},
    {
      get(_t, key) {
        if (typeof key !== "string") return undefined;
        let v: unknown;
        try {
          v = src[key];
        } catch {
          return undefined;
        }
        if (v && typeof v === "object" && typeof (v as AudioParamLike).setValueAtTime === "function") {
          return makeSafeParam(v as AudioParamLike, nowTime);
        }
        return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(src) : v;
      },
      set(_t, key, value) {
        try {
          src[key as string] = value;
        } catch {
          /* 同上 */
        }
        return true;
      },
    },
  );
}

/** 平台 ctx 的方法门面：全部转发原生（绑定 this），状态族覆写为安全语义 */
function makeAudioFacade(native: NativeAudioContext): TveAudioContext {
  let resumed = false;
  // currentTime 兜底时钟：WXAudio 部分真机返回非有限值/0，而 three 的
  // AudioListener 每帧拿它做 linearRamp（NaN 进 param 即每帧抛 RangeError）
  const createdAt = Date.now();
  const diag = createAudioDiag(native, createdAt);
  const decodeShim = createDecodeShim(native, diag.counters);
  const nowTime = (): number => {
    let v: unknown;
    try {
      v = native.currentTime;
    } catch {
      v = undefined;
    }
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : (Date.now() - createdAt) / 1000;
  };
  const guarded = (fn: () => unknown) => (): Promise<unknown> => {
    try {
      return ensurePromise(fn());
    } catch {
      return Promise.resolve();
    }
  };
  return new Proxy({} as TveAudioContext, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      if (key === "then") return undefined; // 防 thenable 误判
      if (key === "__tveNative") return native;
      if (key === "__tveAudioDiag") return diag;
      if (key === "state") {
        if (resumed) return "running";
        try {
          return typeof native.state === "string" ? native.state : "running";
        } catch {
          return "running";
        }
      }
      if (key === "currentTime") {
        return nowTime();
      }
      if (key === "decodeAudioData") {
        return decodeShim;
      }
      if (key === "listener") {
        let lv: unknown;
        try {
          lv = native.listener;
        } catch {
          return undefined;
        }
        return lv ? makeSafeListener(lv, nowTime) : lv;
      }
      if (key === "resume") {
        return guarded(() => {
          resumed = true;
          return typeof native.resume === "function" ? native.resume() : undefined;
        });
      }
      if (key === "suspend") {
        return guarded(() => (typeof native.suspend === "function" ? native.suspend() : undefined));
      }
      if (key === "close") {
        return guarded(() => (typeof native.close === "function" ? native.close() : undefined));
      }
      let value: unknown;
      try {
        value = native[key];
      } catch {
        return undefined;
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(native) : value;
    },
    set(_target, key, value) {
      try {
        (native as Record<string, unknown>)[key as string] = value;
      } catch {
        /* 平台只读属性静默丢弃 */
      }
      return true;
    },
  });
}

export function installAudioGlobals(): void {
  if (!bridgeActive()) return;
  const endpoint = host();
  if (!endpoint) return;
  const ctx = endpoint.createAudioContext() as NativeAudioContext | null;
  if (!ctx) return;

  const facade = makeAudioFacade(ctx);

  // iOS 真机：WebAudio 初始挂起，且 resume 仅在用户交互回调栈内调用才生效；
  // 而 engine 的解锁链经 facade state 短路（首次 resume 后恒报 running），
  // 首次触摸后不会再补原生 resume —— autoplay 在非手势时机的预 resume 无效时
  // 音频永远无声（模拟器无手势门从不复现）。桥接层自挂手势监听，幂等直调原生
  // resume（running ctx 上 resume 为无副作用空操作），与 state 短路解耦；
  // wx.onShow 路径同参（切后台回前台 ctx 会被系统再挂起）。
  const resumeNative = (): void => {
    try {
      if (typeof ctx.resume === "function") {
        const r = ctx.resume() as { catch?: (cb: () => void) => void } | undefined;
        if (r && typeof r.catch === "function") r.catch(() => {});
      }
    } catch {
      /* getter-only 访问器形态抛错按静默 */
    }
  };
  winEvents.on("pointerdown", () => {
    facade.__tveAudioDiag.noteGesture();
    resumeNative();
  });
  try {
    if (typeof endpoint.onShow === "function") endpoint.onShow(resumeNative);
  } catch {
    /* 生命周期注册失败忽略 */
  }
  facade.__tveAudioDiag.schedule();

  /** 构造器壳：new AudioContextShim() 得到共享门面（构造器返回对象 → new 表达式取该对象） */
  function AudioContextShim(): TveAudioContext {
    return facade;
  }
  const shimCtor = AudioContextShim as unknown as new () => TveAudioContext;
  try {
    const w = windowRef.current;
    if (w) {
      w.AudioContext = shimCtor;
      w.webkitAudioContext = shimCtor;
    }
  } catch {
    /* window 未就绪忽略 */
  }
  setGlobal("AudioContext", shimCtor);
  setGlobal("webkitAudioContext", shimCtor);
}

// 求值期安装（bootstrap 以 import 装配，见该文件说明）
installAudioGlobals();
// 2D 音源平台代管钩子（独立于 WebAudio 上下文成败——ctx 缺席时 InnerAudio 仍可用）
installInnerAudioFactory();
