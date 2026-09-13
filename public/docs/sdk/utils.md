# 通用设施：Delegate / Pool / DataCenter

纯脚本通用设施，与引擎接线无关，预览/发布产物行为一致。三者解决脚本开发的三类常见问题：

- **Delegate**：组件间「发生了什么」的广播（事件解耦）；
- **Pool**：高频小对象的复用（性能）；
- **DataCenter**：跨组件「当前状态是什么」的共享存储（数据解耦）。

## Delegate 委托

多播事件容器（参考 C# 多播委托），组件间解耦通信的标准设施。发布方持有 Delegate，订阅方注册回调；两边都不需要互相 import 运行时（配合 `import type` 只引类型）。

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

语义细节：

- `invoke` 按**订阅顺序快照迭代**：回调内 add/remove 安全（新增的不在本轮触发、移除的不受影响）；
- 单个回调抛错被隔离上报，不影响其余回调；
- **令牌 vs 原函数**：箭头函数每次创建都是新引用，只能用令牌退订；成员函数（`this.onHit`）两种都行，用令牌最稳；
- 建议在组件 `onDestroy` 中 `clear()` 或逐个 `remove`，避免悬挂订阅（订阅方已销毁但委托仍持有其回调）。

### 典型模式：全局事件总线

入口脚本（或任意常驻组件）用静态 Delegate 定义游戏事件，其他组件按需订阅：

```ts
// GameEvents.ts —— 事件定义（挂在入口脚本上常驻）
import { Delegate, Component } from "tve";

export default class GameEvents extends Component {
  static readonly onEnemyDead = new Delegate<(pos: { x: number; y: number; z: number }) => void>();
  static readonly onGameOver = new Delegate<() => void>();
}

// Enemy.ts —— 发布方
import type GameEvents from "./GameEvents";   // type-only，无运行时依赖
export default class Enemy extends Component {
  die() {
    GameEvents.onEnemyDead.invoke(this.entity.position);
  }
}

// ScoreBoard.ts —— 订阅方
import type GameEvents from "./GameEvents";
export default class ScoreBoard extends Component {
  private token?: ReturnType<GameEvents["onEnemyDead"]["add"]>;
  onEnable() { this.token = GameEvents.onEnemyDead.add(() => this.addScore()); }
  onDestroy() { if (this.token) GameEvents.onEnemyDead.remove(this.token); }
  private addScore() { /* ... */ }
}
```

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

选项（构造第二参，全部可选）：

| 选项 | 说明 |
| --- | --- |
| `reset` | 归还时的清理回调（put 时调用；抛错被捕获忽略并告警） |
| `initial` | 创建即预热的数量（等价构造后 `prewarm(initial)`） |
| `max` | 空闲上限：归还时空闲数已达上限的对象直接丢弃，交给 GC |

使用要点：

- **借出必须归还**：`get()` 后不 `put()` 的对象既不复用也占着借出口径；「用完归还」的纪律靠调用方维持，池不做自动回收；
- `reset` 里把对象恢复到「干净的初始态」—— especially 布尔开关、引用字段，否则复用对象会带上上一轮的脏状态；
- `max` 给一个「同时活跃峰值」量级即可：太小失去池化意义，太大让死对象滞留内存；
- 观察命中率：`totalCreated` 增长很快说明池太小或归还纪律没落实。

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

> 引用语义差异是使用本类的关键：刚写入的键返回**活动引用**（改它的字段 = 改仓库里的数据），被降冷过的键返回**快照副本**（改它不影响仓库）。想让「拿到手的就是副本」永远成立，get 后自行深拷贝或只存原始值。

### API

```ts
dataCenter.set(key, value);      // 写入（写即热；同名冷数据快照被覆盖）
dataCenter.get<number>(key, 0);  // 读取（未命中返回 defaultValue）
dataCenter.has(key);             // 是否存在（热或冷）
dataCenter.delete(key);          // 删除（热/冷一并移除）。返回是否存在
dataCenter.keys();               // 全部键名（热 + 冷）
dataCenter.hotKeys();            // 热数据键名
dataCenter.coldKeys();           // 冷数据键名
dataCenter.warm(key);            // 手动回温（返回是否存在）
dataCenter.cool(key);            // 手动降冷（返回是否降冷）
dataCenter.sweep();              // 手动清扫（返回降冷条数）
dataCenter.stats();              // { hot, cold, sweeps, promotions, hits, misses }
dataCenter.configure({ hotLimit: 128, coldTtl: 60000, autoSweep: true, sweepInterval: 5000 });
```

`configure` 增量合并，可调项：

| 选项 | 缺省 | 说明 |
| --- | --- | --- |
| `hotLimit` | 64 | 热容量上限：超出后清扫按 LRU 降冷 |
| `coldTtl` | 30000 | 冷却时长（毫秒）：闲置超过该时长降冷 |
| `autoSweep` | true | 是否在 set/get/has 访问时惰性自动清扫 |
| `sweepInterval` | 10000 | 自动清扫最小间隔（毫秒） |

### 约定与技巧

- 键名用常量或枚举统一管理（散落的字符串键是跨组件数据最常见的 bug 来源）；
- 全局单例 `dataCenter` 跨脚本共享；需要隔离（如多个玩法模块各自命名空间）时 `new DataCenter(options)` 创建独立实例；
- `stats()` 可在调试时观察热/冷分布与命中情况；
- 本类只做「运行期内存共享」，**不持久化**：预览停机/页面卸载数据即消失，跨局存档请写入自己的存储方案。
