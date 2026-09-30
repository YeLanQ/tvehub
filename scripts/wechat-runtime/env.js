// 适配层 · 环境与全局安装：wx 探测、系统信息、window 对象、location/navigator/
// performance/rAF。所有顶层裸赋值（try 包裹）发生在 bundle 单一模块作用域内——
// 命中沙箱遮蔽形参时对整包重绑，未命中（严格模式未声明）则回落 globalThis 写入。

import { Emitter, mergeKeys } from "./util.js";

export const wxApi = (() => {
  try {
    if (typeof wx !== "undefined" && wx) return wx;
  } catch {
    /* 沙箱遮蔽时读 free 标识符可能抛错 */
  }
  try {
    if (typeof GameGlobal !== "undefined" && GameGlobal && GameGlobal.wx) return GameGlobal.wx;
  } catch {
    /* 同上 */
  }
  return null;
})();

/** 是否微信运行环境（node 校验等非 wx 环境下适配层整体空转） */
export const isWechatRuntime = !!wxApi;

function readSystemInfo() {
  try {
    if (wxApi && typeof wxApi.getSystemInfoSync === "function") return wxApi.getSystemInfoSync() || {};
  } catch {
    /* 系统信息失败按缺省视口 */
  }
  return {};
}

export const sysInfo = readSystemInfo();

/** 视口状态（逻辑像素）：wx.onWindowResize / wx.onWindowResizeEnd 时更新 */
export const view = {
  width: Number(sysInfo.windowWidth) > 0 ? Number(sysInfo.windowWidth) : 375,
  height: Number(sysInfo.windowHeight) > 0 ? Number(sysInfo.windowHeight) : 667,
  dpr: Number(sysInfo.pixelRatio || sysInfo.devicePixelRatio) > 0 ? Number(sysInfo.pixelRatio || sysInfo.devicePixelRatio) : 2,
};

export function updateViewSize(width, height) {
  if (Number(width) > 0) view.width = Number(width);
  if (Number(height) > 0) view.height = Number(height);
}

/** 全局对象双写：globalThis + GameGlobal（跨全局视图兜底） */
export function setGlobal(name, value) {
  try {
    globalThis[name] = value;
  } catch {
    /* 只读全局按失败处理 */
  }
  try {
    if (typeof GameGlobal !== "undefined" && GameGlobal) GameGlobal[name] = value;
  } catch {
    /* 同上 */
  }
}

function nowFn() {
  const perf = typeof performance !== "undefined" ? performance : null;
  if (perf && typeof perf.now === "function") return () => perf.now();
  const base = Date.now();
  return () => Date.now() - base;
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
  requestAnimationFrame: null, // 下方安装
  cancelAnimationFrame: null,
  focus() {},
  open() {},
  getComputedStyle() {
    return { getPropertyValue() { return ""; } };
  },
  matchMedia() {
    return { matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  },
};

const requestFrame = (() => {
  if (wxApi && typeof wxApi.requestAnimationFrame === "function") {
    return (fn) => wxApi.requestAnimationFrame(fn);
  }
  // rAF 缺失环境回退 16ms setTimeout
  return (fn) => setTimeout(() => fn(nowFn()()), 16);
})();

const cancelFrame = (() => {
  if (wxApi && typeof wxApi.cancelAnimationFrame === "function") {
    return (id) => wxApi.cancelAnimationFrame(id);
  }
  return (id) => clearTimeout(id);
})();

win.requestAnimationFrame = requestFrame;
win.cancelAnimationFrame = cancelFrame;

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
  platform: sysInfo.platform || "ios",
  language: sysInfo.language || "zh-CN",
  languages: [sysInfo.language || "zh-CN"],
  onLine: true,
  maxTouchPoints: 1,
  hardwareConcurrency: 4,
};

/** 安装完成后 free 标识符 window 实际解析到的对象（后续模块向 window 挂键用） */
export const windowRef = { current: null };

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

function installMiscGlobals() {
  // location：运行时以它为解析基准，强制给稳定绝对形态（fill-if-absent 会撞上
  // 工具页原生 location——其 pathname 是工具路径，资产相对路径解析会错位）
  setGlobal("location", locationShim);
  try {
    location = locationShim;
  } catch {
    /* 平台只读访问器 → globalThis 写入已覆盖 */
  }
  // navigator：平台原生已有则保留（fill-if-absent）
  let nav = null;
  try {
    nav = typeof navigator !== "undefined" ? navigator : null;
  } catch {
    nav = null;
  }
  if (!nav || typeof nav !== "object") setGlobal("navigator", navigatorShim);
  // performance：fill-if-absent
  let perf = null;
  try {
    perf = typeof performance !== "undefined" ? performance : null;
  } catch {
    perf = null;
  }
  if (!perf || typeof perf.now !== "function") {
    const base = Date.now();
    setGlobal("performance", { now: () => Date.now() - base, timeOrigin: base });
  }
  setGlobal("requestAnimationFrame", requestFrame);
  setGlobal("cancelAnimationFrame", cancelFrame);
}

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
