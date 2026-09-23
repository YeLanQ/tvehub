```ts tve
import { Component, Collider, Entity } from "tve";

export default class Pickup extends Component {
  // 碰撞体门面：形状/表面材质在检查器编辑，运行时只读
  col!: Collider;

  onCollisionEnter(other: Entity) {
    const col = this.entity.getComponent(Collider) ?? this.col;
    void col.shape;      // "box"/"sphere"/"capsule"/"cylinder"/"convex"（场景命中形状）
    void col.isSensor;   // 传感器：只产生触发不产生碰撞响应
    void col.friction;   // 摩擦系数
    void col.restitution;// 弹性系数
    void col.count;      // 物理世界中的碰撞体数量
    // 传感器触发区（拾取物/传送门）惯用法：isSensor + onCollisionEnter
    if (col.isSensor && other.name === "Player") {
      // 拾取逻辑……
    }
  }
}
```
