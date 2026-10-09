// 桥接核心 · 音频：three 的 AudioContext.getContext() 走 `new (window.AudioContext ||
// window.webkitAudioContext)()`——构造器返回 Proxy 门面（转发原生平台 AudioContext，
// 覆写 resume/state/suspend/close）。不直接改写平台 ctx：resume 等可能是只读访问器
// （赋值即抛 "which has only a getter"），引擎的 `ctx.resume().catch()` 又要求
// Promise 返回值。state 在首次 resume 后恒报 running（对齐浏览器解锁语义，
// 防平台 state 永久 suspended 卡死自动播放判定）。

import { host, bridgeActive } from "./host.ts";
import { setGlobal, windowRef } from "./install.ts";

function ensurePromise(value) {
  if (value && typeof value.then === "function") return value;
  return Promise.resolve(value);
}

/**
 * AudioParam 安全壳：WXAudio 部分真机对 value/endTime 校验比标准严（NaN 直接
 * RangeError、非单调调度被拒），而 three 的 AudioListener 每帧对 listener 的
 * 九个自由度做 linearRamp——任一参数异常即每帧报错。壳的语义：非有限 value
 * 直接丢弃（保持上次值），endTime 一律换门面侧严格递增时钟，原生仍拒绝则吞掉。
 */
function makeSafeParam(param, nowTime) {
  let last = 0;
  const nextTime = () => {
    const v = nowTime();
    last = v > last ? v : last + 0.016;
    return last;
  };
  const safe = (fn) => (value, ...rest) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    try {
      return fn(value, nextTime(), ...rest);
    } catch {
      return undefined;
    }
  };
  const shell = {};
  const keys = ["setValueAtTime", "linearRampToValueAtTime", "exponentialRampToValueAtTime", "setTargetAtTime", "setValueCurveAtTime"];
  for (const k of keys) {
    if (typeof param[k] === "function") shell[k] = safe(param[k].bind(param));
  }
  return new Proxy(shell, {
    get(_t, key) {
      if (key in shell) return shell[key];
      if (key === "value") {
        try {
          return param.value;
        } catch {
          return 0;
        }
      }
      let v;
      try {
        v = param[key];
      } catch {
        return undefined;
      }
      return typeof v === "function" ? v.bind(param) : v;
    },
    set(_t, key, value) {
      if (key === "value") {
        if (typeof value !== "number" || !Number.isFinite(value)) return true;
      }
      try {
        param[key] = value;
      } catch {
        /* 平台只读属性静默丢弃 */
      }
      return true;
    },
  });
}

/** 包装 listener：其成员凡是鸭子型 AudioParam（有 setValueAtTime）都换安全壳 */
function makeSafeListener(listener, nowTime) {
  if (!listener || typeof listener !== "object") return listener;
  return new Proxy({}, {
    get(_t, key) {
      let v;
      try {
        v = listener[key];
      } catch {
        return undefined;
      }
      if (v && typeof v === "object" && typeof v.setValueAtTime === "function") {
        return makeSafeParam(v, nowTime);
      }
      return typeof v === "function" ? v.bind(listener) : v;
    },
    set(_t, key, value) {
      try {
        listener[key] = value;
      } catch {
        /* 同上 */
      }
      return true;
    },
  });
}

/** 平台 ctx 的方法门面：全部转发原生（绑定 this），状态族覆写为安全语义 */
function makeAudioFacade(native) {
  let resumed = false;
  // currentTime 兜底时钟：WXAudio 部分真机返回非有限值/0，而 three 的
  // AudioListener 每帧拿它做 linearRamp（NaN 进 param 即每帧抛 RangeError）
  const createdAt = Date.now();
  const nowTime = () => {
    let v;
    try {
      v = native.currentTime;
    } catch {
      v = undefined;
    }
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : (Date.now() - createdAt) / 1000;
  };
  const guarded = (fn) => (...args) => {
    try {
      return ensurePromise(fn(...args));
    } catch {
      return Promise.resolve();
    }
  };
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "then") return undefined; // 防 thenable 误判
        if (key === "__tveNative") return native;
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
        if (key === "listener") {
          let lv;
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
        let value;
        try {
          value = native[key];
        } catch {
          return undefined;
        }
        return typeof value === "function" ? value.bind(native) : value;
      },
      set(_target, key, value) {
        try {
          native[key] = value;
        } catch {
          /* 平台只读属性静默丢弃 */
        }
        return true;
      },
    },
  );
}

export function installAudioGlobals() {
  if (!bridgeActive()) return;
  const ctx = host().createAudioContext();
  if (!ctx) return;

  const facade = makeAudioFacade(ctx);
  function AudioContextShim() {
    return facade; // 构造器返回对象 → new AudioContextShim() 得到共享门面
  }
  try {
    const w = windowRef.current;
    if (w) {
      w.AudioContext = AudioContextShim;
      w.webkitAudioContext = AudioContextShim;
    }
  } catch {
    /* window 未就绪忽略 */
  }
  setGlobal("AudioContext", AudioContextShim);
  setGlobal("webkitAudioContext", AudioContextShim);
}

// 求值期安装（bootstrap 以 import 装配，见该文件说明）
installAudioGlobals();
