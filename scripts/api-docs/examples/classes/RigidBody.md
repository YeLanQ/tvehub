```ts tve
import { Component, RigidBody, Vec3 } from "tve";

export default class Jump extends Component {
  rigid!: RigidBody; // 组件字段：运行期自动绑定门面（未挂刚体时为空转）

  onFixedUpdate(fixedDelta: number) {
    // 物理写入放固定步长（1/60s，与物理步进同频，先于同帧 onUpdate）
    const v = this.rigid.getLinearVelocity();
    if (v && v.y === 0) {
      // 施加冲量起跳（世界空间，N·s）
      this.rigid.applyImpulse(0, 6, 0);
      this.rigid.wakeUp();
    }
    // 速度直写 / 重力缩放（0 = 不受重力）
    // this.rigid.setLinearVelocity(0, 0, 5);
    // this.rigid.setGravityScale(0.5);
    void fixedDelta;
  }

  onCollisionEnter(other: typeof this.entity) {
    // 碰撞回调里读门面信息
    void this.rigid.mode;           // "static" | "kinematic" | "dynamic"
    void this.rigid.colliderCount;  // 碰撞体数量
    void this.rigid.gravityScale;
    void other.id;
    void ({} as Vec3);
  }
}
```
