// @desc: 碰撞回调与冲量反弹：onCollisionEnter/Exit 计数提示，接触瞬间把对方弹开
import { Component, property, engine, Entity, math } from "tve";

// 前提：本节点与对方都挂碰撞体，且项目设置启用物理。
// 弹开用 applyImpulse（世界空间冲量）——动力学体才会被推动；
// 冷却时间内不重复施加，避免贴合状态下每帧连击。
export default class {{CLASS_NAME}} extends Component {
  @property({ label: "冲量强度（0 = 不弹开）", min: 0, step: 0.5 })
  bounce = 5;

  @property({ label: "弹开冷却（秒）", min: 0, step: 0.1 })
  cooldown = 0.5;

  /** 碰撞中的对方实体集合（Enter 加入 / Exit 移除，演示接触状态跟踪） */
  private touching = new Set<string>();
  private lastBounceAt = -1e9;

  onCollisionEnter(other: Entity) {
    this.touching.add(other.id);
    engine.log("碰撞进入：", other.name, `（正在接触 ${this.touching.size} 个）`);
    this.tryBounce(other);
  }

  onCollisionExit(other: Entity) {
    this.touching.delete(other.id);
    engine.log("碰撞结束：", other.name);
  }

  /** 从对方指向自己的方向施加冲量弹开（y 分量抬一点，避免贴地弹跳）
   *  ——本脚本挂在主动方时对方被弹开；把冲量换成施加给自己即可反向 */
  private tryBounce(other: Entity) {
    if (this.bounce <= 0) return;
    const now = engine.time.elapsed;
    if (now - this.lastBounceAt < this.cooldown) return;
    this.lastBounceAt = now;
    const dir = math.normalize(
      math.sub(other.worldPosition, this.entity.worldPosition),
    );
    engine.physics.applyImpulse(
      other,
      dir.x * this.bounce,
      Math.max(0.35, dir.y) * this.bounce,
      dir.z * this.bounce,
    );
  }
}
