// @desc: 使用WASD控制目标移动（自动适配刚体：动力学=受重力的物理移动，会被障碍物阻挡）
import { Component, property, engine } from "tve";

// WASD 移动组件（onStart 自动探测刚体形态，选择移动方案）：
// - 动力学（dynamic）刚体 → 物理速度驱动：碰撞由引擎解算，撞到障碍物会被挡住；
// - 无刚体 / 运动学（kinematic）/ 静态 → 位移驱动：直接平移节点（不被阻挡）。

export default class WASDMove extends Component {
  @property({ label: "移动速度（米/秒）", min: 0 })
  speed = 6;

  /** 关闭后变为悬浮控制（不受重力，可用 Space/左Shift 升降） */
  @property({ label: "受重力影响" })
  useGravity = true;

  @property({ label: "启用升降（Space/左Shift）" })
  vertical = true;

  /** 移动方案（onStart 探测一次）：physics = 物理速度驱动 / kinematic = 位移驱动 */
  private scheme: "physics" | "kinematic" = "kinematic";

  onStart() {
    const rb = this.entity.getComponent("rigidBody");
    if (rb && rb.mode === "dynamic") {
      this.scheme = "physics";
      rb.setGravityScale(this.useGravity ? 1 : 0);
    }
  }

  onUpdate(delta: number) {
    const input = engine.input;
    let dx = 0, dy = 0, dz = 0;
    if (input.isKeyDown("KeyW")) dz -= 1;
    if (input.isKeyDown("KeyS")) dz += 1;
    if (input.isKeyDown("KeyA")) dx -= 1;
    if (input.isKeyDown("KeyD")) dx += 1;
    if (this.vertical) {
      if (input.isKeyDown("Space")) dy += 1;
      if (input.isKeyDown("ShiftLeft")) dy -= 1;
    }

    if (this.scheme === "physics") {
      // 物理方案：线速度驱动，碰撞由引擎解算（会被障碍物阻挡）
      const cur = engine.physics.getLinearVelocity(this.entity);
      const curY = cur ? cur.y : 0;
      const hlen = Math.hypot(dx, dz) || 1;
      const hv = (this.speed * Math.min(1, Math.hypot(dx, dz))) / hlen;
      // 垂直：有升降输入用输入速度；无输入保留当前 y 速度（重力自然生效）
      // const vy = dy ? dy * this.speed : curY;
      const vy = dy ? dy * this.speed : this.useGravity ? curY : 0;
      // 无水平输入时强制清零 → 松键立即停住，没有惯性滑动
      engine.physics.setLinearVelocity(
        this.entity,
        dx ? dx * hv : 0,
        vy,
        dz ? dz * hv : 0,
      );
    } else {
      // 位移方案：直接平移节点（无刚体/运动学；不被障碍物阻挡）
      if (!dx && !dy && !dz) return;
      const len = Math.hypot(dx, dy, dz);
      const v = (this.speed * delta) / len;
      this.entity.translate(dx * v, dy * v, dz * v);
    }
  }
}