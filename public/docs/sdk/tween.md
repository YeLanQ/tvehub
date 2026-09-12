# 补间动画 tween

补间动画系统：以声明式 API 在时长内平滑插值任意数值/向量/颜色，由引擎每帧自动驱动（脚本 `onUpdate` 前），创建即开始播放。典型用途：实体位移/旋转/缩放动画、UI 弹出/淡入、相机过渡、数值滚动（血条/分数）、序列演出。

```ts
import { tween, Component } from "tve";

export default class Punch extends Component {
  onStart() {
    tween.position(this.entity, { x: 5, z: -2 }, 1)
      .easing("quadOut")
      .onComplete(() => engine.log("到位"));
  }
}
```

`import { tween } from "tve"` 与 `engine.tween` 是同一对象。

## 工厂

全部工厂创建即自动播放；同一语句内追加的链式配置（`delay`/`loop`/`easing`…）全部生效。

| 工厂 | 说明 |
| --- | --- |
| `to(target, props, duration)` | 数值/向量属性插值。目标可以是 Entity（`position`/`rotation`/`scale` 变换、`fontSize`/`sortOrder` 等数字字段）、UI Widget 字段（`anchoredPosition`/`size`/`pivot`/`spacing` 等 `{x,y}`、`padding` 四字段）或任意带同名字段的普通对象 |
| `from(target, props, duration)` | 反向：`props` 为起点，渐变回开始时的当前值（入场动画常用） |
| `value(from, to, duration)` | 数值插值；`onUpdate` 收插值结果（血条、分数滚动等） |
| `color(from, to, duration)` | 0xRRGGBB 颜色插值，RGB 通道各自线性；`onUpdate` 收 0xRRGGBB |
| `position(entity, to, duration)` | 实体本地位置补间（= `to(entity, { position: to }, duration)`） |
| `rotation(entity, toDeg, duration)` | 实体本地旋转补间（度制欧拉角，逐分量插值） |
| `scale(entity, to, duration)` | 实体本地缩放补间 |
| `sequence(tweens)` | 串行组：依次播放子 tween |
| `parallel(tweens)` | 并行组：同时播放子 tween |
| `delay(seconds)` | 纯延时占位（序列/串接用） |
| `call(cb)` | 立即回调占位：下一帧触发 `cb`（序列/串接用） |

`to`/`from` 的 `props` 形如 `{ 键: 终值 }`，值为数字或数值字段对象（允许部分字段，缺分量不动）：

```ts
tween.to(this.entity, { position: { x: 5 }, scale: { y: 2 } }, 1.5);
tween.to(this.entity, { rotation: { y: 360 } }, 2).loop(-1);   // 无限绕 Y 旋转
tween.from(uiImage, { anchoredPosition: { x: 20 }, color: 0 }, 0.3); // 滑入
tween.value(0, 100, 2).onUpdate((v) => (hpBar.width = v));      // 血条滚动
tween.to(layout, { padding: { top: 8 } }, 0.4);                 // 布局内边距过渡
```

UI 节点各字段的支持形态：数字字段（`fontSize`、`sortOrder`、`designWidth` 等）直接数值插值；`{x,y}` 字段（`size`、`anchoredPosition`、`pivot`、`spacing`）与 `{left,right,top,bottom}`（`padding`）逐分量插值；颜色字段（`color`、`labelColor`）请用 `tween.color`（见下）。

颜色补间把插值结果赋回字段：

```ts
tween.color(btn.color, 0xff5533, 0.4).onUpdate((c) => (btn.color = c));
```

> 注意：对 `color` 这类 0xRRGGBB 字段请用 `tween.color`（通道正确）。`tween.to` 对颜色字段做的是数值直插，跨通道会产生灰阶失真。

## Tween 链式配置与控制

| 成员 | 说明 |
| --- | --- |
| `easing(nameOrFn)` | 缓动名称（见下表）或自定义函数 `(t 0..1) => eased` |
| `delay(seconds)` | 开始前延时（秒；多次调用取最后一次） |
| `loop(count)` | 循环次数：1 = 单次（缺省）；n = n 次；-1 = 无限 |
| `yoyo(on?)` | 往返：偶数次循环反向插值（终点 → 起点） |
| `onStart(cb)` | 开始回调（delay 结束、首轮插值前触发一次） |
| `onUpdate(cb)` | 每帧回调 `(value, t)`：value = 插值输出（value/color 为结果，其余为系数）；t = easing 后系数 0..1 |
| `onComplete(cb)` | 完成回调（循环计满触发一次；`stop(true)` 同样触发） |
| `then(next)` | 串接：本 tween 完成后自动启动 next（next 由本链接管，无需也无法手动 start）；返回 next 以便继续链式配置 |
| `stop(complete?)` | 停止；`complete = true` 先快进到最终落点并触发 `onComplete`（不启动 then 链） |
| `pause()` / `resume()` | 暂停 / 续播 |
| `playing` / `paused` / `completed` | 状态只读 |
| `duration` / `elapsed` / `progress` / `loopsDone` | 配置时长 / 活跃播放累计（不含 delay）/ 当前循环进度 0..1 / 已完成循环数 |

