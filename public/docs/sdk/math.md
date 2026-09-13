# 数学库 math

`math` 是向量数学库，全部基于引擎自有类型 `Vec3`（`{x, y, z}` 普通对象），**不暴露任何 three.js / WebGL 类型**。所有函数都是纯函数：**返回新对象，不改写入参**——把返回值赋回去才会生效。

```ts
import { math } from "tve";

const dir = math.normalize(math.sub(target.position, self.position));
self.position = math.moveTowards(self.position, target.position, 2 * delta);
```

为什么用纯函数而不是链式/可变对象：与编辑器数据模型一致（变换读写都是快照语义），也避免共享可变状态被多组件意外篡改。如果需要保存一个向量稍后再写回，用 `math.clone()` 拷贝一份。

## 坐标与单位约定

全部数学函数与编辑器共用同一套约定，混用不会出现单位错乱：

| 约定 | 值 |
| --- | --- |
| 坐标系 | 右手系，Y 向上 |
| 前向 | **-Z**（`math.forward` = (0,0,-1)，与灯光/相机/粒子发射方向一致） |
| 位置/缩放 | 米（世界单位） |
| 旋转 | **度**制欧拉角 XYZ（不是弧度） |
| 颜色 | 0xRRGGBB 整数（math 不处理颜色，颜色插值见 [tween](tween.md)） |

涉及角度的函数（`deltaAngle` / `moveTowardsAngle` / `degToRad` / `radToDeg`）都以「度」为默认单位；`degToRad` / `radToDeg` 只在与 `Math.sin/cos` 等三角函数配合时才需要（三角函数吃弧度）。

## 构造与常量

| 成员 | 说明 |
| --- | --- |
| `v3(x?, y?, z?)` | 创建向量（缺省 0）：`math.v3()` = (0,0,0)、`math.v3(1)` = (1,0,0) |
| `zero` / `one` | 零向量 / 单位向量 (1,1,1)（冻结，勿改写） |
| `up` / `down` | (0,±1,0) |
| `forward` / `back` | (0,0,∓1)（前向 = -Z） |
| `left` / `right` | (∓1,0,0) |
| `clone(v)` | 快照副本，写入副本不影响原向量 |

```ts
// 常量是冻结对象：直接改写会被忽略（严格模式报错），需要可变量请 clone
const v = math.clone(math.up);
v.y = 5;                  // ✓ 改的是副本
```

常量对象跨帧复用，不要把 `math.up` 直接存进 `dataCenter` 等共享容器后改写。

## 运算

| 成员 | 说明 |
| --- | --- |
| `add(a, b)` / `sub(a, b)` | 加 / 减（`sub(b.position, a.position)` = 从 a 指向 b 的向量） |
| `scale(v, s)` / `negate(v)` | 数乘 / 逐分量取反 |
| `abs(v)` / `min(a, b)` / `max(a, b)` | 逐分量绝对值 / 最小 / 最大 |
| `dot(a, b)` | 点积（\|a\|\|b\|cosθ）；单位向量点积 = 夹角余弦，常用于「是否在面前」判定 |
| `cross(a, b)` | 叉积（同时垂直于 a、b，右手定则）；两向量张成平面的法线 |
| `length(v)` / `lengthSq(v)` | 模长 / 模长平方（比较距离用平方更快，少一次开方） |
| `distance(a, b)` / `distanceSq(a, b)` | 两点直线距离 / 距离平方 |
| `normalize(v)` | 归一化（模长归 1；零向量返回零向量，**不产生 NaN**） |

```ts
// 是否在角色面前 120° 视野内（视野半角 60°）
const toTarget = math.normalize(math.sub(target.position, self.position));
const fwd = math.normalize(math.sub(self.worldPosition, math.scale(self.worldPosition, 0))); // 演示用，实际用朝向向量
if (math.dot(fwd, toTarget) > Math.cos((60 * Math.PI) / 180)) { /* 可见 */ }

// 两点是否进入交互半径（平方距离，免开方）
if (math.distanceSq(a.worldPosition, b.worldPosition) < radius * radius) { /* 触发 */ }
```

> `normalize` 对零向量返回零向量是刻意的容错：跟随逻辑里目标与自己重合时不会突然得到 NaN 把整个位置写坏。

## 插值与移动

| 成员 | 说明 |
| --- | --- |
| `lerp(a, b, t)` | 线性插值 t∈[0,1]（t=0 返回 a 克隆，t=1 返回 b 克隆；t 超界外推） |
| `moveTowards(a, b, maxDelta)` | 由 a 向 b 移动最多 maxDelta（不超过直线距离；**匀速移动**用） |
| `equals(a, b, eps?)` | 近似相等（逐分量误差 ≤ eps，缺省 1e-6） |

`lerp` 与 `moveTowards` 的区别：`lerp(a, b, k * delta)` 是**比例逼近**（先快后慢、永不精确到达，k 越大跟随越紧），`moveTowards(a, b, speed * delta)` 是**恒速逼近**（帧率无关、精确到达）。跟随相机用 lerp，角色移动用 moveTowards 是常见搭配。

```ts
// 帧率无关的平滑跟随（每帧靠近剩余距离的 5%）
this.entity.position = math.lerp(this.entity.position, target.worldPosition, 1 - Math.pow(0.95, delta * 60));

// 匀速走向目标点，到达即停
const next = math.moveTowards(this.entity.position, goal, this.speed * delta);
this.entity.position = next;
if (math.equals(next, goal, 0.01)) this.arrived = true;
```

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

角度函数解决的是「欧拉角绕圈」问题：直接 `target - current` 会在 359° → 0° 处算出 -359°，`deltaAngle` 永远给出最短方向；`moveTowardsAngle` 在此基础上限速，就是帧率无关的平滑转身。`deadZone` 配合 `engine.input.pointer` 自制虚拟摇杆时滤掉中心抖动。

角度函数与 `Entity.rotation` 同一约定（度制欧拉角），典型用法：

```ts
// 朝移动方向转身（facingOffset 校正模型面向；turnSpeed = 度/秒）
const yaw = (Math.atan2(moveX, moveZ) * 180) / Math.PI + facingOffset;
const r = this.entity.rotation;
this.entity.rotation = {
  x: r.x,
  y: math.moveTowardsAngle(r.y, yaw, this.turnSpeed * delta),
  z: r.z,
};

// 相机相对移动方向（投影到水平面再归一化，保证在斜坡上仍水平移动）
const f = math.normalize(math.projectXZ(math.sub(target.position, camera.position)));
const right = math.cross(f, math.up);
const move = math.add(math.scale(f, inputY), math.scale(right, inputX));
```

## 常见配方速查

| 需求 | 写法 |
| --- | --- |
| 指向目标的单位方向 | `math.normalize(math.sub(b.position, a.position))` |
| 匀速追踪 | `math.moveTowards(pos, goal, speed * delta)` |
| 平滑跟随 | `math.lerp(pos, goal, 1 - Math.pow(k, delta))` |
| 距离判定（快） | `math.distanceSq(a, b) < r * r` |
| 水平朝向（只转 Y） | `math.projectXZ(dir)` + `math.moveTowardsAngle` |
| 镜面对称向量 | `math.scale(dir, -1)` 或 `math.negate(dir)` |
| 摇杆输入滤抖 | `math.deadZone(raw, 0.15)` |
| 与 `Math` 三角函数配合 | 先 `math.degToRad()` 转弧度 |
