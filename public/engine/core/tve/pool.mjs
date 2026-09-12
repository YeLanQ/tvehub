// ---------------------------------------------------------------------------
// 对象池（Pool）：复用对象，避免频繁创建/销毁带来的卡顿与 GC 压力。
// get 复用空闲对象（无则新建）；put 归还（先调 reset 清理，空闲数达上限则丢弃）。
// 池只回收自己发出的对象：重复归还/外来对象会被拒绝。
// ---------------------------------------------------------------------------
import { postLog } from "../log.mjs";

class Pool {
  /**
   * @param {Function} factory 对象工厂（无参；新建对象时调用）
   * @param {{reset?: Function, initial?: number, max?: number}} [options]
   *        reset = 归还时清理回调；initial = 预热数量；max = 空闲上限（缺省无限）
   */
  constructor(factory, options) {
    if (typeof factory !== "function") {
      throw new Error("[tve] Pool 需要一个 factory 工厂函数");
    }
    const o = options && typeof options === "object" ? options : {};
    this.__factory = factory;
    this.__reset = typeof o.reset === "function" ? o.reset : null;
    this.__max = typeof o.max === "number" && Number.isFinite(o.max) ? Math.max(0, Math.floor(o.max)) : Infinity;
    this.__free = [];
    this.__live = new Set();
    this.__created = 0;
    const initial = typeof o.initial === "number" && Number.isFinite(o.initial) ? Math.max(0, Math.floor(o.initial)) : 0;
    if (initial > 0) this.prewarm(initial);
  }

  /** 空闲对象数量 */
  get count() {
    return this.__free.length;
  }

  /** 累计创建的对象总数（评估池命中率用） */
  get totalCreated() {
    return this.__created;
  }

  /** 预热：提前创建 n 个空闲对象（受 max 上限约束） */
  prewarm(n) {
    const total = typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    while (this.__free.length < Math.min(total, this.__max)) {
      this.__free.push(this.__create());
    }
  }

  __create() {
    this.__created += 1;
    return this.__factory();
  }

  /** 取一个对象：优先复用空闲对象，池空则新建 */
  get() {
    const item = this.__free.pop() ?? this.__create();
    this.__live.add(item);
    return item;
  }

  /**
   * 归还对象：先调用 reset 清理（若配置），再入空闲池（达 max 上限则丢弃交给 GC）。
   * 非本池发出的对象或重复归还返回 false。
   */
  put(item) {
    if (!this.__live.delete(item)) return false;
    if (this.__reset) {
      try {
        this.__reset(item);
      } catch (e) {
        postLog("warn", "[tve] 对象池 reset 异常: " + (e && e.message ? e.message : String(e)));
      }
    }
    if (this.__free.length < this.__max) this.__free.push(item);
    return true;
  }

  /** 清空空闲列表（释放引用交给 GC；不影响已借出的对象） */
  clear() {
    this.__free.length = 0;
  }
}

export { Pool };