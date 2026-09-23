```ts tve
import { easing } from "tve";

// 名称 → 插值函数（t 0..1 → eased；back/elastic 中间会超调出界）
easing.linear(0.5);  // => 0.5
easing.quadIn(0.5);  // => 0.25（加速起步：t²）
easing.quadOut(0.5); // => 0.75（减速收尾：1-(1-t)²）

// 与 tween.easing 名称共用同一张表
easing.bounceOut(1); // => 1（端点保持 0→1）
easing.elasticOut(0); // => 0
```
