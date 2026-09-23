```ts tve
import { Component, property, CameraNode, engine } from "tve";

export default class ClickMove extends Component {
  @property({ type: CameraNode, label: "相机" })
  cam: CameraNode | null = null;

  onFixedUpdate() {
    if (!this.cam) return;
    // —— 施力/速度（动力学体；放固定步长回调）——
    // engine.physics.applyImpulse(this.entity, 0, 5, 0);  // 冲量（N·s，世界空间）
    // engine.physics.applyForce(this.entity, 0, -9.8, 0); // 持续力（N，每帧调用）
    // engine.physics.setLinearVelocity(this.entity, 0, 0, 5);   // m/s
    // engine.physics.setAngularVelocity(this.entity, 0, 3, 0); // rad/s
    void engine.physics.getLinearVelocity(this.entity); // Vec3 | null
    void engine.physics.bodyInfo(this.entity); // {mode,gravityScale,colliderCount} | null
    // engine.physics.setGravityScale(this.entity, 0); // 0 = 不受重力
    // engine.physics.wakeUp(this.entity);             // 修改参数后唤醒睡眠体
    // engine.physics.setGravity(0, -9.8, 0);          // 世界重力（影响全部动力学体）
  }

  onUpdate() {
    // —— 射线投射（拾取/视线检测）——
    if (!this.cam || !engine.input.pointer.down) return;
    const ray = this.cam.screenToRay(engine.input.pointer.x, engine.input.pointer.y);
    if (!ray) return;
    const hits = engine.physics.castRay({
      origin: ray.origin,
      direction: ray.direction,
      maxDistance: 100,
      excludeNodeIds: [this.entity.id], // 排除自身
    });
    void hits; // PhysicsRayHit[]：按距离升序（nodeId/point/normal/distance）
  }
}
```
