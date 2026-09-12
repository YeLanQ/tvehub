// ---------------------------------------------------------------------------
// tween —— 补间动画系统（脚本 SDK "tve" 的 tween/easing 导出实现）。
// 类型契约见 src/framework/scripting/tve.d.ts（两者保持镜像同步）。
//
// 设计约束：
// - 纯脚本设施：不依赖 three / 宿主接线（host），任何目标（Entity 变换、
//   UI Widget 字段、普通对象）都按"带 getter/setter 的普通属性"读写——
//   Entity 的 position/rotation/scale 与 UI 字段访问器天然适配；
// - 由 tve.mjs 聚合：时间驱动挂 tickTime（每帧、脚本 onUpdate 前），
//   全部工厂创建即登记推进（首个 tick 前仍可链式配置 delay 等）；
// - 组（sequence/parallel）以受管模式驱动子 tween（不进全局活动列表），
//   构造时接管子 tween 的播放态；
// - 回调错误隔离上报（postLog → 编辑器控制台），单个 tween 异常不影响其他。
// ---------------------------------------------------------------------------

import { postLog } from "./log.mjs";

// ---------------------------------------------------------------------------
// 缓动函数集（Robert Penner 标准族；f(0)=0、f(1)=1，back/elastic 中间超调）
// ---------------------------------------------------------------------------

const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;
const c5 = (2 * Math.PI) / 4.5;

const n1 = 7.5625;
const d1 = 2.75;

function bounceOut(t) {
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}

