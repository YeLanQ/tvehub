// @desc: 始终朝向目标节点（可设触发距离：超出后隐藏/显示自身，状态切换只提示一次）
import { Component, property, engine, Transform, math } from "tve";

export default class {{CLASS_NAME}} extends Component {
  @property({ type: Transform, label: "朝向目标" })
  target: Transform | null = null;

  /** 触发距离（米）；0 = 不限制（只朝向） */
  @property({ label: "触发距离（0 = 不限制）", min: 0, step: 0.5 })
  range = 0;

  /** 超出触发距离时隐藏自身，回到范围内再显示（需 range > 0） */
  @property({ label: "超距隐藏自身" })
  hideOutOfRange = true;

  /** 当前是否处于隐藏态（状态切换只提示一次） */
  private hidden = false;

  onUpdate(_delta: number) {
    if (!this.target) return;
    // 朝向世界坐标目标（前向 = -Z，与灯光/相机朝向约定一致）
    this.entity.lookAt(this.target.worldPosition);

    if (this.range <= 0 || !this.hideOutOfRange) return;
    const inRange =
      math.distance(this.entity.worldPosition, this.target.worldPosition) <= this.range;
    if (inRange === this.hidden) {
      this.hidden = !inRange;
      this.entity.visible = inRange;
      engine.log(inRange ? "目标进入范围，已显示" : "目标超出范围，已隐藏");
    }
  }
}
