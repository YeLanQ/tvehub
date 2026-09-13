// @desc: UI 按钮点击反馈：缩放脉冲动画 + 点击计数（挂到 UI 按钮节点，engine.ui.onClick 订阅）
import { Component, property, engine, tween } from "tve";

// 使用：把本脚本挂到一个 UI 按钮节点（uiButtonNode）上；预览中点击按钮即触发
// 脉冲并在控制台累计计数。脉冲期间忽略再次点击（避免补间互相覆盖打架）。
export default class {{CLASS_NAME}} extends Component {
  @property({ label: "脉冲放大倍率", min: 1, step: 0.05 })
  punch = 1.15;

  @property({ label: "按下时长（秒）", min: 0.02, step: 0.01 })
  pressTime = 0.08;

  @property({ label: "回弹时长（秒）", min: 0.02, step: 0.01 })
  releaseTime = 0.2;

  private count = 0;
  private busy = false;

  onStart() {
    // 订阅按钮点击（返回解绑函数；onDestroy 释放）
    const off = engine.ui.onClick(this.entity, () => this.pulse());
    this.offClick = off;
  }

  private offClick: (() => void) | null = null;

  private pulse() {
    if (this.busy) return;
    this.busy = true;
    this.count += 1;
    engine.log("按钮被点击：", this.count, "次");
    // 缩放脉冲：快速放大（quadOut 减速收尾）→ 弹性回弹（bounceOut）
    // scale 写节点本地缩放，1 = 原尺寸；UI 按钮同样适用
    const s = this.entity.scale;
    tween.sequence([
      tween.scale(this.entity, { x: s.x * this.punch, y: s.y * this.punch, z: 1 }, this.pressTime).easing("quadOut"),
      tween.scale(this.entity, { x: s.x, y: s.y, z: 1 }, this.releaseTime).easing("bounceOut"),
    ]).onComplete(() => {
      this.busy = false;
    });
  }

  onDestroy() {
    this.offClick?.();
    this.offClick = null;
  }
}