/** 缓动函数表：名称 → (t 0..1) => eased（结果可超 0..1：back/elastic） */
export const EASING = {
  linear: (t) => t,

  quadIn: (t) => t * t,
  quadOut: (t) => 1 - (1 - t) * (1 - t),
  quadInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),

  cubicIn: (t) => t * t * t,
  cubicOut: (t) => 1 - Math.pow(1 - t, 3),
  cubicInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),

  quartIn: (t) => t * t * t * t,
  quartOut: (t) => 1 - Math.pow(1 - t, 4),
  quartInOut: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),

  quintIn: (t) => t * t * t * t * t,
  quintOut: (t) => 1 - Math.pow(1 - t, 5),
  quintInOut: (t) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2),

  sineIn: (t) => 1 - Math.cos((t * Math.PI) / 2),
  sineOut: (t) => Math.sin((t * Math.PI) / 2),
  sineInOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,

  expoIn: (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  expoOut: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  expoInOut: (t) => {
    if (t === 0) return 0;
    if (t === 1) return 1;
    return t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2;
  },

  circIn: (t) => 1 - Math.sqrt(1 - t * t),
  circOut: (t) => Math.sqrt(1 - Math.pow(t - 1, 2)),
  circInOut: (t) =>
    t < 0.5
      ? (1 - Math.sqrt(1 - Math.pow(2 * t, 2))) / 2
      : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2,

  backIn: (t) => c3 * t * t * t - c1 * t * t,
  backOut: (t) => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2),
  backInOut: (t) =>
    t < 0.5
      ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
      : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2,

  elasticIn: (t) => {
    if (t === 0) return 0;
    if (t === 1) return 1;
    return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4);
  },
  elasticOut: (t) => {
    if (t === 0) return 0;
    if (t === 1) return 1;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  elasticInOut: (t) => {
    if (t === 0) return 0;
    if (t === 1) return 1;
    if (t < 0.5) return -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2;
    return (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1;
  },

  bounceIn: (t) => 1 - bounceOut(1 - t),
  bounceOut,
  bounceInOut: (t) => (t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2),
};

const EASE_LINEAR = EASING.linear;

/** 按名解析缓动函数（未知名称回退 linear 并告警；函数原样返回） */
function resolveEase(nameOrFn) {
  if (typeof nameOrFn === "function") return nameOrFn;
  if (typeof nameOrFn === "string" && EASING[nameOrFn]) return EASING[nameOrFn];
  postLog("warn", `[tve] 未知缓动名: ${String(nameOrFn)}（回退 linear）`);
  return EASE_LINEAR;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 回调错误隔离上报（参照 Delegate：捕获、上报、继续） */
function fireCb(fn, ...args) {
  if (typeof fn !== "function") return;
  try {
    fn(...args);
  } catch (e) {
    postLog("error", "[tve] tween 回调异常: " + (e && e.message ? e.message : String(e)));
    console.error(e);
  }
}

// ---------------------------------------------------------------------------
// Tween：补间句柄（工厂创建；链式配置 + 播放控制）
//
// 运行模型：delay（一次性）→ 循环 N 次（yoyo 交替方向）；每帧按 easing 后
// 系数 k 经 driver.apply(k) 写入目标并触发 onUpdate(value, k)。
// 工厂创建即 __begin 登记全局活动列表，但 __attach（读取 delay 等配置）推迟到
// 首个 tick——创建语句内追加的 .delay()/.loop() 等链式配置仍全部生效。
// ---------------------------------------------------------------------------

class Tween {
  constructor() {
    // ---- 链式配置 ----
    this.__easeFn = EASE_LINEAR;
    this.__delay = 0;
    this.__loops = 1; // -1 = 无限
    this.__yoyo = false;
    this.__cbStart = null;
    this.__cbUpdate = null;
    this.__cbDone = null;
    this.__next = null; // then 链：本 tween 完成后自动启动
    // ---- 驱动（工厂注入；null = 纯延时/回调占位） ----
    this.__driver = null;
    // ---- 运行态 ----
    this.__state = "idle"; // idle | playing | paused | completed | stopped
    this.__begun = false; // attach（配置快照）是否已执行
    this.__delayLeft = 0;
    this.__clock = 0; // 当前循环已播时长（秒）
    this.__loopsDone = 0;
    this.__dir = 1; // 1 正放 / -1 yoyo 反向
    this.__firedStart = false;
    this.__elapsed = 0; // 累计活跃播放时长（不含 delay）
  }

  // ---- 链式配置 ----

  /** 缓动：名称（"quadOut" 等，见 easing 表）或自定义函数 (t 0..1) => eased */
  easing(nameOrFn) {
    this.__easeFn = resolveEase(nameOrFn);
    return this;
  }

  /** 开始前延时（秒；多次调用取最后一次） */
  delay(seconds) {
    this.__delay =
      typeof seconds === "number" && Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    return this;
  }

  /** 循环次数：1 = 单次（缺省）；n = n 次；-1 = 无限循环 */
  loop(count) {
    this.__loops =
      typeof count === "number" && Number.isFinite(count)
        ? count < 0
          ? -1
          : Math.max(1, Math.round(count))
        : 1;
    return this;
  }

  /** 往返：偶数次循环反向插值（终点 → 起点） */
  yoyo(on) {
    this.__yoyo = on !== false;
    return this;
  }

  /** 开始回调（delay 结束、首轮插值前触发一次；属性插值在此采集起点） */
  onStart(cb) {
    this.__cbStart = cb;
    return this;
  }

  /**
   * 每帧回调：value = 插值输出（value/color tween 为插值结果；其余为系数），
   * t = easing 后的插值系数 0..1。
   */
  onUpdate(cb) {
    this.__cbUpdate = cb;
    return this;
  }

  /** 完成回调（循环计满触发一次；stop(true) 快进完成同样触发） */
  onComplete(cb) {
    this.__cbDone = cb;
    return this;
  }

  /**
   * 串接：本 tween 完成后自动启动 next（next 无需手动 start）。
   * 返回 next 以便继续链式配置。next 由本链接管（与组同语义：移出全局
   * 活动列表并重置播放态——工厂的自动开始随之失效）。
   */
  then(next) {
    if (next instanceof Tween && next !== this) {
      this.__next = next;
      next.__detach();
      next.__state = "idle";
      next.__begun = false;
    }
    return next;
  }

  // ---- 控制 ----

  /**
   * 停止：tween 移出活动列表不再推进（组内子 tween 被组跳过）。
   * complete = true 时先快进到最终落点并触发 onComplete（不启动 then 链）。
   */
  stop(complete) {
    if (this.__state === "completed" || this.__state === "stopped") return this;
    if (complete === true) {
      this.__completeNow(true);
      return this;
    }
    this.__state = "stopped";
    this.__detach();
    return this;
  }

  /** 暂停（保留进度；组内子 tween 暂停会阻塞组的完成判定） */
  pause() {
    if (this.__state === "playing") this.__state = "paused";
    return this;
  }

  /** 从暂停处继续 */
  resume() {
    if (this.__state === "paused") this.__state = "playing";
    return this;
  }

  // ---- 只读状态 ----

  /** 是否正在推进（不含暂停） */
  get playing() {
    return this.__state === "playing";
  }
  /** 是否处于暂停态 */
  get paused() {
    return this.__state === "paused";
  }
  /** 是否已完成（自然播完或 stop(true)；stop(false) 后为 false） */
  get completed() {
    return this.__state === "completed";
  }
  /** 配置的时长（秒；组容器为 0） */
  get duration() {
    return this.__driver ? this.__driver.duration : 0;
  }
  /** 累计活跃播放时长（秒；不含 delay） */
  get elapsed() {
    return this.__elapsed;
  }
  /** 当前循环进度 0..1（easing 前；组容器无意义） */
  get progress() {
    const d = this.duration;
    return d > 0 ? clamp01(this.__clock / d) : this.__state === "completed" ? 1 : 0;
  }
  /** 已完成的循环数 */
  get loopsDone() {
    return this.__loopsDone;
  }

  // ---- 内部：启动（工厂调用 / then 链 / 组接管；managed = 组内子 tween，不进全局列表） ----

  __begin(managed) {
    if (this.__state !== "idle") return;
    this.__state = "playing";
    this.__begun = false; // attach 推迟到首个 tick（保留链式配置窗口）
    if (managed !== true) ACTIVE.add(this);
  }

  __attach() {
    this.__delayLeft = this.__delay;
    this.__clock = 0;
    this.__loopsDone = 0;
    this.__dir = 1;
    this.__firedStart = false;
    this.__elapsed = 0;
  }

  __detach() {
    ACTIVE.delete(this);
  }

  /**
   * 帧前导：attach → delay 扣除 → onStart（含 driver.prepare 采集起点）。
   * @returns 剩余可推进的 dt；仍在 delay 中返回 null
   */
  __preamble(dt) {
    if (this.__state !== "playing") return null;
    if (!this.__begun) {
      this.__attach();
      this.__begun = true;
    }
    if (this.__delayLeft > 0) {
      this.__delayLeft -= dt;
      if (this.__delayLeft > 0) return null;
      dt = -this.__delayLeft; // 余量进入本轮
      this.__delayLeft = 0;
    }
    if (!this.__firedStart) {
      this.__firedStart = true;
      this.__driver?.prepare?.();
      fireCb(this.__cbStart);
    }
    return dt;
  }

  /** 每帧推进（全局 tick 驱动顶层 tween；组覆写本方法驱动子 tween） */
  __tick(dt) {
    const rest = this.__preamble(dt);
    if (rest === null) return;
    const duration = this.duration;
    if (duration <= 0) {
      this.__setCompleted();
      return;
    }
    this.__elapsed += rest;
    this.__clock += rest;
    // 循环折算（duration 极小时防死循环）
    let guard = 0;
    while (this.__clock >= duration) {
      this.__loopsDone += 1;
      if (this.__loops < 0 || this.__loopsDone < this.__loops) {
        this.__clock -= duration;
        if (this.__yoyo) this.__dir = -this.__dir;
        if (++guard > 1e6) {
          this.__clock = 0;
          break;
        }
      } else {
        this.__clock = duration;
        this.__setCompleted();
        return;
      }
    }
    this.__applyAt(clamp01(this.__clock / duration));
  }

  /** 按循环内进度（easing 前）写入目标并触发 onUpdate */
  __applyAt(rawT) {
    if (!this.__driver) return;
    const t = this.__dir > 0 ? rawT : 1 - rawT;
    const k = clamp01(this.__easeFn(t));
    const value = this.__driver.apply(k);
    fireCb(this.__cbUpdate, value, k);
  }

  /** yoyo 反向轮的最终落点（正向 1 / 反向 0） */
  __finalT() {
    return this.__dir > 0 ? 1 : 0;
  }

  /** 完成收尾：落点写入 → 完成态 → onComplete → then 链 */
  __setCompleted() {
    this.__state = "completed";
    this.__detach();
    if (this.__driver) {
      const k = clamp01(this.__easeFn(this.__finalT()));
      const value = this.__driver.apply(k);
      fireCb(this.__cbUpdate, value, k);
    }
    fireCb(this.__cbDone);
    const next = this.__next;
    if (next instanceof Tween && next.__state === "idle") next.__begin();
  }

  /** stop(true)：快进完成（从未启动过也补 onStart/prepare 保证回调对称） */
  __completeNow() {
    if (this.__state === "playing" && !this.__begun) {
      this.__attach();
      this.__begun = true;
    }
    if (!this.__firedStart) {
      this.__firedStart = true;
      this.__driver?.prepare?.();
      fireCb(this.__cbStart);
    }
    this.__state = "completed";
    this.__detach();
    if (this.__driver) {
      const k = clamp01(this.__easeFn(this.__finalT()));
      const value = this.__driver.apply(k);
      fireCb(this.__cbUpdate, value, k);
    }
    fireCb(this.__cbDone);
    // 用户显式终止：不自动启动 then 链（与自然完成区分）
  }
}

// ---------------------------------------------------------------------------
// 组容器：sequence（依次）/ parallel（同时）。构造时接管子 tween（移出全局
// 活动列表并重置为 idle，由组以受管模式驱动）；组级 delay/loop/onStart/
// onComplete 可用；yoyo 对组无效（反向播放序列语义不明确，子 tween 可各自 yoyo）。
// ---------------------------------------------------------------------------

class TweenGroup extends Tween {
  constructor(children) {
    super();
    this.__children = (Array.isArray(children) ? children : []).filter((c) => c instanceof Tween);
  }

  /** yoyo 对组无效（no-op） */
  yoyo() {
    return this;
  }

  /** 接管子 tween：移出全局活动列表并重置为 idle（播放态由组管理） */
  __adoptAll() {
    for (const c of this.__children) {
      c.__detach();
      c.__state = "idle";
      c.__begun = false;
    }
  }
}

class SequenceTween extends TweenGroup {
  __begin(managed) {
    if (this.__state !== "idle") return;
    this.__adoptAll();
    this.__cursor = 0;
    super.__begin(managed);
    if (!this.__children.length) this.__setCompleted(); // 空组立即完成
  }

  __tick(dt) {
    const rest = this.__preamble(dt);
    if (rest === null) return;
    this.__elapsed += rest;
    // 依次驱动：完成一个推进光标（同帧内继续启动下一个，短 tween 不丢帧）
    let guard = 0;
    while (this.__cursor < this.__children.length && ++guard < 1e4) {
      const child = this.__children[this.__cursor];
      if (child.__state === "idle") child.__begin(true);
      else if (child.__state === "stopped") {
        this.__cursor += 1; // 被外部停止：跳过
        continue;
      }
      child.__tick(rest);
      if (child.__state === "completed") {
        this.__cursor += 1;
        continue;
      }
      break; // playing/paused：本帧到此
    }
    if (this.__cursor >= this.__children.length) {
      this.__loopsDone += 1;
      if (this.__loops < 0 || this.__loopsDone < this.__loops) {
        this.__adoptAll(); // 下一轮序列
        this.__cursor = 0;
      } else {
        this.__setCompleted();
      }
    }
  }
}

class ParallelTween extends TweenGroup {
  __begin(managed) {
    if (this.__state !== "idle") return;
    this.__adoptAll();
    super.__begin(managed);
    if (!this.__children.length) this.__setCompleted();
  }

  __tick(dt) {
    const rest = this.__preamble(dt);
    if (rest === null) return;
    this.__elapsed += rest;
    // 广播全部子 tween；全部终态（完成/被停止）则本组循环结束
    let allDone = true;
    for (const child of this.__children) {
      if (child.__state === "idle") child.__begin(true);
      else if (child.__state === "stopped") continue;
      child.__tick(rest);
      if (child.__state !== "completed") allDone = false;
    }
    if (!allDone) return;
    this.__loopsDone += 1;
    if (this.__loops < 0 || this.__loopsDone < this.__loops) {
      this.__adoptAll();
    } else {
      this.__setCompleted();
    }
  }
}

// ---------------------------------------------------------------------------
// 属性插值驱动（tween.to / tween.from）：数值与 {x,y(,z)} 向量逐分量插值。
// 目标 = 带 getter/setter 的普通对象（Entity 变换与 UI 字段访问器天然适配）；
// to 值缺分量 → 该分量保持不动（部分字段补间）；起点在实际开始时（onStart 前）
// 采集，向量写入合并完整快照（普通对象目标不丢未插值分量）。
// ---------------------------------------------------------------------------

/** 创建属性插值 driver：props = { 键: 数字 | 数值字段对象（部分字段） }；useFrom = props 为起点。
 *  对象值逐字段插值（{x,y,z} 向量 / {x,y} / {left,right,top,bottom} 内边距等任意数值字段），
 *  目标值缺分量保持不动；向量写入合并完整快照（普通对象目标不丢未插值分量）。 */
function makePropsDriver(target, props, useFrom) {
  const spec = []; // [{ key, keys, base, from, to }]
  return {
    duration: 0, // makeTween 统一收敛写入
    prepare() {
      spec.length = 0;
      if (!target || typeof target !== "object") return;
      for (const key of Object.keys(props)) {
        const p = props[key];
        let cur;
        try {
          cur = target[key];
        } catch {
          continue;
        }
        if (typeof cur === "number" && typeof p === "number" && Number.isFinite(p)) {
          spec.push({ key, from: useFrom ? p : cur, to: useFrom ? cur : p });
        } else if (cur && p && typeof cur === "object" && typeof p === "object") {
          const startV = useFrom ? p : cur;
          const endV = useFrom ? cur : p;
          // 两侧都是有限数值的字段参与插值（交集；终值缺分量 = 保持不动）
          const keys = Object.keys(startV).filter(
            (kk) =>
              Number.isFinite(startV[kk]) &&
              endV &&
              typeof endV === "object" &&
              Number.isFinite(endV[kk]),
          );
          if (!keys.length) continue;
          spec.push({
            key,
            keys,
            base: { ...cur }, // 完整快照：写入时保留未插值分量
            from: Object.fromEntries(keys.map((kk) => [kk, startV[kk]])),
            to: Object.fromEntries(keys.map((kk) => [kk, endV[kk]])),
          });
        }
      }
      if (!spec.length) {
        postLog("warn", "[tve] tween.to/from 无可插值属性（目标字段缺失或类型不符）");
      }
    },
    apply(k) {
      for (const s of spec) {
        if (s.base) {
          const outv = { ...s.base };
          for (const kk of s.keys) {
            outv[kk] = s.from[kk] + (s.to[kk] - s.from[kk]) * k;
          }
          writeProp(target, s.key, outv);
        } else {
          writeProp(target, s.key, s.from + (s.to - s.from) * k);
        }
      }
      return undefined;
    },
  };
}

function writeProp(target, key, value) {
  try {
    target[key] = value;
  } catch (e) {
    postLog(
      "warn",
      "[tve] tween 写入属性失败: " + key + " — " + (e && e.message ? e.message : String(e)),
    );
  }
}

// ---------------------------------------------------------------------------
// 数值 / 颜色插值驱动（tween.value / tween.color）
// ---------------------------------------------------------------------------

function makeValueDriver(from, to) {
  const f = typeof from === "number" && Number.isFinite(from) ? from : 0;
  const t = typeof to === "number" && Number.isFinite(to) ? to : f;
  return {
    duration: 0,
    prepare() {},
    apply(k) {
      return f + (t - f) * k;
    },
  };
}

function clampHex(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) & 0xffffff : 0;
}

/** 0xRRGGBB 颜色插值（RGB 通道各自线性，避免数值直插跨通道失真） */
function lerpColor(a, b, k) {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  return (r << 16) | (g << 8) | bl;
}

function makeColorDriver(from, to) {
  const f = clampHex(from);
  const t = clampHex(to);
  return {
    duration: 0,
    prepare() {},
    apply(k) {
      return lerpColor(f, t, k);
    },
  };
}

// ---------------------------------------------------------------------------
// 系统实例：全局活动列表 + 每帧 tick + 工厂 API
// ---------------------------------------------------------------------------

const ACTIVE = new Set();
let timeScale = 1;

/** 每帧推进（tve.mjs tickTime 驱动；dt 为收敛后的帧增量秒数） */
export function tickTweens(dt) {
  if (!ACTIVE.size || dt <= 0) return;
  const scaled = dt * timeScale;
  if (scaled <= 0) return;
  // 快照迭代：回调内创建/停止 tween 均安全
  for (const t of [...ACTIVE]) t.__tick(scaled);
}

/** 重置（installRuntime 重入：清空上一轮预览的残留 tween 与全局时标） */
export function resetTweens() {
  for (const t of ACTIVE) t.__state = "stopped";
  ACTIVE.clear();
  timeScale = 1;
}

function makeTween(driver, duration) {
  const t = new Tween();
  t.__driver = driver;
  driver.duration =
    typeof duration === "number" && Number.isFinite(duration) ? Math.max(0, duration) : 0;
  t.__begin();
  return t;
}

function makeGroup(tweens, Cls) {
  const group = new Cls(tweens);
  group.__begin();
  return group;
}

/** 全局 tween API 单例（tve.mjs re-export 为 "tween"；与 dataCenter 同为全局单例模式） */
const tween = {
  /** 数值/向量属性插值：Entity 变换（position/rotation/scale）、UI 字段、任意对象 */
  to(target, props, duration) {
    return makeTween(makePropsDriver(target, props, false), duration);
  },
  /** 反向插值：props 为起点，渐变回开始时的当前值 */
  from(target, props, duration) {
    return makeTween(makePropsDriver(target, props, true), duration);
  },
  /** 数值插值（onUpdate 收插值结果） */
  value(from, to, duration) {
    return makeTween(makeValueDriver(from, to), duration);
  },
  /** 0xRRGGBB 颜色插值（通道正确；onUpdate 收 0xRRGGBB） */
  color(from, to, duration) {
    return makeTween(makeColorDriver(from, to), duration);
  },
  /** 实体本地位置补间（= to(entity, { position }, duration)） */
  position(entity, to, duration) {
    return makeTween(makePropsDriver(entity, { position: to }, false), duration);
  },
  /** 实体本地旋转补间（度制欧拉角） */
  rotation(entity, toDeg, duration) {
    return makeTween(makePropsDriver(entity, { rotation: toDeg }, false), duration);
  },
  /** 实体本地缩放补间 */
  scale(entity, to, duration) {
    return makeTween(makePropsDriver(entity, { scale: to }, false), duration);
  },
  /** 串行组：依次播放（空数组立即完成） */
  sequence(tweens) {
    return makeGroup(tweens, SequenceTween);
  },
  /** 并行组：同时播放（空数组立即完成） */
  parallel(tweens) {
    return makeGroup(tweens, ParallelTween);
  },
  /** 纯延时占位（序列/then 链用） */
  delay(seconds) {
    const t = new Tween();
    t.delay(seconds);
    t.__begin();
    return t;
  },
  /** 立即回调占位（下一帧 tick 触发；序列/then 链用） */
  call(cb) {
    const t = new Tween();
    if (typeof cb === "function") t.onComplete(cb);
    t.__begin();
    return t;
  },
  /** 停止全部活动 tween（complete = true 先快进终点并触发 onComplete） */
  killAll(complete) {
    for (const t of [...ACTIVE]) t.stop(complete === true);
  },
  /** 暂停全部活动 tween */
  pauseAll() {
    for (const t of ACTIVE) t.pause();
  },
  /** 恢复全部暂停中的 tween */
  resumeAll() {
    for (const t of ACTIVE) t.resume();
  },
  /** 活动 tween 数（含暂停中的） */
  get activeCount() {
    return ACTIVE.size;
  },
  /** 全局时间缩放（0 = 冻结全部 tween；负数按 0，非数忽略） */
  get timeScale() {
    return timeScale;
  },
  set timeScale(v) {
    if (typeof v === "number" && Number.isFinite(v)) {
      timeScale = Math.min(1000, Math.max(0, v));
    }
  },
};

export { tween, Tween, SequenceTween, ParallelTween };
