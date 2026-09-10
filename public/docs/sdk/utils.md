# 通用设施：Delegate / Pool / DataCenter

纯脚本通用设施，与引擎接线无关，预览/发布产物行为一致。

## Delegate 委托

多播事件容器（参考 C# 多播委托），组件间解耦通信的标准设施。

```ts
import { Delegate, Component } from "tve";

export class GameEvents extends Component {
  static readonly onScore = new Delegate<(delta: number) => void>();
}

// 订阅方（任意组件）：
const token = GameEvents.onScore.add((delta) => engine.log("得分", delta));
GameEvents.onScore.remove(token);   // 或 remove(原函数)；成员函数建议用令牌退订

// 发布方：
GameEvents.onScore.invoke(10);
```

| 成员 | 说明 |
| --- | --- |
| `add(handler)` | 订阅（同一函数重复订阅只登记一次）；返回移除令牌 `DelegateToken` |
| `remove(tokenOrHandler)` | 退订（令牌或原函数均可）；返回是否移除了一个订阅 |
| `clear()` | 清空全部订阅 |
| `invoke(...args)` | 按订阅顺序逐个调用（参数透传） |
| `count` | 已订阅回调数量 |

语义：`invoke` 按订阅顺序快照迭代，回调内 add/remove 安全；单个回调抛错被隔离上报，不影响其余回调。建议在组件 `onDestroy` 中 `clear()`，避免悬挂订阅。

## Pool 对象池

复用高频小对象，避免频繁创建/销毁带来的卡顿与 GC 压力。典型用途：子弹、特效、飘字、临时列表。

```ts
import { Pool, Component } from "tve";

interface Bullet { active: boolean; x: number; y: number; }

export default class Gun extends Component {
  private pool = new Pool<Bullet>(
    () => ({ active: false, x: 0, y: 0 }),          // 工厂：新建
    { reset: (b) => { b.active = false; }, initial: 10, max: 100 },
  );

  fire() {
    const b = this.pool.get();   // 优先复用空闲对象，池空才新建
    b.active = true;
    // 使用后归还：
    this.pool.put(b);
  }
}
```

| 成员 | 说明 |
| --- | --- |
| `get()` | 取一个对象：优先复用空闲对象，池空则调工厂新建 |
| `put(item)` | 归还：先调 `reset` 清理再入池；空闲数达 `max` 上限则丢弃交给 GC；非本池对象/重复归还返回 `false` |
| `prewarm(n)` | 预热：提前创建 n 个空闲对象（受 max 约束） |
| `clear()` | 清空空闲列表（不影响已借出的对象） |
| `count` | 空闲对象数量 |
| `totalCreated` | 累计创建总数（评估池命中率） |

选项：`reset`（归还时的清理回调，抛错被捕获忽略）、`initial`（预热数量）、`max`（空闲上限）。

## DataCenter 数据中心

跨组件共享的命名数据仓库，内置**热/冷分解**：热数据（活动工作集）即时读写；闲置/超量的数据自动降冷为冻结快照（深拷贝隔离），再次访问自动回温。

```ts
import { dataCenter, Component } from "tve";

export default class Game extends Component {
  onStart() {
    dataCenter.set("score", 0);            // 写即热
  }
  onEnemyKilled() {
    const score = dataCenter.get<number>("score", 0);
    dataCenter.set("score", score + 10);   // 其他组件可随时读取
  }
  onDestroy() {
    dataCenter.delete("score");            // 用完清理，避免悬挂数据
  }
}
```

### 热/冷语义

- 写入（`set`）即进入热区，即时生效；
- 热数据闲置超过 `coldTtl`（缺省 30s）或热区超出 `hotLimit`（缺省 64 条）时，清扫按最久未访问（LRU）**降冷**为冻结快照——降冷后改原引用不影响冷数据；
- 读取冷数据自动**回温**为热数据并返回快照值；热数据返回活动引用（改动实时生效）；
- 清扫默认按 `sweepInterval`（缺省 10s）在 set/get/has 访问时惰性自动触发，也可手动 `sweep()`；
- 冷数据为冻结快照，建议存纯数据（普通对象/数组/原始值）；含函数等不可克隆对象按 结构化克隆 → JSON → 原引用 逐级兜底。

### API

```ts
dataCenter.set(key, value);      // 写入（写即热；同名冷数据快照被覆盖）
dataCenter.get<number>(key, 0);  // 读取（未命中返回 defaultValue）
dataCenter.has(key);             // 是否存在（热或冷）
dataCenter.delete(key);          // 删除（热/冷一并移除）
dataCenter.keys();               // 全部键名（热 + 冷）
dataCenter.hotKeys();            // 热数据键名
dataCenter.coldKeys();           // 冷数据键名
dataCenter.warm(key);            // 手动回温（返回是否存在）
dataCenter.cool(key);            // 手动降冷（返回是否降冷）
dataCenter.sweep();              // 手动清扫（返回降冷条数）
dataCenter.stats();              // { hot, cold, sweeps, promotions, hits, misses }
dataCenter.configure({ hotLimit: 128, coldTtl: 60000, autoSweep: true, sweepInterval: 5000 });
```

需要隔离时 `new DataCenter(options)` 创建独立实例，不影响全局单例 `dataCenter`。
