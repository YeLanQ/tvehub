```ts tve
import { Pool } from "tve";

interface Bullet {
  active: boolean;
  x: number;
  y: number;
}

// 工厂 + 可选配置：reset 归还清理 / initial 预热 / max 空闲上限
const pool = new Pool<Bullet>(
  () => ({ active: false, x: 0, y: 0 }),
  { reset: (b) => { b.active = false; }, initial: 2, max: 5 },
);

pool.count;         // => 2（预热即备好）
pool.totalCreated;  // => 2

// get：优先复用空闲对象，池空才新建
const a = pool.get();
pool.count;         // => 1

// put：先 reset 清理再入池；非本池对象/重复归还返回 false
pool.put(a);        // => true
pool.put(a);        // => false（已归还过）
pool.put({} as Bullet); // => false（外来对象）

// 评估池命中率：totalCreated 增长越慢 = 复用率越高
pool.prewarm(3);    // 再预热 3 个（受 max 上限约束）
pool.clear();       // 清空空闲列表（不影响已借出的对象）
pool.count;         // => 0
```
