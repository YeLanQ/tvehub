```ts tve
import { Component, property, ParticleSystemNode, ParticleSettings } from "tve";

export default class Explode extends Component {
  @property({ type: ParticleSystemNode, label: "爆炸特效" })
  fx: ParticleSystemNode | null = null;

  onStart() {
    if (!this.fx) return;
    // 单字段直写（运行态生效，不回写场景文件）
    this.fx.startColor = 0xffcc33;    // 0xRRGGBB
    this.fx.emissionRate = 200;
    this.fx.gravityModifier = 0.5;

    // 或批量合并（maxParticles/blending 变化会重建发射器）
    const patch: Partial<ParticleSettings> = {
      duration: 1.5,
      looping: false,
      startSpeed: 8,
      shape: "cone",
      shapeAngle: 25,
      colorOverLifetime: true,
    };
    this.fx.setSettings(patch);

    // 播放控制
    this.fx.restart();      // 清空粒子从头开始
    // this.fx.play();      // 暂停态续播
    // this.fx.pause();     // 暂停（保留当前粒子）
    // this.fx.stop();      // 停止发射（存活粒子自然消亡）
    // this.fx.clear();     // 立即清空全部粒子
  }

  onUpdate() {
    if (!this.fx) return;
    // 运行态（只读）：playing / paused / finished / aliveCount / settings
    if (this.fx.finished) this.fx.restart();
  }
}
```
