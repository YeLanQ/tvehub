// @desc: 补间动画入门：入场缩放弹出 + 无限往返巡航（tween.from/sequence + 缓动/循环）
import { Component, property, engine, tween } from "tve";

// tween 由引擎每帧自动推进（脚本 onUpdate 前），创建即播放，无需手动驱动。
// 缓动命名：In = 加速起步，Out = 减速收尾，InOut = 两端缓入缓出（backOut 带回弹）。
export default class {{CLASS_NAME}} extends Component {
  @property({ label: "单程时长（秒）", min: 0.1, step: 0.1 })
  duration = 2;

  @property({ label: "巡航距离（米）", min: 0, step: 0.5 })
  range = 3;

  @property({ label: "摆动幅度（度）", min: 0 })
  swing = 12;

  onStart() {
    // 入场：从 0.01 缩放弹回原尺寸（from = 以声明值为起点，渐变回当前值）
    tween.from(this.entity, { scale: { x: 0.01, y: 0.01, z: 0.01 } }, 0.6)
      .easing("backOut")
      .onComplete(() => engine.log("入场完成"));

    // 巡航：X 正向 → 停顿 → 回起点，无限循环（sequence = 依次播放子 tween）
    const px = this.entity.position.x;
    tween.sequence([
      tween.position(this.entity, { x: px + this.range }, this.duration).easing("sineInOut"),
      tween.delay(0.3),
      tween.position(this.entity, { x: px }, this.duration).easing("sineInOut"),
      tween.delay(0.3),
    ]).loop(-1);

    // 姿态摆动：yoyo 往返（偶数次循环反向插值），绕 Y 轴 ±swing 度摆动
    if (this.swing > 0) {
      tween.rotation(this.entity, { y: this.swing }, 1)
        .easing("sineInOut")
        .yoyo(true)
        .loop(-1);
    }
  }
}
