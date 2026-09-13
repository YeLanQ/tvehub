// @desc: 按键触发粒子爆发：清空重播 + 瞬时提高发射率再回落（engine.input 事件订阅 + 粒子门面）
import { Component, property, engine, ParticleSystemNode } from "tve";

// 使用：把本脚本挂到任意节点，fx 指向一个粒子系统节点；运行中按触发键即爆发。
// 事件订阅（onKeyDown）返回解绑函数——外部订阅在 onDestroy 释放是惯例。
export default class {{CLASS_NAME}} extends Component {
  @property({ type: ParticleSystemNode, label: "目标粒子" })
  fx: ParticleSystemNode | null = null;

  @property({ label: "触发按键（KeyboardEvent.code）" })
  key = "Space";

  @property({ label: "爆发发射率倍率", min: 1 })
  boost = 4;

  @property({ label: "爆发持续（秒）", min: 0.1, step: 0.1 })
  boostTime = 1.5;

  /** 原始发射率（onStart 记录一次，爆发结束后回落） */
  private baseRate = 20;
  private boostUntil = -1;
  private offKey: (() => void) | null = null;

  onStart() {
    if (!this.fx) {
      engine.warn("未指定目标粒子（检查器选择一个粒子系统节点）");
      return;
    }
    this.baseRate = this.fx.settings?.emissionRate ?? 20;

    // 订阅按键按下（code 与 KeyboardEvent.code 一致，如 "Space"/"KeyF"）
    this.offKey = engine.input.onKeyDown((code) => {
      if (code !== this.key || !this.fx) return;
      // 清空粒子并从头开始（发射器预热快进，即刻可见一簇新粒子）
      this.fx.restart();
      // 瞬时提高发射率形成"爆发"，boostTime 秒后在 onUpdate 回落
      this.fx.setSettings({ emissionRate: this.baseRate * this.boost });
      this.boostUntil = engine.time.elapsed + this.boostTime;
      engine.log(`粒子爆发（${this.key}）：发射率 ×${this.boost}，当前存活`, this.fx.aliveCount);
    });
  }

  onUpdate(_delta: number) {
    if (this.boostUntil > 0 && engine.time.elapsed >= this.boostUntil) {
      this.boostUntil = -1;
      this.fx?.setSettings({ emissionRate: this.baseRate });
      engine.log("粒子发射率回落：", this.baseRate, "/秒");
    }
  }

  onDestroy() {
    // 释放按键订阅（避免悬挂回调）
    this.offKey?.();
    this.offKey = null;
  }
}
