# engine 入口

`engine` 是脚本的全局系统入口（时间 / 输入 / 场景 / 动画 / 音频 / 粒子 / 物理 / UI / 逻辑 / 补间 / 日志）。全部子系统**按实体（Entity）寻址**：拿到实体句柄（`@property` 节点引用、`engine.scene.find` 等）后传入各 API。

## 时间：engine.time

```ts
engine.time.delta;    // 距上一帧的秒数（与 onUpdate(delta) 的参数相同）
engine.time.elapsed;  // 运行期累计秒数
engine.time.frame;    // 帧序号（从 1 开始）
```

典型用法：把「每 N 秒执行一次」改成基于累计时间的调度，避免 setTimeout 与帧循环脱节：

```ts
private next = 0;
onUpdate() {
  if (engine.time.elapsed >= this.next) {
    this.next += 2;        // 每 2 秒
    this.spawn();
  }
}
```

## 输入：engine.input

按键用 `KeyboardEvent.code`（如 `"KeyW"`、`"Space"`、`"ArrowLeft"`、`"Digit1"`、`"ShiftLeft"`），支持任意多键同时按住。指针支持**多点触控**：每个触点按 `pointerId` 区分（从按下到抬起恒定；鼠标也是触点之一），坐标为**画布内 CSS 像素**（左上角原点），与 `engine.ui.screenToUi` 的入参同一空间。

```ts
engine.input.isKeyDown("KeyW");            // 按键当前是否按下（轮询式，多键组合直接连查）
engine.input.keys;                          // 当前按下的全部按键（Set 实时视图）
const off = engine.input.onKeyDown((key) => { /* 按下（每键各触发一次） */ });
const off2 = engine.input.onKeyUp(handler);
engine.input.pointer;                       // 主指针 { x, y, down, pointerId }（跟随最后活跃触点）
engine.input.pointers;                      // 按下中的全部触点（Map<pointerId, { x, y, down, pointerId }>）
engine.input.getPointer(pointerId);         // 按 id 查触点（未按下返回 null）
engine.input.onPointerDown(handler);        // handler: (pointer) => void，每触点各触发
engine.input.onPointerUp(handler);
engine.input.onPointerCancel(handler);      // 系统抢占（浏览器手势等）：触点被强制移除，不会再来 up
engine.input.onPointerMove(handler);
```

订阅函数均返回取消订阅函数；请在 `onDisable`/`onDestroy` 中调用以免悬挂。

```ts
// WASD 轮询移动（每帧查询；多个 isKeyDown 组合即多键输入）
onUpdate(delta: number) {
  const x = (engine.input.isKeyDown("KeyD") ? 1 : 0) - (engine.input.isKeyDown("KeyA") ? 1 : 0);
  const z = (engine.input.isKeyDown("KeyS") ? 1 : 0) - (engine.input.isKeyDown("KeyW") ? 1 : 0);
  if (x || z) this.entity.translate(x * this.speed * delta, 0, z * this.speed * delta);
}

// 事件式点击（一次性交互）
private off?: () => void;
onEnable() { this.off = engine.input.onPointerDown((p) => this.tryPick(p.x, p.y)); }
onDisable() { this.off?.(); }

// 双指捏合缩放（多点触控；pointers 里始终是按下中的触点）
onUpdate() {
  const ps = engine.input.pointers;
  if (ps.size !== 2) {
    this.prevDist = 0;             // 手指离开后重置，下次捏合从当前距离起算
    return;
  }
  const [a, b] = [...ps.values()];
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  if (this.prevDist > 0) this.zoom *= dist / this.prevDist;
  this.prevDist = dist;
}
```

按 `pointerId` 做逐指追踪时，`onPointerUp` 与 `onPointerCancel` 都要订阅（cancel 后不会再有 up），用 `pointer` 参数里的 `pointerId` 匹配自己按住的那根手指。

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

更细的控制（进度、倍速、循环模式、动画图参数、蒙皮/IK）见[内置组件门面](components.md)的 `SkeletalAnimation`；关键帧 `.anim` 剪辑用 `AnimationClip` 门面（两者互不相关）。

