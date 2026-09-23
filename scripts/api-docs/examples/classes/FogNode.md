```ts tve
import { Component, property, FogNode, tween } from "tve";

export default class FogFade extends Component {
  // 雾节点（场景环境级：第一个启用且可见的雾节点生效）
  @property({ type: FogNode, label: "雾节点" })
  fog: FogNode | null = null;

  onStart() {
    // 剧情切入：雾淡出后隐藏（运行态写入不回写场景文件）
    if (!this.fog) return;
    this.fog.visible = true;
    tween.from({ o: 1 }, { o: 0 }, 2).onComplete(() => {
      this.fog!.visible = false;
    });
  }
}
```
