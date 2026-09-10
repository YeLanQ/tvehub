# 数学库 math

`math` 为向量数学库，全部基于引擎自有类型 `Vec3`（`{x, y, z}` 普通对象）。纯函数：**全部返回新对象，不改写入参**。

```ts
import { math } from "tve";

const dir = math.normalize(math.sub(target.position, self.position));
self.position = math.moveTowards(self.position, target.position, 2 * delta);
```

## 构造与常量

| 成员 | 说明 |
| --- | --- |
| `v3(x?, y?, z?)` | 创建向量（缺省 0） |
| `zero` / `one` | 零向量 / 单位向量 (1,1,1)（冻结，勿改写） |
| `up` / `down` | (0,±1,0) |
| `forward` / `back` | (0,0,∓1)（前向 = -Z） |
| `left` / `right` | (∓1,0,0) |
| `clone(v)` | 快照副本，写入不影响原向量 |

## 运算

| 成员 | 说明 |
| --- | --- |
| `add(a, b)` / `sub(a, b)` | 加 / 减 |
| `scale(v, s)` / `negate(v)` | 数乘 / 逐分量取反 |
| `abs(v)` / `min(a, b)` / `max(a, b)` | 逐分量绝对值 / 最小 / 最大 |
| `dot(a, b)` | 点积（\|a\|\|b\|cosθ） |
| `cross(a, b)` | 叉积（同时垂直于 a、b，右手定则） |
| `length(v)` / `lengthSq(v)` | 模长 / 模长平方（比较距离用平方更快） |
| `distance(a, b)` / `distanceSq(a, b)` | 两点直线距离 / 距离平方 |
| `normalize(v)` | 归一化（零向量返回零向量，不产生 NaN） |

## 插值与工具

| 成员 | 说明 |
| --- | --- |
| `lerp(a, b, t)` | 线性插值 t∈[0,1]（t=0 返回 a 克隆，t=1 返回 b 克隆） |
| `moveTowards(a, b, maxDelta)` | 由 a 向 b 移动最多 maxDelta（不超过直线距离；匀速移动用） |
| `equals(a, b, eps?)` | 近似相等（逐分量误差 ≤ eps，缺省 1e-6） |
