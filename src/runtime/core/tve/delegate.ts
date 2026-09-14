// ---------------------------------------------------------------------------
// 委托（Delegate）：多播事件容器（参考 C# 多播委托）。
// 广播式回调的登记与触发，回调异常逐个隔离上报，不影响其余回调与其他脚本；
// invoke 用快照迭代，回调内 add/remove 自身或他人均安全。
// ---------------------------------------------------------------------------
import { postLog } from "../log";

/** 委托移除令牌（add 返回；remove 可传令牌或原函数） */
class DelegateToken {
  constructor(seq) {
    this.__delegateToken = seq;
  }
}

class Delegate {
  constructor() {
    this.__handlers = [];
    this.__seq = 0;
  }

  /** 已订阅回调数量 */
  get count() {
    return this.__handlers.length;
  }

  /**
   * 订阅回调：同一函数重复订阅只登记一次。
   * @param {Function} fn 回调（成员函数建议先 bind，或用返回的令牌退订）
   * @returns {DelegateToken|null} 移除令牌（非法入参返回 null）
   */
  add(fn) {
    if (typeof fn !== "function") return null;
    if (this.__handlers.some((h) => h.fn === fn)) return fn;
    const token = new DelegateToken((this.__seq += 1));
    this.__handlers.push({ fn, token });
    return token;
  }

  /**
   * 退订回调：传 add 返回的令牌或原函数均可。
   * @returns {boolean} 是否移除了一个订阅
   */
  remove(tokenOrFn) {
    const idx = this.__handlers.findIndex((h) => h.fn === tokenOrFn || h.token === tokenOrFn);
    if (idx < 0) return false;
    this.__handlers.splice(idx, 1);
    return true;
  }

  /** 清空全部订阅 */
  clear() {
    this.__handlers.length = 0;
  }

  /**
   * 广播：按订阅顺序逐个调用全部回调。
   * 单个回调抛错只停用该次调用并上报（编辑器控制台/浏览器控制台），不影响其余回调。
   */
  invoke(...args) {
    for (const { fn } of this.__handlers.slice()) {
      try {
        fn(...args);
      } catch (e) {
        const text = e && e.message ? e.message : String(e);
        postLog("error", "[tve] 委托回调异常: " + text);
        console.error(e);
      }
    }
  }
}

export { Delegate, DelegateToken };