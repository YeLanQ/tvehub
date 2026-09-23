```ts tve
import { tween } from "tve";

// 工厂速查（创建即播放）：
//   to / from / value / color / position / rotation / scale /
//   sequence / parallel / delay / call
const t1 = tween.value(0, 100, 1);
const t2 = tween.color(0x000000, 0xffffff, 0.5); // 0xRRGGBB 颜色插值

// to：数值/向量属性插值（Entity 变换、UI 字段、任意同名字段对象）
// from：从 props 反向渐变回当前值（入场动画常用）
tween.to({ hp: 100 }, { hp: 30 }, 0.3);
tween.from({ opacity: 0 }, { opacity: 1 }, 0.3);

// 全局控制与统计
tween.activeCount >= 1; // => true
tween.pauseAll();
tween.resumeAll();
tween.killAll();
tween.activeCount;      // => 0

void t1; void t2;
```
