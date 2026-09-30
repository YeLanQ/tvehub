// 适配层 · 音频：three 的 AudioContext.getContext() 走 `new (window.AudioContext ||
// window.webkitAudioContext)()`——构造器返回 Proxy 门面（转发原生 wx AudioContext，
// 覆写 resume/state/suspend/close）。不直接改写平台 ctx：resume 等是只读访问器
// （赋值即抛 "which has only a getter"），引擎的 `ctx.resume().catch()` 又要求
// Promise 返回值。state 在首次 resume 后恒报 running（对齐浏览器解锁语义，
// 防平台 state 永久 suspended 卡死自动播放判定）。

import { wxApi, isWechatRuntime, setGlobal, windowRef } from "./env.js";

function ensurePromise(value) {
  if (value && typeof value.then === "function") return value;
  return Promise.resolve(value);
}

/** 平台 ctx 的方法门面：全部转发原生（绑定 this），状态族覆写为安全语义 */
function makeAudioFacade(native) {
  let resumed = false;
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
  if (!isWechatRuntime) return;
  let ctx = null;
  try {
    if (wxApi && typeof wxApi.createWebAudioContext === "function") ctx = wxApi.createWebAudioContext();
  } catch (e) {
    console.warn("[tve-wechat] WebAudio 创建失败（音频将静音）", e);
  }
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
