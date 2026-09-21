# 单元：tve SDK —— 工具库（math / tween / Delegate / Pool / DataCenter）

## 契约

**`math: MathApi`**（40+ 纯函数）：`clone/add/sub/scale/dot/cross/length/distance/
normalize/lerp/moveTowards/degToRad/projectXZ/unproject/…`。约定：Vec3 是普通对象
（非 three.Vector3）、旋转一律"度"。

**`tween: TweenApi` + `Tween` 链式类**：创建即播放，引擎每帧自动推进（脚本
onUpdate 前）。工厂：`to/from/target/value/color/position/rotation/scale`；
组合：`sequence([...])/parallel([...])/delay(s)/call(fn)`；控制：`killAll()`。
链式：`easing(name)/delay/loop(n)/yoyo/onStart/onUpdate/onComplete/then/stop/pause`。
缓动表 `easing`：In/Out/InOut 变体 + `backOut`（回弹）等。

**`Delegate<T>`**：事件委托，`add(fn) → Token`，`remove(token)`（防误删匿名函数）。
**`Pool<T>`**：对象池，`get/put/prewarm(n)/clear`。
**`DataCenter`/`dataCenter`**：命名数据仓库（热/冷 LRU 分解），跨脚本共享状态。
**`VERSION`**：SDK 版本（当前 "1.3.0"）。

## 使用例

`public/repos/code/TweenDemo.ts:15-24`（from 入场 + sequence 巡航）：

```ts
onStart() {
  tween.from(this.entity, { scale: { x: 0.01, y: 0.01, z: 0.01 } }, 0.6)
    .easing("backOut")
    .onComplete(() => engine.log("入场完成"));
  tween.sequence([
    tween.position(this.entity, { x: px + this.range }, this.duration).easing("sineInOut"),
    tween.delay(0.3),
    tween.position(this.entity, { x: px }, this.duration).easing("sineInOut"),
    tween.delay(0.3),
  ]).loop(-1);
}
```

`public/repos/code/RaycastDetector.ts`（math 向量运算）、`VirtualJoystick.ts`
（DataCenter 存摇杆状态）。

## 测试例

真实测试例：`scripts/smoke/tracker/smoke-tween-runtime.mjs`（P0）——补间推进/
缓动/序列编排/killAll 的产物级回归。

给 math 新增纯函数时：实现放 `src/runtime/core/tve/math.ts` + 类型补进
`src/framework/scripting/tve.d.ts`（**两处镜像同步**），并在工坊 code 分类补一个
用例脚本（使用例），math 纯函数若抽到 framework 侧可按 vitest 纯逻辑模式测
（参照 `src/framework/prototype/types.spec.ts` 的 vec3 工具测法）。
