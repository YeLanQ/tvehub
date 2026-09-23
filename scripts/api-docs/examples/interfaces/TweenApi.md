```ts tve
import { tween, easing, Component, MeshNode, property } from "tve";

// 链式配置：创建即自动播放（引擎每帧推进，无需手动驱动）
const t = tween.value(0, 100, 2).easing("quadOut").onUpdate((v) => {
  /* v = 当前插值 */
});
t.playing;    // => true
t.duration;   // => 2
t.progress;   // => 0（尚未推进）

// 31 个缓动名（Robert Penner 标准族）或自定义函数
tween.value(0, 1, 1).easing(easing.backOut);
tween.value(0, 1, 1).easing((t: number) => 1 - Math.abs(1 - t * 2));

// 实体变换补间（部分字段：只写 x，其余保持）
export default class Punch extends Component {
  @property({ type: MeshNode, label: "目标" })
  target: MeshNode | null = null;

  onStart() {
    if (!this.target) return;
    tween.position(this.target, { x: 5 }, 1)
      .easing("quadOut")
      .onComplete(() => tween.scale(this.target!, { y: 0.6 }, 0.15).yoyo(true).loop(2));
  }
}
```

序列与并行组：

```ts tve
import { tween } from "tve";

// 串行组：依次播放；delay/call 是占位符
const seq = tween.sequence([
  tween.delay(0.5),
  tween.call(() => { /* 开始 */ }),
  tween.value(0, 10, 1),
]);
seq.playing; // => true

// 并行组：同时播放
tween.parallel([tween.value(0, 1, 1), tween.color(0xff0000, 0x00ff00, 2)]);

// 全局控制
tween.timeScale = 1;       // 0 = 冻结全部 tween
tween.activeCount >= 3;    // => true（上面创建的都活跃）
tween.killAll();           // 停止全部
tween.activeCount;         // => 0
```
