// ---------------------------------------------------------------------------
// 数据中心（DataCenter）：跨组件共享的命名数据仓库，内置热/冷分解。
// - 热数据（hot）：常驻内存的活动工作集，set/get 即时生效；
// - 冷数据（cold）：长期未访问或超出热容量的数据自动"降温"为冻结快照
//   （深拷贝隔离，避免误改），再次访问自动"回温"为热数据；
// - 降冷时机：访问时惰性自动清扫（autoSweep/sweepInterval），也可手动 sweep()。
// 冷数据建议存纯数据（普通对象/数组/原始值）；含函数等不可克隆对象按
// 结构化克隆 → JSON → 原引用的顺序降级兜底。
// ---------------------------------------------------------------------------

/** 数据中心配置项（configure 增量合并；与 tve.d.ts DataCenterOptions 镜像） */
export interface DataCenterOptions {
  hotLimit?: number;
  coldTtl?: number;
  autoSweep?: boolean;
  sweepInterval?: number;
}

/** 统计快照（与 tve.d.ts DataCenterStats 镜像） */
export interface DataCenterStats {
  hot: number;
  cold: number;
  sweeps: number;
  promotions: number;
  hits: number;
  misses: number;
}

/** 热数据元信息（LRU 清扫依据） */
interface DataMeta {
  lastAccess: number;
  accessSeq: number;
}

/** 冷数据条目（冻结快照 + 降冷时刻） */
interface ColdEntry {
  snapshot: unknown;
  cooledAt: number;
}

const DATA_DEFAULT_OPTIONS = {
  hotLimit: 64,
  coldTtl: 30000,
  autoSweep: true,
  sweepInterval: 10000,
};

/** 深拷贝冻结快照：结构化克隆 → JSON → 原引用（逐级兜底） */
function dataFreezeClone(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch {
    /* 不可结构化克隆（含函数等）→ 尝试 JSON */
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    /* JSON 不安全 → 原引用兜底 */
  }
  return value;
}

class DataCenter {
  __hot: Map<string, unknown>;
  __meta: Map<string, DataMeta>;
  __cold: Map<string, ColdEntry>;
  __options: Required<DataCenterOptions>;
  __lastSweep: number;
  __sweeps: number;
  __accessSeq: number;
  __promotions: number;
  __hits: number;
  __misses: number;

  constructor(options?: DataCenterOptions) {
    this.__hot = new Map<string, unknown>();
    this.__meta = new Map<string, DataMeta>();
    this.__cold = new Map<string, ColdEntry>();
    this.__options = { ...DATA_DEFAULT_OPTIONS };
    this.__lastSweep = Date.now();
    this.__sweeps = 0;
    this.__accessSeq = 0;
    this.__promotions = 0;
    this.__hits = 0;
    this.__misses = 0;
    if (options) this.configure(options);
  }

  configure(options: DataCenterOptions): void {
    const o: DataCenterOptions = options && typeof options === "object" ? options : {};
    if (typeof o.hotLimit === "number" && Number.isFinite(o.hotLimit)) {
      this.__options.hotLimit = Math.max(1, Math.floor(o.hotLimit));
    }
    if (typeof o.coldTtl === "number" && Number.isFinite(o.coldTtl)) {
      this.__options.coldTtl = Math.max(0, Math.floor(o.coldTtl));
    }
    if (typeof o.autoSweep === "boolean") this.__options.autoSweep = o.autoSweep;
    if (typeof o.sweepInterval === "number" && Number.isFinite(o.sweepInterval)) {
      this.__options.sweepInterval = Math.max(0, Math.floor(o.sweepInterval));
    }
  }

  __now(): number {
    return Date.now();
  }

  __lazySweep(): void {
    const now = this.__now();
    if (this.__options.autoSweep && now - this.__lastSweep >= this.__options.sweepInterval) {
      this.sweep();
    }
  }

