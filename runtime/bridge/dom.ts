// 桥接核心 · document：平台已有 document 不整体替换（键级合并——工具游戏帧的
// document 是残缺骨架，缺 createElementNS/getElementById），缺失时整体安装。
// 画布消费走 canvas2d 工厂，图片消费走 net.js 的 Image 形态。

import { bridgeActive } from "./host.ts";
import { locationShim, view } from "./env.ts";
import { Emitter, makeElementStub, mergeKeys, type ElementStubLike } from "./util.ts";
import { createCanvas2d, screenCanvas } from "./canvas.ts";
import { createImageElement } from "./image.ts";

export const docEvents = new Emitter();

/** 页面可见性状态（events.js 按 wx.onShow/onHide 更新并派发 visibilitychange） */
export const visibility: { hidden: boolean; state: string } = { hidden: false, state: "visible" };

function makeAppElement(): ElementStubLike {
  const el = makeElementStub("div");
  try {
    Object.defineProperty(el, "clientWidth", { configurable: true, get: () => viewWidth() });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => viewHeight() });
  } catch {
    /* 尺寸访问器失败按 window 回退 */
  }
  return el;
}

function viewWidth(): number {
  // 直接读 env.view（env 本就已在 import 图内）：此前读 globalThis.innerWidth，
  // 但该全局从未被安装（innerWidth 只装在 window 门面上），真机沙箱恒 undefined
  // → 恒落 375 兜底 → 舞台按假尺寸 setSize（真机拉伸根因，V8 读数实证）
  return view.width;
}

function viewHeight(): number {
  return view.height;
}

const appElement = makeAppElement();
const errorElement = makeElementStub("div");
errorElement.id = "error";

// 首个 canvas 归渲染器：THREE.WebGLRenderer 不传 canvas 时自建 domElement
// （document.createElementNS(ns, "canvas")）——若落进离屏链，整个渲染画在
// 离屏画布上，屏上画布永不被绘制 = 帧循环/脚本照常跑但黑屏
let firstCanvasTaken = false;

function createElementByTag(tag: unknown): unknown {
  const name = String(tag || "").toLowerCase();
  if (name === "canvas") {
    if (!firstCanvasTaken && screenCanvas) {
      firstCanvasTaken = true;
      return screenCanvas;
    }
    return createCanvas2d(300, 150);
  }
  if (name === "img" || name === "image") return createImageElement();
  return makeElementStub(name || "div");
}

/** document 桩形态（引擎/three 消费的标准子集；未列成员经索引签名兼容） */
interface DocumentShim extends Record<string, unknown> {
  baseURI: string;
  documentURI: string;
  getElementById(id: unknown): unknown;
  createElement(tag: unknown): unknown;
  createElementNS(ns: unknown, tag: unknown): unknown;
  createTextNode(text: unknown): { nodeType: number; nodeValue: string; textContent: string };
  createDocumentFragment(): ElementStubLike;
  querySelector(selector: unknown): unknown;
  querySelectorAll(): unknown[];
  addEventListener(type: string, fn: unknown, options?: unknown): void;
  removeEventListener(type: string, fn: unknown, options?: unknown): void;
  dispatchEvent(ev: { type?: string } | null): boolean;
  documentElement?: ElementStubLike;
  body?: ElementStubLike;
  head?: ElementStubLike;
}

const documentStub: DocumentShim = {
  baseURI: locationShim.href,
  documentURI: locationShim.href,
  getElementById(id: unknown) {
    if (id === "app") return appElement;
    if (id === "error") return errorElement;
    return null;
  },
  createElement(tag: unknown) {
    return createElementByTag(tag);
  },
  createElementNS(_ns: unknown, tag: unknown) {
    return createElementByTag(tag);
  },
  createTextNode(text: unknown) {
    return { nodeType: 3, nodeValue: String(text ?? ""), textContent: String(text ?? "") };
  },
  createDocumentFragment() {
    return makeElementStub("#fragment");
  },
  querySelector(selector: unknown) {
    const sel = String(selector || "").toLowerCase();
    if (sel === "canvas") return screenCanvas;
    return null;
  },
  querySelectorAll() {
    return [];
  },
  addEventListener(type: string, fn: unknown, _options?: unknown) {
    docEvents.on(type, fn);
  },
  removeEventListener(type: string, fn: unknown, _options?: unknown) {
    docEvents.off(type, fn as (event: unknown) => void);
  },
  dispatchEvent(ev: { type?: string } | null) {
    if (ev && typeof ev.type === "string") docEvents.emit(ev.type, ev);
    return true;
  },
};

// hidden/visibilityState 以 getter 提供（wx.onShow/onHide 时随 visibility 更新）
try {
  Object.defineProperty(documentStub, "hidden", { configurable: true, get: () => visibility.hidden });
  Object.defineProperty(documentStub, "visibilityState", {
    configurable: true,
    get: () => visibility.state,
  });
} catch {
  /* 访问器失败按普通属性 */
}
documentStub.documentElement = makeElementStub("html");
documentStub.body = makeElementStub("body");
documentStub.head = makeElementStub("head");

export const documentShim: DocumentShim = documentStub;

export function installDocument(): void {
  if (!bridgeActive()) return;
  let existing: Record<string, unknown> | null = null;
  try {
    existing = typeof document !== "undefined" ? (document as unknown as Record<string, unknown>) : null;
  } catch {
    existing = null;
  }
  if (existing && typeof existing === "object") {
    mergeKeys(existing, documentStub as Record<string, unknown>, Object.keys(documentStub));
    try {
      document = existing as unknown as Document; // 重绑遮蔽形参（bundle 作用域统一生效）
    } catch {
      /* 严格模式未声明 → globalThis 写入已覆盖 */
    }
    try {
      (globalThis as unknown as Record<string, unknown>).document = existing;
    } catch {
      /* 只读全局忽略 */
    }
    try {
      if (typeof GameGlobal !== "undefined" && GameGlobal) GameGlobal.document = existing;
    } catch {
      /* 同上 */
    }
  } else {
    try {
      document = documentStub as unknown as Document;
    } catch {
      /* 同上 */
    }
    try {
      (globalThis as unknown as Record<string, unknown>).document = documentStub;
    } catch {
      /* 同上 */
    }
    try {
      if (typeof GameGlobal !== "undefined" && GameGlobal) GameGlobal.document = documentStub;
    } catch {
      /* 同上 */
    }
  }
}

installDocument();

// bundle 作用域裸赋值兜底（installDocument 内的赋值位于函数作用域，不重绑外层）
try {
  document = documentStub as unknown as Document;
} catch {
  /* 已由 globalThis 兜底 */
}