## 音频：engine.audio

按实体寻址；音源节点与挂「音源」组件的节点有效，实体上多个音源时寻址首个（需要精确控制某个音源用 `getComponent(AudioSource)`）。

```ts
engine.audio.play(entity);            // 暂停态续播；停止/播完态从头播
engine.audio.stop(entity);
engine.audio.pause(entity);
engine.audio.resume(entity);
engine.audio.setVolume(entity, 0.5);  // 运行时音量 0~1（不落盘）
```

## 粒子：engine.particles

按实体寻址；仅粒子系统节点有效。拿到 `ParticleSystemNode` 实体时也可直接调用其同名方法/属性（见 [实体与查询](entity.md)）。

```ts
engine.particles.play(entity);       // 暂停态续播；停止/播完态从头开始
engine.particles.pause(entity);
engine.particles.stop(entity);       // 停止发射，存活粒子自然消亡
engine.particles.restart(entity);    // 清空并从头开始
engine.particles.clear(entity);      // 立即清空
engine.particles.stateOf(entity);    // { playing, paused, finished, alive, time } | null
engine.particles.setSettings(entity, { emissionRate: 50, startColor: 0x66ccff }); // 运行态合并（不落盘）
```

`stateOf` 的 `finished` 在「非循环系统发射完毕且粒子全部消亡」时为 true，配合 `restart()` 可做「播完一轮再来一轮」的节奏控制。

## 物理：engine.physics

按实体寻址；仅挂了「刚体」组件的节点有效（需要项目设置启用物理）。

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

| 方法 | 典型场景 |
| --- | --- |
| `applyImpulse` | 跳跃、爆炸击飞（一次性冲量，质量越大效果越弱） |
| `applyForce` | 推力/浮力/风力（**每帧调用**才持续生效） |
| `setLinearVelocity` | 直接控制速度（平台跳跃的空中控制、传送带） |
| `setGravityScale` | 局部失重/下落加速（0 = 悬浮） |
| `wakeUp` | 物理引擎会休眠静止的体；脚本改完参数/落点后调一次确保响应 |

`RigidBody` 门面上有绑定本实体的同名接口（`setLinearVelocity` / `applyImpulse` / `setGravityScale` / `wakeUp` 等），见[内置组件门面](components.md)。

## UI：engine.ui

按实体寻址；画布与 Widget（图片/文本/按钮/布局容器）设置 + 按钮点击订阅。节点类字段与示例详见 [UI](ui.md)。

```ts
engine.ui.set(entity, { text: "New", color: 0x66ccff }); // 合并设置（子集；运行态生效，不落盘）
engine.ui.get(entity);           // 当前设置快照（非 UI 节点返回 null）
const off = engine.ui.onClick(entity, () => { /* 按钮被点击 */ }); // 仅 uiButtonNode 且 interactable
engine.ui.offClick(entity, cb);  // 解除订阅（或调用 onClick 返回的解绑函数）
engine.ui.rectOf(entity);        // 解析矩形（画布局部空间，锚点/布局解析后的实际矩形）
engine.ui.metricsOf(entity);     // 所在画布屏幕度量（px ↔ UI 单位换算）
engine.ui.screenToUi(entity, x, y); // 屏幕像素坐标 → 画布局部 UI 坐标
```

## 逻辑：engine.logic

按实体寻址；**状态机/行为树运行器节点**（层级「逻辑」分组的 FSM Runner / BT Runner，编辑器里绑定 `.fsm` / `.bt` 资产）的脚本控制入口。运行态（当前状态/黑板）不落盘；状态切换与动作行为全部由脚本消费。

状态机：过渡触发器（事件 / 定时 / 参数条件）在编辑器的 `.fsm` 图里定义，脚本负责喂事件、写参数、响应状态：

