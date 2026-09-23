```ts tve
import { Component, engine, Entity, MeshNode, property, Vec3 } from "tve";

// 全部钩子可选、按需实现；onEnable 全体先于 onStart 全体
export default class Lifecycle extends Component {
  @property({ type: MeshNode, label: "目标" })
  target: MeshNode | null = null;

  onEnable() {
    // 实例创建后：可安全引用其他实体与组件
    engine.log("enabled on", this.entity.name);
  }

  onStart() {
    // 全部实例创建后、首个 onUpdate 前，一次性初始化
  }

  onGraphInput(value: MeshNode[] | number | Vec3 | null) {
    // 场景图接入口收到新值（值变化边沿触发）；同值可随时读 this.graphInput
  }

  onFixedUpdate(fixedDelta: number) {
    // 固定步长 1/60s（与物理同频；掉帧补偿 0..4 次）——施力/速度写这里
  }

  onUpdate(delta: number) {
    // 每帧（渲染帧率）
  }

  onLateUpdate(delta: number) {
    // 全部模拟（脚本/动画/物理/粒子）后、相机回填与渲染前——相机跟随写这里
  }

  onCollisionEnter(other: Entity) {
    // 碰撞开始（须挂碰撞体 + 项目启用物理；传感器同样触发）
    engine.log("hit", other.name);
  }

  onCollisionExit(other: Entity) {
    // 接触断开
  }

  onDisable() {
    // 停机：释放定时器/事件订阅（先于 onDestroy）
  }

  onDestroy() {
    // 实例销毁
  }
}
```
