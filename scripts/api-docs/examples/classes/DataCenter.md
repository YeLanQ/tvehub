```ts tve
import { DataCenter } from "tve";

// 隔离实例（new；全局单例见 dataCenter）——可自定义热/冷策略
const dc = new DataCenter({ hotLimit: 2, coldTtl: 0 });

// 写即热、读返回活动引用
dc.set("score", 10);
dc.get<number>("score"); // => 10
dc.has("score");         // => true
dc.keys();               // => ["score"]
dc.hotKeys();            // => ["score"]

// 冷热分解：cool 降冷为冻结快照；读冷数据自动回温并返回快照值
dc.set("hp", 100);
dc.cool("hp");           // => true
dc.coldKeys();           // => ["hp"]
dc.get<number>("hp");    // => 100（回温 + 返回快照）
dc.hotKeys().length;     // => 2（回温后全热）

// sweep 手动清扫：闲置降冷 + 超出 hotLimit 按 LRU 降冷
dc.set("mp", 50);
dc.sweep();              // 超出 hotLimit=2，最久未访问的降冷
dc.stats().cold >= 1;    // => true

// 删除（热/冷一并移除）
dc.delete("score");      // => true
dc.get<number>("score", 0); // => 0（未命中回 defaultValue）
```
