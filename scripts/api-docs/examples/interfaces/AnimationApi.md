```ts tve
import { Component, property, MeshNode, engine } from "tve";

export default class AnimControl extends Component {
  @property({ type: MeshNode, label: "角色（模型网格）" })
  actor: MeshNode | null = null;

  onStart() {
    if (!this.actor) return;
    // 模型动画运行期控制（按实体寻址；仅模型网格节点有效）
    engine.animation.play(this.actor, "run"); // 图模式 = 目标状态名；缺省取首个剪辑
    // engine.animation.pause(this.actor);
    // engine.animation.resume(this.actor);
    // engine.animation.stop(this.actor);   // 回初始姿势
  }
}
```
