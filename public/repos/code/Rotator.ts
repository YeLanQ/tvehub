// @desc: 最简入门：绕 Y 轴匀速自转（速度可调；onUpdate 每帧驱动）
import { Component, property } from "tve";

export default class {{CLASS_NAME}} extends Component {
  @property({ label: "速度（度/秒）", min: 0 })
  speed = 90;

  onUpdate(delta: number) {
    // rotate（度）按帧间隔叠加：帧率无关的匀速旋转
    this.entity.rotate(0, this.speed * delta, 0);
  }
}
