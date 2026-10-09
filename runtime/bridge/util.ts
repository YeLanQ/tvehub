import { bridgeLog } from "./log.ts";

// 微信小游戏运行时适配层 —— 共享工具（随 bundle 最先求值，见 bootstrap.js 的装配顺序）。
// 只依赖 wx 原生 API；不使用 eval / new Function（沙箱可能禁用动态求值）。

/** 事件监听器形态（适配层事件对象为鸭子形态，经 unknown 传递） */
type EventListenerLike = (event: unknown) => void;

/** 极简事件发射器：适配层所有监听面（window/document/画布）共用同一形态 */
export class Emitter {
  private _map: Map<string, Set<EventListenerLike>>;

  constructor() {
    this._map = new Map(); // type -> Set<fn>
  }

  on(type: string, fn: unknown): () => void {
    if (typeof fn !== "function") return () => {};
    let set = this._map.get(type);
    if (!set) this._map.set(type, (set = new Set()));
    const listener = fn as EventListenerLike;
    set.add(listener);
    return () => this.off(type, listener);
  }

  off(type: string, fn: EventListenerLike): void {
    const set = this._map.get(type);
    if (set) set.delete(fn);
  }

  once(type: string, fn: EventListenerLike): () => void {
    const off = this.on(type, (ev: unknown) => {
      off();
      fn(ev);
    });
    return off;
  }

  emit(type: string, event: unknown): boolean {
    const set = this._map.get(type);
    if (!set || set.size === 0) return false;
    // 拷贝后派发：监听器内的 off 不打断本轮遍历
    for (const fn of [...set]) {
      try {
        fn(event);
      } catch (e) {
        bridgeLog("error", "[runtime-bridge] 监听器异常:", type, e);
      }
    }
    return true;
  }

  listenerCount(type: string): number {
    const set = this._map.get(type);
    return set ? set.size : 0;
  }
}

/** 事件对象公共字段（pointer/自定义事件共用骨架） */
export interface TveEvent extends Record<string, unknown> {
  type: string;
  target: unknown;
  currentTarget: unknown;
  timeStamp: number;
  bubbles: boolean;
  cancelable: boolean;
  composed: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

export function makeEvent(type: string, props?: Record<string, unknown>): TveEvent {
  return {
    type,
    target: null,
    currentTarget: null,
    timeStamp: Date.now(),
    bubbles: false,
    cancelable: false,
    composed: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
    stopImmediatePropagation() {},
    ...props,
  };
}

/** DOM 元素形态的最小实现（debug 面板/#error 等非关键路径消费） */
export interface ElementStubLike {
  id?: string;
  tagName: string;
  style: Record<string, unknown>;
  children: unknown[];
  textContent: string;
  parentNode: unknown;
  classList: {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    toggle(name: string): void;
    contains(name: string): boolean;
  };
  appendChild(child: unknown): unknown;
  removeChild(child: unknown): unknown;
  addEventListener(...args: unknown[]): void;
  removeEventListener(...args: unknown[]): void;
  setAttribute(name: string, value: unknown): void;
  getAttribute(name: string): string | null;
  querySelector(sel: string): ElementStubLike;
  querySelectorAll(): unknown[];
  getBoundingClientRect(): Record<string, number>;
}

/** 空元素存根（DOM 元素形态的最小实现：debug 面板/#error 等非关键路径消费） */
export function makeElementStub(tag: unknown): ElementStubLike {
  const children: unknown[] = [];
  const queryCache = new Map<string, ElementStubLike>();
  const el: ElementStubLike = {
    tagName: String(tag || "div").toUpperCase(),
    style: {},
    children,
    textContent: "",
    parentNode: null,
    // fail() 写 #error 元素时消费（errorEl.classList.add("visible")）
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains: () => false,
    },
    appendChild(child) {
      children.push(child);
      return child;
    },
    removeChild(child) {
      const i = children.indexOf(child);
      if (i >= 0) children.splice(i, 1);
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() {
      return null;
    },
    querySelector(sel) {
      // 调试面板按 id 取子元素（#dbg-fps 等）：返回记忆化的子存根
      if (!queryCache.has(sel)) {
        const sub = makeElementStub("span");
        sub.style = {};
        queryCache.set(sel, sub);
      }
      return queryCache.get(sel) as ElementStubLike;
    },
    querySelectorAll() {
      return [];
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    },
  };
  return el;
}

/** 把 src 的自有键合并进 dst：优先整描述符拷贝（保留 getter——innerWidth 等必须
 *  跟随视口状态更新），退化裸赋值，逐键独立容错。
 *  平台已有对象（残缺 document/window）不整体替换，原地获得完整 API。 */
export function mergeKeys(
  dst: Record<string, unknown>,
  src: Record<string, unknown>,
  keys: readonly string[],
): number {
  let ok = 0;
  for (const key of keys) {
    let done = false;
    try {
      const desc = Object.getOwnPropertyDescriptor(src, key);
      if (desc) {
        Object.defineProperty(dst, key, desc);
        done = true;
      }
    } catch {
      /* 不可配置属性走裸赋值 */
    }
    if (!done) {
      try {
        dst[key] = src[key];
        done = dst[key] === src[key];
      } catch {
        done = false;
      }
    }
    if (done) ok += 1;
  }
  return ok;
}
