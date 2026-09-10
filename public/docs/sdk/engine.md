# engine 入口

`engine` 是脚本的全局系统入口（时间 / 输入 / 场景 / 动画 / 音频 / 物理 / 日志）。

## 时间：engine.time

```ts
engine.time.delta;    // 距上一帧的秒数
engine.time.elapsed;  // 运行期累计秒数
engine.time.frame;    // 帧序号（从 1 开始）
```

## 输入：engine.input

按键用 `KeyboardEvent.code`（如 `"KeyW"`、`"Space"`、`"ArrowLeft"`）。指针坐标为画布内 CSS 像素。

```ts
engine.input.isKeyDown("KeyW");            // 按键当前是否按下
const off = engine.input.onKeyDown((key) => { /* 按下 */ });  // 返回取消订阅函数
const off2 = engine.input.onKeyUp(handler);
engine.input.pointer;                       // { x, y, down }
engine.input.onPointerDown(handler);        // handler: (pointer) => void
engine.input.onPointerUp(handler);
engine.input.onPointerMove(handler);
```

订阅函数均返回取消订阅函数；请在 `onDisable`/`onDestroy` 中调用以免悬挂。

## 场景：engine.scene

详见[实体与查询](entity.md)：`root` / `find` / `findAll` / `findByTag` / `findAllByTag` / `findComponent` / `findComponents`。

## 模型动画：engine.animation

按实体寻址；仅模型网格节点（模型内嵌动画）有效。

```ts
engine.animation.play(entity, "Run"); // 单剪辑模式 clip = 剪辑名（缺省取首个）；
                                      // 动画图模式 clip = 目标状态名
engine.animation.stop(entity);        // 停止并回初始姿势
engine.animation.pause(entity);       // 暂停（保留进度）
engine.animation.resume(entity);      // 继续
```

更细的控制（进度、倍速、循环模式、动画图参数）见[内置组件门面](components.md)的 `SkeletalAnimation`。

## 音频：engine.audio

按实体寻址；音源节点与挂「音源」组件的节点有效，实体上多个音源时寻址首个。

```ts
engine.audio.play(entity);            // 暂停态续播；停止/播完态从头播
engine.audio.stop(entity);
engine.audio.pause(entity);
engine.audio.resume(entity);
engine.audio.setVolume(entity, 0.5);  // 运行时音量 0~1（不落盘）
```

## 粒子：engine.particles

按实体寻址；仅粒子系统节点有效。拿到 `ParticleSystemNode` 实体时也可直接调用其同名方法/属性（见 entity.md）。

```ts
engine.particles.play(entity);       // 暂停态续播；停止/播完态从头开始
engine.particles.pause(entity);
engine.particles.stop(entity);       // 停止发射，存活粒子自然消亡
engine.particles.restart(entity);    // 清空并从头开始
engine.particles.clear(entity);      // 立即清空
engine.particles.stateOf(entity);    // { playing, paused, finished, alive, time } | null
engine.particles.setSettings(entity, { emissionRate: 50, startColor: 0x66ccff }); // 运行态合并（不落盘）
```

## 物理：engine.physics

按实体寻址；仅挂了「刚体」组件的节点有效。

```ts
engine.physics.applyImpulse(entity, x, y, z);   // 施加冲量（世界空间，N·s；动力学体）
engine.physics.applyForce(entity, x, y, z);     // 施加持续力（世界空间，N；每帧调用生效）
engine.physics.setLinearVelocity(entity, x, y, z); // 直接设置线速度（m/s）
engine.physics.setAngularVelocity(entity, x, y, z); // 直接设置角速度（rad/s）
engine.physics.getLinearVelocity(entity);       // 读取线速度（未绑定返回 null）
engine.physics.bodyInfo(entity);                // { mode, gravityScale, colliderCount } | null
engine.physics.setGravityScale(entity, 0);      // 重力缩放（0 = 不受重力）
engine.physics.wakeUp(entity);                  // 唤醒（修改参数后让睡眠中的体立即响应）
engine.physics.setGravity(0, -9.81, 0);         // 世界重力（影响全部动力学体）
```

`RigidBody` 门面上有绑定本实体的同名接口（`setLinearVelocity` / `applyImpulse` / `setGravityScale` / `wakeUp` 等），见[内置组件门面](components.md)。

## 日志：engine.log / warn / error

```ts
engine.log("得分", score);   // 输出到编辑器控制台（预览）/ 浏览器控制台（发布产物）
engine.warn("低血量");
engine.error("非法状态", entity);
```

## 其他导出

| 导出 | 说明 |
| --- | --- |
| `math` | 向量数学库，见 [math](math.md) |
| `Delegate` / `Pool` / `DataCenter` / `dataCenter` | 脚本通用设施，见 [通用设施](utils.md) |
| `VERSION` | SDK 版本字符串 |
| `Component` / `Entity` / 各节点类与门面类 | 见前述章节 |
