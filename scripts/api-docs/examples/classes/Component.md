```ts tve
import { Component, property, engine, MeshNode, AnimationClip } from "tve";

export default class Full extends Component {
  // 装饰器字段：初值即默认值与类型推断来源；检查器配置的覆盖值运行期生效
  @property({ label: "速度", min: 0 })
  speed = 90;

  // 组件字段（裸声明须带确定类型标注）：运行期宿主 get-or-create 并绑定门面
  anim!: AnimationClip;

  @property({ type: MeshNode, label: "目标" })
  target: MeshNode | null = null;

  // 只读视图：装饰器字段当前值 + 检查器覆盖值（不要写入）
  // this.props.speed 与 this.speed 同源

  onStart() {
    // 一次性初始化（全部实例的 onEnable 先于全部 onStart）
    this.anim.speed = 2;
    this.anim.play();
    engine.log("挂载于", this.entity.name);
  }

  onUpdate(delta: number) {
    // 每帧逻辑；this.speed 类型为 number
    if (this.target) this.entity.rotate(0, this.speed * delta, 0);
  }

  onDestroy() {
    // 释放定时器/事件订阅等外部资源
  }
}
```
