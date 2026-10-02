// 桥接核心 · 环境与全局安装：window 对象、location/navigator/performance/rAF。
// 视口与帧回调经平台端点（host）获取；顶层裸赋值（try 包裹）发生在 bundle 单一
// 模块作用域内，一次生效于整包（详见 install.js 说明）。

import { host, bridgeActive } from "./host.ts";
import { setGlobal, windowRef } from "./install.ts";
import { Emitter, mergeKeys } from "./util.ts";

/** 视口状态（逻辑像素）：host.onWindowResize 时更新 */
export const view = { width: 375, height: 667, dpr: 2 };

export function updateViewSize(width, height) {
  if (Number(width) > 0) view.width = Number(width);
  if (Number(height) > 0) view.height = Number(height);
}

function applyViewport() {
  try {
    const vp = host().getViewport();
    if (vp) {
      view.width = Number(vp.width) > 0 ? Number(vp.width) : view.width;
      view.height = Number(vp.height) > 0 ? Number(vp.height) : view.height;
      view.dpr = Number(vp.dpr) > 0 ? Number(vp.dpr) : view.dpr;
    }
  } catch {
    /* 视口读取失败按缺省 */
  }
}

// —— window 对象（合并进平台已有 window，键级强写；无 window 时整体安装）——
export const winEvents = new Emitter();

export const win = {
  addEventListener(type, fn) {
    return winEvents.on(type, fn);
  },
  removeEventListener(type, fn) {
    winEvents.off(type, fn);
  },
  dispatchEvent(ev) {
    if (ev && typeof ev.type === "string") winEvents.emit(ev.type, ev);
    return true;
  },
  postMessage(data) {
    // player 的 postLog 走 window.parent.postMessage：镜像到 console 保证日志可见
    try {
      if (data && data.__editorPreviewLog === true) {
        const text = String(data.text ?? "");
        if (data.level === "error") console.error("[tve]", text);
        else if (data.level === "warn") console.warn("[tve]", text);
        else console.log("[tve]", text);
      }
    } catch {
      /* 日志镜像不抛错 */
    }
  },
  get innerWidth() {
    return view.width;
  },
  get innerHeight() {
    return view.height;
  },
  get devicePixelRatio() {
    return view.dpr;
  },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame: null, // 桥接激活时按端点安装
  cancelAnimationFrame: null,
  focus() {},
  open() {},
  getComputedStyle() {
    return { getPropertyValue() { return ""; } };
  },
  matchMedia() {
    return { matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  },
  location: null, // installMiscGlobals 后指向 locationShim（window.location 消费者的解析基准）
};

function installWindow() {
  let existing = null;
  try {
    existing = typeof window !== "undefined" ? window : null;
  } catch {
    existing = null;
  }
  if (existing && typeof existing === "object") {
    mergeKeys(existing, win, Object.keys(win));
    windowRef.current = existing;
    try {
      window = existing; // 重绑遮蔽形参
    } catch {
      /* 严格模式未声明 → globalThis 写入已覆盖 */
    }
    setGlobal("window", existing);
  } else {
    windowRef.current = win;
    try {
      window = win;
    } catch {
      /* 同上 */
    }
    setGlobal("window", win);
  }
  // self/parent/top 自引用（防 iframe 判断误炸；postLog 的 window.parent 由此可回环）。
  // 注意 globalThis 必须保持真实全局对象，不做任何改写。
  const selfRef = existing && typeof existing === "object" ? existing : win;
  setGlobal("self", selfRef);
  setGlobal("parent", selfRef);
  setGlobal("top", selfRef);
}

export const locationShim = {
  href: "https://tve.local/game.js",
  origin: "https://tve.local",
  protocol: "https:",
  host: "tve.local",
  hostname: "tve.local",
  port: "",
  pathname: "/game.js",
  search: "",
  hash: "",
  reload() {},
  replace() {},
  toString() {
    return this.href;
  },
};

export const navigatorShim = {
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49",
  appVersion: "5.0 (iPhone)",
  platform: "ios",
  language: "zh-CN",
  languages: ["zh-CN"],
  onLine: true,
  maxTouchPoints: 1,
  hardwareConcurrency: 4,
};

function installMiscGlobals() {
  // location：运行时以它为解析基准，强制给稳定绝对形态（fill-if-absent 会撞上
  // 工具页原生 location——其 pathname 是工具路径，资产相对路径解析会错位）
  setGlobal("location", locationShim);
  try {
    location = locationShim;
  } catch {
    /* 平台只读访问器 → globalThis 写入已覆盖 */
  }
  try {
    win.location = locationShim; // window.location 消费面同基准
  } catch {
    /* 只读忽略 */
  }
  // navigator/performance：平台原生已有则保留（fill-if-absent）
  let nav = null;
  try {
    nav = typeof navigator !== "undefined" ? navigator : null;
  } catch {
    nav = null;
  }
  if (!nav || typeof nav !== "object") {
    setGlobal("navigator", { ...navigatorShim });
  }
  let perf = null;
  try {
    perf = typeof performance !== "undefined" ? performance : null;
  } catch {
    perf = null;
  }
  let perfShim = null;
  if (!perf || typeof perf.now !== "function") {
    const base = Date.now();
    perfShim = { now: () => Date.now() - base, timeOrigin: base };
    setGlobal("performance", perfShim);
  }
  // window.performance：wasm 侧（rapier static accessor）读 window.performance.now()
  // 作时钟基准，缺失即在 wasm 内部 panic（unreachable）——win 对象必须补挂同一实例
  const perfRef = perf && typeof perf.now === "function" ? perf : perfShim;
  try {
    win.performance = perfRef;
  } catch {
    /* 平台 window 只读该键时忽略（原生已在） */
  }
  setGlobal("requestAnimationFrame", win.requestAnimationFrame);
  setGlobal("cancelAnimationFrame", win.cancelAnimationFrame);
}

if (bridgeActive()) {
  applyViewport();
  win.requestAnimationFrame = (fn) => host().requestAnimationFrame(fn);
  win.cancelAnimationFrame = (id) => host().cancelAnimationFrame(id);
  installWindow();
  installMiscGlobals();

  // bundle 作用域裸赋值（env 拥有的名字；其余名字由各自模块安装）
  try {
    window = win;
  } catch {
    /* 已由 globalThis 兜底 */
  }
  try {
    location = locationShim;
  } catch {
    /* 同上 */
  }
  try {
    self = win;
  } catch {
    /* 同上 */
  }
}
