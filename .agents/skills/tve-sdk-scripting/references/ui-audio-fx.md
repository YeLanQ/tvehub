# 单元：UI 画布 / 音频 / 粒子 / 灯光（运行态控制）

## 契约（速查）

**UI**（100px = 1 UI 单位；锚点 0..1 归一化）：节点类 `UICanvasNode`（sortOrder/
designWidth/designHeight/scaleMode）、`UIImageNode`（image/color）、`UITextNode`
（text/fontSize/color/bold/align）、`UIButtonNode`（label/interactable）、
`UILayoutNode`（layoutMode: horizontal|vertical|grid + padding/spacing/gridColumns），
全部实现 UIWidgetBase（sortOrder/size/anchorMin/Max/pivot/anchoredPosition/offsetMin/Max）。
`engine.ui`：`set(e, patch)/get(e)`、`onClick(e, cb) → 解绑`、`offClick(e, cb)`、
`rectOf(e) → UIRect|null`（画布局部，原点中心 y 向上）、`metricsOf(e)`（屏幕像素 ↔
UI 单位换算，建议每帧读）、`screenToUi(e, x, y)`。

**音频**：`AudioSource` 门面（`source/loop/volume/speed/spatial:"2d"|"3d"/play/stop/
pause/resume`）+ `engine.audio.play/stop/pause/resume/setVolume(e, v)`（按实体寻址）。
**粒子**：`ParticleSystemNode`（`play/pause/stop/restart/clear`、`settings` 快照、
`setSettings(patch)`、`aliveCount/finished`）+ `engine.particles` 同名按实体寻址。
**灯光**：`Light` 门面（`enabled/kind/color(0xRRGGBB)/intensity/distance/angle/
penumbra/castShadow/shadowType:"off"|"hard"|"soft"` 等，写即生效不落盘）。

## 模板：UI 按钮点击 + 文本更新

`public/repos/code/ButtonPulse.ts` 是点击反馈完整模板；点击订阅骨架：

```ts
import { Component, engine, UITextNode } from "tve";

export default class Menu extends Component {
  @property({ type: UITextNode, label: "计数文本" })
  label: UITextNode | null = null;
  private count = 0;
  private off?: () => void;

  onStart() {
    // 本脚本挂在按钮节点上；也可以 onClick(别的按钮实体) 订阅任意按钮
    this.off = engine.ui.onClick(this.entity, () => {
      this.count += 1;
      if (this.label) this.label.text = `点击：${this.count}`;
    });
  }
  onDestroy() { this.off?.(); }
}
```

## 模板：昼出夜伏灯光循环

`public/repos/code/DayNightCycle.ts` 全文即权威模板，核心：

```ts
private light: Light | null = null;
onStart() {
  this.light = this.entity.getComponent(Light);
  if (!this.light) engine.warn("本节点没有灯光组件（请挂到灯光节点上）");
}
onUpdate(_delta: number) {
  if (!this.light) return;
  const phase = (engine.time.elapsed % this.period) / this.period;   // 0..1
  this.light.color = mixColor(0xff9a3c, 0xffffff, phase < 0.5 ? phase * 2 : 2 - phase * 2);
  this.light.intensity = 0.35 + (1.2 - 0.35) * (phase < 0.5 ? phase * 2 : 2 - phase * 2);
  this.entity.rotation = { x: phase * 360 };                          // 日照弧线
}
```

## 模板：粒子爆破（重播 + 参数热改）

`public/repos/code/ParticleBurst.ts` 思路 + ParticleSystemNode 能力：

```ts
@property({ type: ParticleSystemNode, label: "爆炸特效" })
fx: ParticleSystemNode | null = null;

onStart() {
  if (!this.fx) return;
  this.fx.setSettings({           // 子集合并；maxParticles/blending 改动重建发射器
    startColor: 0xffcc33, emissionRate: 200, gravityModifier: 0.4,
  });
  this.fx.restart();              // 清空从头放（循环系统预热快进一周期）
}
```

## 模板：音效触发

```ts
// 挂音源节点（或任意节点）上；engine.audio 按实体寻址首个音源
const src = this.entity.getComponent("audioSource");   // AudioSource 门面
if (src) { src.volume = 0.6; src.spatial = "3d"; src.play(); }
// 一次性重播：src.stop(); src.play();
```

## 测试例

- 工坊示例：`ButtonPulse.ts`、`DayNightCycle.ts`、`ParticleBurst.ts`、`AnimationDemo.ts`。
- 回归：`smoke-particles-runtime.mjs` 为 P1 已知漂移套件（对照 tests/ISSUES.md 判断）。
