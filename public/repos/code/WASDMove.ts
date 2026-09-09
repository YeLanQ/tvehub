// @desc: 使用WASD控制目标移动
// @desc: 使用WASD控制目标移动
import { Component, property, engine } from "tve";

// WASD 移动组件：按住 W/A/S/D 沿世界 X/Z 平面移动本节点；
// vertical 开启后 Space 上升 / 左Shift 下降。
export default class WASDMove extends Component {
  @property({ label: "移动速度（米/秒）", min: 0 })
  speed = 6;

  @property({ label: "启用升降（Space/左Shift）" })
  vertical = true;

  private __diagT = 0;

  onUpdate(delta: number) {
    this.__diagT += delta;
    if (this.__diagT > 0.6) {
      this.__diagT = 0;
      const p = this.entity.worldPosition;
      engine.log("[diag] cube world:", p.x.toFixed(2), p.y.toFixed(2), p.z.toFixed(2));
    }
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
    if (!dx && !dy && !dz) return;
    // 斜向归一化，保证各方向速度一致
    const len = Math.hypot(dx, dy, dz);
    const v = (this.speed * delta) / len;
    this.entity.translate(dx * v, dy * v, dz * v);
  }
}