```ts
// 弹跳入场：delay 半秒 → 从高处 yoyo 弹两次落定
tween.from(cube, { position: { y: 6 } }, 0.6)
  .delay(0.5)
  .easing("quadInOut")
  .yoyo()
  .loop(2);

// 串接演出：飞入 → 停顿 → 缩放消失
tween.position(enemy, { x: 0 }, 0.5)
  .then(tween.delay(0.3))
  .then(tween.scale(enemy, { x: 0, y: 0, z: 0 }, 0.25).easing("backIn"))
  .onComplete(() => engine.log("演出结束"));   // 挂在链尾 = 整条链的完成回调
```

回调异常被隔离上报（编辑器控制台），不影响 tween 推进与其他脚本。

## 组：sequence / parallel

组把多个 tween 变成一个整体：`sequence` 依次播放、`parallel` 同时播放；组级 `delay`/`loop`/`onStart`/`onComplete` 作用于整体，可嵌套（序列里放并行组等）。子 tween 传入组后由组接管（工厂的自动开始失效，独立播放状态被重置）——不要同时手动驱动组内成员。`yoyo` 对组无效；子 tween 可各自 `yoyo`。

```ts
const rise = tween.position(door, { y: 4 }, 1).easing("quadOut");
const spin = tween.rotation(orb, { y: 360 }, 1);
const flash = tween.color(mat.color, 0xffffff, 0.2).yoyo().loop(2);

tween.sequence([
  tween.parallel([rise, flash]), // 上升 + 闪光同时
  tween.delay(0.2),
  spin,                          // 随后旋转
]).onComplete(() => engine.log("阶段完成"));
```

## 缓动函数 easing

31 个标准缓动（Robert Penner 族）：`linear` 无后缀；其余按 In（加速起步）/ Out（减速收尾）/ InOut（两端缓缓）三形态。`easing` 表按名可取函数；`backIn/Out` 过冲回弹、`elasticIn/Out` 弹性振荡、`bounceIn/Out` 落地弹跳。

```ts
import { easing } from "tve";

tween.value(0, 1, 1).easing("elasticOut");
tween.value(0, 1, 1).easing((t) => t * t); // 自定义缓动
engine.log(easing.quadOut(0.5));           // 0.75
```

可用名称：`linear`、`quadIn|Out|InOut`、`cubicIn|Out|InOut`、`quartIn|Out|InOut`、`quintIn|Out|InOut`、`sineIn|Out|InOut`、`expoIn|Out|InOut`、`circIn|Out|InOut`、`backIn|Out|InOut`、`elasticIn|Out|InOut`、`bounceIn|Out|InOut`。

## 全局控制

| 成员 | 说明 |
| --- | --- |
| `killAll(complete?)` | 停止全部活动 tween；`complete = true` 先快进终点并触发 `onComplete` |
| `pauseAll()` / `resumeAll()` | 暂停 / 恢复全部 |
| `activeCount` | 活动 tween 数（含暂停中的） |
| `timeScale` | 全局时间缩放（0 = 冻结全部；子弹时间/暂停菜单常用） |

```ts
// 暂停菜单：冻结全部演出动画
tween.timeScale = 0;
// 恢复
tween.timeScale = 1;

// 场景切换：全部动画立即落位并停止
tween.killAll(true);
```

驱动与生命周期：tween 由引擎随帧自动推进（`engine.time.delta`，脚本 `onUpdate` 前），组件 `onDisable`/`onDestroy` 时引擎自动停机回收，脚本无需手动销毁；仍建议对一次性演出在完成回调后不再持有句柄。

## 其他导出

| 导出 | 说明 |
| --- | --- |
| `tween` | 补间动画 API（= `engine.tween`） |
| `easing` | 缓动函数表（名称 → 插值函数） |
| `Tween` | 补间句柄类（`instanceof` 判断用；实例由工厂创建） |
