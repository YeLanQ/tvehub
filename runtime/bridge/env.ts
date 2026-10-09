// 桥接核心 · 环境与全局安装：window 对象、location/navigator/performance/rAF。
// 视口与帧回调经平台端点（host）获取；顶层裸赋值（try 包裹）发生在 bundle 单一
// 模块作用域内，一次生效于整包（详见 install.js 说明）。

import { host, bridgeActive } from "./host.ts";
import { setGlobal, windowRef } from "./install.ts";
import { Emitter, mergeKeys } from "./util.ts";

/** 视口状态（逻辑像素）：host.onWindowResize 时更新 */
export const view = { width: 375, height: 667, dpr: 2 };

export function updateViewSize(width: unknown, height: unknown): void {
  if (Number(width) > 0) view.width = Number(width);
  if (Number(height) > 0) view.height = Number(height);
}

function applyViewport(): void {
  try {
    const vp = host()?.getViewport();
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

/** window 门面形态（合并进平台已有 window 的键集；消费者多为鸭子读法） */
export interface WindowShim extends Record<string, unknown> {
  addEventListener(type: string, fn: unknown): () => void;
  removeEventListener(type: string, fn: unknown): void;
  dispatchEvent(ev: { type?: string } | null): boolean;
  postMessage(data: unknown): void;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly devicePixelRatio: number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  requestAnimationFrame: ((fn: (now: number) => void) => number) | null;
  cancelAnimationFrame: ((id: number) => void) | null;
  focus(): void;
  open(): void;
  getComputedStyle(): { getPropertyValue(name: string): string };
  matchMedia(query: string): {
    matches: boolean;
    media: string;
    addEventListener(): void;
    removeEventListener(): void;
    addListener(): void;
    removeListener(): void;
  };
  location: unknown;
}

export const win: WindowShim = {
  addEventListener(type, fn) {
    return winEvents.on(type, fn);
  },
  removeEventListener(type, fn) {
    winEvents.off(type, fn as (event: unknown) => void);
  },
  dispatchEvent(ev) {
    if (ev && typeof ev.type === "string") winEvents.emit(ev.type, ev);
    return true;
  },
  postMessage(data) {
    // player 的 postLog 走 window.parent.postMessage：镜像到 console 保证日志可见
    try {
      const box = data as { __editorPreviewLog?: boolean; text?: unknown; level?: string } | null;
      if (box && box.__editorPreviewLog === true) {
        const text = String(box.text ?? "");
        if (box.level === "error") console.error("[tve]", text);
        else if (box.level === "warn") console.warn("[tve]", text);
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

/** location 桩：全内联架构下资产相对路径的稳定解析基准（强制给绝对形态，
 *  fill-if-absent 会撞上工具页原生 location——其 pathname 是工具路径） */
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
  toString(): string {
    return this.href;
  },
};

/** navigator 桩（平台无 navigator 时整体安装的缺省形态） */
const navigatorShim = {
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49",
  appVersion: "5.0 (iPhone)",
  platform: "ios",
  language: "zh-CN",
  languages: ["zh-CN"],
  onLine: true,
  maxTouchPoints: 1,
  hardwareConcurrency: 4,
};

/** performance 最小形态（wasm 侧 rapier 读 window.performance.now() 作时钟基准） */
interface PerfLike {
  now: () => number;
  timeOrigin?: number;
}

function installWindow(): void {
  let existing: Record<string, unknown> | null = null;
  try {
    existing = typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : null;
  } catch {
    existing = null;
  }
  if (existing && typeof existing === "object") {
    mergeKeys(existing, win as Record<string, unknown>, Object.keys(win));
    windowRef.current = existing;
    try {
      window = existing as unknown as Window & typeof globalThis; // 重绑遮蔽形参
    } catch {
      /* 严格模式未声明 → globalThis 写入已覆盖 */
    }
    setGlobal("window", existing);
  } else {
    windowRef.current = win as Record<string, unknown>;
    try {
      window = win as unknown as Window & typeof globalThis;
    } catch {
      /* 同上 */
    }
    setGlobal("window", win);
  }
  // self/parent/top 自引用（防 iframe 判断误炸；postLog 的 window.parent 由此可回环）。
  // 注意 globalThis 必须保持真实全局对象，不做任何改写。
  const selfRef = existing && typeof existing === "object" ? existing : (win as Record<string, unknown>);
  setGlobal("self", selfRef);
  setGlobal("parent", selfRef);
  setGlobal("top", selfRef);
}

function installMiscGlobals(): void {
  // location：运行时以它为解析基准，强制给稳定绝对形态（fill-if-absent 会撞上
  // 工具页原生 location——其 pathname 是工具路径，资产相对路径解析会错位）
  setGlobal("location", locationShim);
  try {
    location = locationShim as unknown as Location;
  } catch {
    /* 平台只读访问器 → globalThis 写入已覆盖 */
  }
  try {
    win.location = locationShim; // window.location 消费面同基准
  } catch {
    /* 只读忽略 */
  }
  // navigator/performance：平台原生已有则保留（fill-if-absent）
  let nav: object | null = null;
  try {
    nav = typeof navigator !== "undefined" ? navigator : null;
  } catch {
    nav = null;
  }
  if (!nav || typeof nav !== "object") {
    setGlobal("navigator", { ...navigatorShim });
  }
  let perf: PerfLike | null = null;
  try {
    perf = typeof performance !== "undefined" ? (performance as unknown as PerfLike) : null;
  } catch {
    perf = null;
  }
  let perfShim: PerfLike | null = null;
  if (!perf || typeof perf.now !== "function") {
    const base = Date.now();
    perfShim = { now: () => Date.now() - base, timeOrigin: base };
    setGlobal("performance", perfShim);
  }
  // window.performance：wasm 侧（rapier static accessor）读 window.performance.now()
  // 作时钟基准，缺失即在 wasm 内部 panic（unreachable）——win 对象必须补挂同一实例
  const perfRef: PerfLike | undefined = perf && typeof perf.now === "function" ? perf : perfShim ?? undefined;
  try {
    win.performance = perfRef ?? null;
  } catch {
    /* 平台 window 只读该键时忽略（原生已在） */
  }
  setGlobal("requestAnimationFrame", win.requestAnimationFrame);
  setGlobal("cancelAnimationFrame", win.cancelAnimationFrame);
}

if (bridgeActive()) {
  applyViewport();
  win.requestAnimationFrame = (fn) => host()!.requestAnimationFrame(fn);
  win.cancelAnimationFrame = (id) => host()!.cancelAnimationFrame(id);
  installWindow();
  installMiscGlobals();

  // 视口族全局（live getter）：部分消费点从 globalThis 裸读（如 dom 的
  // clientWidth 桩），只装 window 门面时真机沙箱读不到 → 恒落缺省值
  const viewGlobal = (name: string, get: () => number): void => {
    try {
      Object.defineProperty(globalThis, name, { get, configurable: true });
    } catch {
      /* 平台全局只读按缺省 */
    }
  };
  viewGlobal("innerWidth", () => view.width);
  viewGlobal("innerHeight", () => view.height);
  viewGlobal("outerWidth", () => view.width);
  viewGlobal("outerHeight", () => view.height);
  viewGlobal("devicePixelRatio", () => view.dpr);

  // bundle 作用域裸赋值（env 拥有的名字；其余名字由各自模块安装）
  try {
    window = win as unknown as Window & typeof globalThis;
  } catch {
    /* 已由 globalThis 兜底 */
  }
  try {
    location = locationShim as unknown as Location;
  } catch {
    /* 同上 */
  }
  try {
    self = win as unknown as Window & typeof globalThis;
  } catch {
    /* 同上 */
  }
}
