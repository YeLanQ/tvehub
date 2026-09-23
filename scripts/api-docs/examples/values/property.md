三种属性写法（推荐字段 + `@property` 装饰器）：

```ts tve
import { Component, property, MeshNode, AnimationClip, engine } from "tve";

export default class Demo extends Component {
  // 1. 基本类型：类型由字段初值推断（number/boolean/string）
  @property({ label: "速度", min: 0, max: 100, step: 1, tooltip: "度/秒" })
  speed = 90;
  @property({ label: "无敌" })
  invincible = false;

  // 2. 特殊值类型：颜色（#rrggbb 字符串）与向量需显式传 type
  @property({ type: "color", label: "受击闪色" })
  hitColor = "#ff3020";
  @property({ type: "vec3", label: "出生点" })
  spawnPoint = { x: 0, y: 1, z: 0 };

  // 3a. 场景节点引用：type 传节点类型类，检查器按类型过滤可选节点
  @property({ type: MeshNode, label: "目标网格" })
  target: MeshNode | null = null;

  // 3b. 内置组件引用：装饰器实参直接传组件类，运行期 get-or-create 绑定门面
  @property(AnimationClip)
  anim!: AnimationClip;

  onUpdate(delta: number) {
    if (this.target) this.target.rotate(0, this.speed * delta, 0);
    engine.log("速度", this.speed, "无敌", this.invincible);
  }
}
```
