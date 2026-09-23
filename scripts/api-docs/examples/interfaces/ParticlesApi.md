```ts tve
import { Component, property, ParticleSystemNode, engine, ParticleSettings } from "tve";

export default class FxControl extends Component {
  @property({ type: ParticleSystemNode, label: "烟尘特效" })
  smoke: ParticleSystemNode | null = null;

  onStart() {
    if (!this.smoke) return;
    // 按实体寻址的运行期控制（与节点句柄同名方法等价）
    engine.particles.play(this.smoke);
    // engine.particles.pause(this.smoke);
    // engine.particles.stop(this.smoke);   // 停止发射，存活粒子自然消亡
    // engine.particles.restart(this.smoke);
    // engine.particles.clear(this.smoke);

    // 运行态快照（非粒子节点 null）
    void engine.particles.stateOf(this.smoke); // {playing,paused,finished,alive,time}

    // 合并发射设置（子集；运行态生效不回写场景文件）
    const patch: Partial<ParticleSettings> = { emissionRate: 120, startColor: 0x999999 };
    engine.particles.setSettings(this.smoke, patch);
  }
}
```
