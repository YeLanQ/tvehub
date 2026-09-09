// @desc: 简易相机跟随，支持平滑或瞬时跟随
import { Component, property, Transform, math } from "tve";

export default class CameraFollow extends Component {
  @property({ type: Transform, label: "跟随目标" })
  target: Transform | null = null;

  @property({ label: "平滑系数（0 = 瞬时跟随）", min: 0, step: 0.1 })
  smooth = 5;

  /** 跟随距离（米）。0 = 自动：按挂载时相机与目标的初始直线距离 */
  @property({ label: "跟随距离（0 = 自动）", min: 0, step: 0.5 })
  offset = 0;

  /** 计算好的跟随偏移向量（onStart 定一次，之后每帧复用；不带 @property，检查器不显示） */
  private offsetVec: { x: number; y: number; z: number } | null = null;

  onStart() {
    if (!this.target) return;
    // 初始偏移向量 = 相机位置 − 目标位置（方向与你现在的摆位一致）
    let vec = math.sub(this.entity.worldPosition, this.target.worldPosition);
    if (this.offset > 0) {
      // 写死距离：保持方向不变，把直线距离缩放到 offset
      const len = math.length(vec);
      vec = len > 1e-4
        ? math.scale(vec, this.offset / len)
        : math.scale(math.back, this.offset); // 与目标重合时退到正后方
    }
    this.offsetVec = vec;
  }

  onUpdate(delta: number) {
    if (!this.target || !this.offsetVec) return;
    const t = this.target.worldPosition;
    // 期望位置 = 目标位置 + 偏移向量（直线距离恒等于 |offsetVec|，永不与目标重叠）
    const goal = math.add(t, this.offsetVec);
    const p = this.entity.position;
    const k = this.smooth > 0 ? 1 - Math.exp(-this.smooth * delta) : 1;
    this.entity.position = math.lerp(p, goal, k);
  }
}