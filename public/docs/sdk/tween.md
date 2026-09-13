# 补间动画 tween

补间动画系统：以声明式 API 在时长内平滑插值任意数值/向量/颜色，由引擎每帧自动驱动（在脚本 `onUpdate` **之前**推进），创建即开始播放。典型用途：实体位移/旋转/缩放动画、UI 弹出/淡入、相机过渡、数值滚动（血条/分数）、序列演出。

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

## 生命周期与所有权

- **驱动**：由引擎随帧自动推进（步长 = `engine.time.delta` × `tween.timeScale`），脚本无需手动调用任何 update；`timeScale` 挂在全局（见下文「全局控制」）；
- **创建即播放**：工厂返回的 Tween 已经在推进列表里；同一语句内追加的链式配置（`delay`/`loop`/`easing`…）全部生效，先 `delay` 再播放不会丢帧；
- **自动回收**：组件 `onDisable` / `onDestroy` 时，引擎自动停止该组件期间创建的全部 tween；跨组件创建的 tween 不受影响；
- **不落盘**：tween 是纯运行时演出，与场景文件无关。

## 工厂

| 工厂 | 说明 |
| --- | --- |
| `to(target, props, duration)` | 数值/向量属性插值。目标可以是 Entity（`position`/`rotation`/`scale` 变换、`fontSize`/`sortOrder` 等数字字段）、UI Widget 字段（`anchoredPosition`/`size`/`pivot`/`spacing` 等 `{x,y}`、`padding` 四字段）或任意带同名字段的普通对象 |
| `from(target, props, duration)` | 反向：`props` 为起点，渐变回**创建时刻的当前值**（入场动画常用；起点在创建瞬间被快照，之后改动目标当前值不影响起点） |
| `value(from, to, duration)` | 纯数值插值；`onUpdate` 收插值结果（血条、分数滚动等） |
| `color(from, to, duration)` | 0xRRGGBB 颜色插值，RGB 通道各自线性；`onUpdate` 收 0xRRGGBB |
| `position(entity, to, duration)` | 实体本地位置补间（= `to(entity, { position: to }, duration)`） |
| `rotation(entity, toDeg, duration)` | 实体本地旋转补间（度制欧拉角，逐分量插值） |
| `scale(entity, to, duration)` | 实体本地缩放补间 |
| `sequence(tweens)` | 串行组：依次播放子 tween |
| `parallel(tweens)` | 并行组：同时播放子 tween |
| `delay(seconds)` | 纯延时占位（序列/串接用） |
| `call(cb)` | 立即回调占位：下一帧触发 `cb`（序列/串接用） |

`to`/`from` 的 `props` 形如 `{ 键: 终值 }`，值为数字或数值字段对象（**允许部分字段，缺分量不动**）：

```ts
tween.to(this.entity, { position: { x: 5 }, scale: { y: 2 } }, 1.5);
tween.to(this.entity, { rotation: { y: 360 } }, 2).loop(-1);   // 无限绕 Y 旋转
tween.from(uiImage, { anchoredPosition: { x: 20 }, color: 0 }, 0.3); // 滑入
tween.value(0, 100, 2).onUpdate((v) => (hpBar.width = v));      // 血条滚动
tween.to(layout, { padding: { top: 8 } }, 0.4);                 // 布局内边距过渡
```

字段插值的支持形态：

| 字段形态 | 例子 | 插值方式 |
| --- | --- | --- |
| 数字 | `fontSize`、`sortOrder`、`designWidth`、变换 `fov` 等 | 直接数值插值 |
| `{x,y}` | `size`、`anchoredPosition`、`pivot`、`spacing` | 逐分量插值 |
| `{x,y,z}` | `position`、`rotation`、`scale` | 逐分量插值 |
| `{left,right,top,bottom}` | `padding` | 逐分量插值 |
| 0xRRGGBB 颜色 | `color`、`labelColor` | **必须用 `tween.color`**（见下方注意） |

颜色补间把插值结果赋回字段：

```ts
tween.color(btn.color, 0xff5533, 0.4).onUpdate((c) => (btn.color = c));
```

> 注意：对 `color` 这类 0xRRGGBB 字段请用 `tween.color`（通道正确）。`tween.to` 对颜色字段做的是数值直插，跨通道会产生灰阶失真（例如 0xff0000 → 0x0000ff 中间会路过灰色）。

`rotation` 是**逐分量线性插值**（不做最短角差归一化）：`{y: 350}` → `{y: 10}` 会反转 340° 而不是前进 20°。需要走最短路径时先把起点/终点角用 `math.deltaAngle` 归算到 ±180° 区间，或直接给累计角度（如 `{ y: 360 }` 绕一整圈）。

## Tween 链式配置与控制