```ts
// 状态进入时播动画（经典 Idle/Walk/Attack 驱动）
engine.logic.onFsmEnter(entity, "Attack", () => engine.animation.play(entity, "attack"));
engine.logic.onFsmExit(entity, "", (s) => engine.animation.stop(entity)); // 空 match = 任意状态

engine.logic.fire(entity, "hit");                 // 发射事件（事件过渡的触发器）
engine.logic.setFsmParam(entity, "hp", 20);       // 写参数（条件过渡的黑板）
engine.logic.getFsmParam(entity, "hp");
engine.logic.fsmState(entity);                    // { id, name, time } | null
engine.logic.forceFsmState(entity, "Walk");       // 强制切换（状态 id 或显示名）
```

行为树：条件叶子读黑板，动作叶子经 `onAction` 注册行为；返回三值状态（缺省成功）：

```ts
engine.logic.setBtParam(entity, "ready", 1);      // 写黑板（条件叶子的求值对象）
engine.logic.btStatus(entity);                    // "success" | "failure" | "running" | null

engine.logic.onAction(entity, "walkTo", (leaf, session) => {
  if (session.seq !== this.lastSeq) {             // 全新开始（首次/完成后再入/被中断）→ 复位
    this.lastSeq = session.seq;
    this.step = 0;
  }
  return ++this.step >= 10 ? "success" : "running"; // running = 续行（下一帧再调）
});
```

通用控制：`setRunning(entity, false)` 暂停 / `restart(entity)` 重启（状态回入口、黑板回默认）。订阅与 `onAction` 都返回解绑函数。

**多个运行器：如何拿到实体**。场景里可以有任意多个状态机/行为树，`engine.logic` 全部按实体寻址，实体来源有四种：

```ts
// ① @property 节点引用（推荐）：检查器下拉按类型过滤，只列 fsmRunnerNode/btRunnerNode；
//    同一脚本可声明多个字段分别绑定不同运行器，多个脚本也可引用同一个运行器
@property({ type: FsmRunnerNode, label: "移动状态机" })
move: FsmRunnerNode | null = null;

// ② 按名字 / 标签查找
const fsm = engine.scene.find("EnemyFSM");
const agent = engine.scene.findByTag("enemy");

// ③ 脚本就挂在运行器节点自身：this.entity 即该运行器
engine.logic.fire(this.entity, "hit");

// ④ 枚举全部运行器（如全局监听所有敌人的状态）
for (const e of engine.scene.findAll()) {
  if (e instanceof FsmRunnerNode) {
    engine.logic.onFsmEnter(e, "Die", () => this.refreshCount());
  }
}
```

引用字段保存的是节点 id，运行期解析为对应实体（`instanceof FsmRunnerNode` / `BtRunnerNode` 可判别），预览与构建产物行为一致。

## 补间动画：engine.tween

与顶层导出 `tween` 是同一对象：创建即自动播放的补间动画（实体变换、UI 字段、数值/颜色插值、序列/并行组）。详见[补间动画](tween.md)。

```ts
tween.position(entity, { x: 5 }, 1).easing("quadOut");
```

## 日志：engine.log / warn / error

```ts
engine.log("得分", score);   // 输出到编辑器控制台（预览）/ 浏览器控制台（发布产物）
engine.warn("低血量");
engine.error("非法状态", entity);
```

- 预览运行时日志转发到编辑器控制台（`[预览]` 前缀）；发布产物转发到浏览器控制台（调试模式构建保留转发）；
- 参数原样透传（多参数以空格拼接显示），对象/实体按可读形式打印；
- 每帧高频 `log` 会刷屏（控制台上限 500 行，超出丢弃最旧），调试完记得移除。

## 其他导出

| 导出 | 说明 |
| --- | --- |
| `math` | 向量数学库，见 [math](math.md) |
| `tween` / `easing` / `Tween` | 补间动画系统，见 [tween](tween.md) |
| `Delegate` / `Pool` / `DataCenter` / `dataCenter` | 脚本通用设施，见 [通用设施](utils.md) |
| `VERSION` | SDK 版本字符串 |
| `Component` / `Entity` / 各节点类与门面类 | 见前述章节 |
