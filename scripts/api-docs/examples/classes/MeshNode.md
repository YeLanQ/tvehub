```ts tve
import { Component, property, MeshNode, math, tween } from "tve";

export default class MeshDemo extends Component {
  // 引用场景里的网格节点（基元/模型网格）；检查器按类型过滤候选
  @property({ type: MeshNode, label: "门" })
  door: MeshNode | null = null;

  @property({ type: MeshNode, label: "移动目标" })
  goal: MeshNode | null = null;

  @property({ label: "开门时长（秒）", min: 0.1 })
  duration = 1;

  onStart() {
    if (!this.door) return;
    // 网格节点 = Entity 子类：变换/层级/组件全量可用
    tween.position(this.door, { y: 3 }, this.duration).easing("quadInOut");
  }

  onUpdate(delta: number) {
    if (!this.goal) return;
    // 与通用实体完全一致的语义（度制欧拉角、快照读写）
    this.entity.rotation = { y: this.entity.rotation.y + 30 * delta };
    const dir = math.normalize(math.sub(this.goal.position, this.entity.position));
    void dir;
  }
}
```
