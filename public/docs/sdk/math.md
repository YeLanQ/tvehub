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

## 标量与角度

| 成员 | 说明 |
| --- | --- |
| `clamp(v, min, max)` | 标量钳制（结果落在 [min, max]） |
| `projectXZ(v)` | XZ 平面投影（返回 y = 0 的副本；把方向约束到水平面） |
| `deltaAngle(current, target)` | 角度差（度）= target − current 的最短有符号差（结果 ∈ [-180, 180]；多圈自动归一化） |
| `moveTowardsAngle(current, target, maxDelta)` | 角度移近（度）：沿最短路径向 target 移动最多 maxDelta（Infinity = 立即到达） |
| `deadZone(v, deadZone)` | 模拟输入死区（线性重映射）：\|v\| ≤ deadZone 归零，其余按符号缩放回 0..1 满量程 |
| `degToRad(degrees)` | 度 → 弧度 |
| `radToDeg(radians)` | 弧度 → 度 |

角度函数与 `Entity.rotation` 同一约定（度制欧拉角），典型用法是帧率无关的平滑转身：

```ts
// 朝移动方向转身（facingOffset 校正模型面向；turnSpeed = 度/秒）
const yaw = (Math.atan2(moveX, moveZ) * 180) / Math.PI + facingOffset;
const r = this.entity.rotation;
this.entity.rotation = {
  x: r.x,
  y: math.moveTowardsAngle(r.y, yaw, this.turnSpeed * delta),
  z: r.z,
};

// 相机相对移动方向（投影到水平面再归一化）
const f = math.normalize(math.projectXZ(math.sub(target.position, camera.position)));
const right = math.cross(f, math.up);
```
