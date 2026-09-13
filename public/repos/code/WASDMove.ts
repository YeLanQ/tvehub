// @desc: 使用WASD控制目标移动（自动适配刚体：动力学=受重力的物理移动，会被障碍物阻挡）
import { Component, property, engine } from "tve";

// WASD 移动组件（onStart 自动探测刚体形态，选择移动方案）：
// - 动力学（dynamic）刚体 → 物理速度驱动：碰撞由引擎解算，撞到障碍物会被挡住；
//   速度写入在 onFixedUpdate（固定步长、与物理步进同频——物理相关的写入放
//   固定步长钩子里帧率无关，且下一步进即生效）；onUpdate 只读按键缓存意图；
// - 无刚体 / 运动学（kinematic）/ 静态 → 位移驱动：onUpdate 直接平移节点
//   （渲染帧率下平滑；不被阻挡）。
//
// 建议配置：速度驱动角色把自身碰撞体的「摩擦系数」设为 0——滑行时地面摩擦力
// 作用在偏心接触面上会产生力矩导致自转（ammo 后端尤其明显）；本组件松键即清零
// 速度，停止不依赖摩擦，摩擦 0 无副作用。

export default class {{CLASS_NAME}} extends Component {
  @property({ label: "移动速度（米/秒）", min: 0 })
  speed = 6;

  /** 关闭后变为悬浮控制（不受重力，可用 Space/左Shift 升降） */
  @property({ label: "受重力影响" })
  useGravity = true;

  @property({ label: "启用升降（Space/左Shift）" })
  vertical = true;

  /** 移动方案（onStart 探测一次）：physics = 物理速度驱动 / kinematic = 位移驱动 */
  private scheme: "physics" | "kinematic" = "kinematic";

  /** 移动意图（-1/0/1 三轴；onUpdate 读键缓存，onFixedUpdate 消费） */
  private moveX = 0;
  private moveY = 0;
  private moveZ = 0;

  onStart() {
    const rb = this.entity.getComponent("rigidBody");
    if (rb && rb.mode === "dynamic") {
      this.scheme = "physics";
      rb.setGravityScale(this.useGravity ? 1 : 0);
    }
  }

  onUpdate(delta: number) {
    const input = engine.input;
    this.moveX = (input.isKeyDown("KeyD") ? 1 : 0) - (input.isKeyDown("KeyA") ? 1 : 0);
    this.moveZ = (input.isKeyDown("KeyS") ? 1 : 0) - (input.isKeyDown("KeyW") ? 1 : 0);
    this.moveY = this.vertical
      ? (input.isKeyDown("Space") ? 1 : 0) - (input.isKeyDown("ShiftLeft") ? 1 : 0)
      : 0;

    // 位移方案：onUpdate 平移（渲染帧率下平滑；无刚体/运动学；不被障碍物阻挡）
    if (this.scheme !== "physics") {
      const dx = this.moveX, dy = this.moveY, dz = this.moveZ;
      if (!dx && !dy && !dz) return;
      const len = Math.hypot(dx, dy, dz);
      const v = (this.speed * delta) / len;
      this.entity.translate(dx * v, dy * v, dz * v);
    }
  }

  onFixedUpdate(_fixedDelta: number) {
    // 物理方案：固定步长内写线速度，碰撞由引擎解算（会被障碍物阻挡）
    if (this.scheme !== "physics") return;
    const dx = this.moveX, dy = this.moveY, dz = this.moveZ;
    const cur = engine.physics.getLinearVelocity(this.entity);
    const curY = cur ? cur.y : 0;
    const hlen = Math.hypot(dx, dz) || 1;
    const hv = (this.speed * Math.min(1, Math.hypot(dx, dz))) / hlen;
    // 垂直：有升降输入用输入速度；无输入保留当前 y 速度（重力自然生效）
    const vy = dy ? dy * this.speed : this.useGravity ? curY : 0;
    // 无水平输入时强制清零 → 松键立即停住，没有惯性滑动
    engine.physics.setLinearVelocity(
      this.entity,
      dx ? dx * hv : 0,
      vy,
      dz ? dz * hv : 0,
    );
  }
}