| 成员 | 说明 |
| --- | --- |
| `easing(nameOrFn)` | 缓动名称（见下文「缓动函数 easing」表）或自定义函数 `(t 0..1) => eased` |
| `delay(seconds)` | 开始前延时（秒；多次调用取**最后一次**，不是叠加） |
| `loop(count)` | 循环次数：1 = 单次（缺省）；n = n 次；-1 = 无限 |
| `yoyo(on?)` | 往返：偶数次循环反向插值（终点 → 起点）；对 sequence/parallel **组无效**，子 tween 可各自 yoyo |
| `onStart(cb)` | 开始回调（delay 结束、首轮插值前触发一次） |
| `onUpdate(cb)` | 每帧回调 `(value, t)`：value = 插值输出（value/color 为结果，其余为系数）；t = easing 后系数 0..1 |
| `onComplete(cb)` | 完成回调（循环计满触发一次；`stop(true)` 同样触发） |
| `then(next)` | 串接：本 tween 完成后自动启动 next（next 由本链接管，无需也无法手动 start）；返回 next 以便继续链式配置 |
| `stop(complete?)` | 停止：移出推进列表不再恢复。`complete = true` 先快进到最终落点并触发 `onComplete`（**不启动 then 链**） |
| `pause()` / `resume()` | 暂停 / 续播（保留进度） |
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

`then` 语义要点：

- `then` 返回 **next**，后续链式配置与 `onComplete` 都应挂在返回值上；「整条链的完成回调」= 挂在最后一个 tween 上；
- next 被本链接管：不要对 next 再调用 `stop()`/`pause()` 之外的驱动操作，也不能再把它交给另一个 `then`（一个 tween 只能有一个上游）；
- 中途对链头 `stop(true)` 只完成链头自身，后续链不启动；要整链取消用 `tween.killAll()` 或逐个 `stop()`。

回调异常被隔离上报（编辑器控制台），不影响 tween 推进与其他脚本。

## 组：sequence / parallel

组把多个 tween 变成一个整体：`sequence` 依次播放、`parallel` 同时播放；组级 `delay`/`loop`/`onStart`/`onComplete` 作用于整体，可**嵌套**（序列里放并行组等）。子 tween 传入组后由组接管（工厂的自动开始失效，独立播放状态被重置）——不要同时手动驱动组内成员。`yoyo` 对组无效；子 tween 可各自 `yoyo`。

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

- 空数组组立即完成（`onComplete` 下一帧触发）；
- 组内成员的 `then` 链同样被组接管；组的 `loop(n)` 会整组重放（子 tween 状态随之复位）；
- `call(cb)` 占位在序列里等价于「到这一步时执行一次回调」，常用于在两段演出之间切换状态。

## 缓动函数 easing

31 个标准缓动（Robert Penner 族）：`linear` 无后缀；其余按 In（加速起步）/ Out（减速收尾）/ InOut（两端缓缓）三形态。`easing` 表按名可取函数；`backIn/Out` 过冲回弹、`elasticIn/Out` 弹性振荡、`bounceIn/Out` 落地弹跳。

```ts
import { easing } from "tve";

tween.value(0, 1, 1).easing("elasticOut");
tween.value(0, 1, 1).easing((t) => t * t); // 自定义缓动
engine.log(easing.quadOut(0.5));           // 0.75
```

可用名称（共 31 个）：

| 族 | 名称 |
| --- | --- |
| 线性 | `linear` |
| 二次 | `quadIn` / `quadOut` / `quadInOut` |
| 三次 | `cubicIn` / `cubicOut` / `cubicInOut` |
| 四次 | `quartIn` / `quartOut` / `quartInOut` |
| 五次 | `quintIn` / `quintOut` / `quintInOut` |
| 正弦 | `sineIn` / `sineOut` / `sineInOut` |
| 指数 | `expoIn` / `expoOut` / `expoInOut` |
| 圆弧 | `circIn` / `circOut` / `circInOut` |
| 回弹（过冲） | `backIn` / `backOut` / `backInOut` |
| 弹性（振荡） | `elasticIn` / `elasticOut` / `elasticInOut` |
| 落地弹跳 | `bounceIn` / `bounceOut` / `bounceInOut` |

选型经验：UI 入场 `backOut` / `cubicOut`；演出节奏 `quadInOut`；强调/惊喜 `elasticOut`；物理落地感 `bounceOut`；自定义函数只需满足 `(t ∈ [0,1]) → 输出`（back/elastic 中间超调出界是正常现象，赋值到尺寸/颜色时注意负值与超界处理）。

## 全局控制

| 成员 | 说明 |
| --- | --- |
| `killAll(complete?)` | 停止全部活动 tween；`complete = true` 先快进终点并触发 `onComplete` |
| `pauseAll()` / `resumeAll()` | 暂停 / 恢复全部 |
| `activeCount` | 活动 tween 数（含暂停中的） |
| `timeScale` | 全局时间缩放（0 = 冻结全部；负数按 0 处理） |

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
| `Tween` | 补间句柄类（`instanceof` 判断用；实例由工厂创建，脚本不要直接 `new`） |