  __coolKey(key: string, now: number): boolean {
    const value = this.__hot.get(key);
    this.__hot.delete(key);
    this.__meta.delete(key);
    this.__cold.set(key, { snapshot: dataFreezeClone(value), cooledAt: now });
    return true;
  }

  __warmKey(key: string): void {
    const entry = this.__cold.get(key);
    this.__cold.delete(key);
    // 断言安全：调用点均以 __cold.has(key) 为前提，冷区条目必然存在
    this.__hot.set(key, entry!.snapshot);
    this.__meta.set(key, { lastAccess: this.__now(), accessSeq: (this.__accessSeq += 1) });
    this.__promotions += 1;
  }

  set(key: string, value: unknown): void {
    if (typeof key !== "string" || !key) return;
    this.__lazySweep();
    this.__cold.delete(key);
    this.__hot.set(key, value);
    this.__meta.set(key, { lastAccess: this.__now(), accessSeq: (this.__accessSeq += 1) });
  }

  get(key: string, defaultValue?: unknown): unknown {
    if (typeof key !== "string" || !key) return defaultValue;
    this.__lazySweep();
    if (this.__hot.has(key)) {
      const meta = this.__meta.get(key);
      // hot 命中时 meta 必然存在（set/__warmKey 写 hot 时同步写入）
      meta!.lastAccess = this.__now();
      meta!.accessSeq = (this.__accessSeq += 1);
      this.__hits += 1;
      return this.__hot.get(key);
    }
    if (this.__cold.has(key)) {
      this.__warmKey(key);
      this.__hits += 1;
      return this.__hot.get(key);
    }
    this.__misses += 1;
    return defaultValue;
  }

  has(key: string): boolean {
    if (typeof key !== "string" || !key) return false;
    this.__lazySweep();
    return this.__hot.has(key) || this.__cold.has(key);
  }

  delete(key: string): boolean {
    if (typeof key !== "string" || !key) return false;
    this.__lazySweep();
    const existed = this.__hot.delete(key);
    this.__meta.delete(key);
    const coldExisted = this.__cold.delete(key);
    return existed || coldExisted;
  }

  keys(): string[] {
    return [...this.__hot.keys(), ...this.__cold.keys()];
  }

  hotKeys(): string[] {
    return [...this.__hot.keys()];
  }

  coldKeys(): string[] {
    return [...this.__cold.keys()];
  }

  warm(key: string): boolean {
    if (typeof key !== "string" || !key) return false;
    if (this.__cold.has(key)) {
      this.__warmKey(key);
      return true;
    }
    return this.__hot.has(key);
  }

  cool(key: string): boolean {
    if (typeof key !== "string" || !key) return false;
    if (!this.__hot.has(key)) return false;
    this.__coolKey(key, this.__now());
    return true;
  }

  sweep(): number {
    const now = this.__now();
    this.__lastSweep = now;
    let cooled = 0;
    for (const [key, meta] of [...this.__meta]) {
      if (now - meta.lastAccess >= this.__options.coldTtl && this.__hot.has(key)) {
        this.__coolKey(key, now);
        cooled += 1;
      }
    }
    if (this.__hot.size > this.__options.hotLimit) {
      const order = [...this.__meta.entries()]
        .filter(([key]) => this.__hot.has(key))
        .sort((a, b) => a[1].accessSeq - b[1].accessSeq);
      for (const [key] of order) {
        if (this.__hot.size <= this.__options.hotLimit) break;
        this.__coolKey(key, now);
        cooled += 1;
      }
    }
    this.__sweeps += 1;
    return cooled;
  }

  stats(): DataCenterStats {
    return {
      hot: this.__hot.size,
      cold: this.__cold.size,
      sweeps: this.__sweeps,
      promotions: this.__promotions,
      hits: this.__hits,
      misses: this.__misses,
    };
  }
}

/** 全局数据中心单例（跨组件共享游戏数据；需要隔离实例时可 new DataCenter()） */
const dataCenter = new DataCenter();

export { DataCenter, dataCenter };
