```ts tve
import { tween, Component } from "tve";

// 补间句柄由 tween 工厂创建（创建即播放）；同一语句内链式配置全部生效
const t = tween.value(0, 10, 5)
  .easing("sineInOut")
  .delay(0.5)
  .onStart(() => { /* delay 结束后触发一次 */ })
  .onUpdate((value, k) => { /* value = 插值输出；k = easing 后系数 0..1 */ })
  .onComplete(() => { /* 播完触发一次 */ });

t.playing;   // => true
t.paused;    // => false
t.loop(3);   // 循环 3 次（-1 = 无限）
t.yoyo(true); // 往返：偶数次循环反向插值

// 暂停/恢复/停止
t.pause();
t.paused;    // => true
t.resume();
t.stop();          // 移出推进列表，不再恢复
t.playing;         // => false
```

串接（完成后自动启动下一个）：

```ts tve
import { tween } from "tve";

const first = tween.value(0, 1, 0.2);
const second = tween.value(1, 0, 0.2);
const chain = first.then(second); // first 播完自动启动 second
chain === second; // => true（返回 next 以便继续链式配置）
```
