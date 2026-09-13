// @desc: 昼夜循环：灯光颜色与强度按周期在正午白 ↔ 黄昏橙间往复（可联动旋转节点模拟日照弧线）
import { Component, property, engine, Light } from "tve";

// 挂到灯光节点上（点光/平行光/聚光灯均可）。onStart 取本节点的灯光组件门面，
// 之后每帧按 engine.time.elapsed 计算循环相位写入 color/intensity（运行态生效，
// 不回写场景文件）。
export default class {{CLASS_NAME}} extends Component {
  @property({ label: "循环周期（秒）", min: 1, step: 0.5 })
  period = 20;

  @property({ label: "正午强度", min: 0, step: 0.1 })
  noonIntensity = 1.2;

  @property({ label: "黄昏强度", min: 0, step: 0.1 })
  duskIntensity = 0.35;

  @property({ label: "联动旋转节点（日照弧线）" })
  rotateNode = true;

  /** 正午/黄昏光色（0xRRGGBB） */
  private readonly noonColor = 0xffffff;
  private readonly duskColor = 0xff9a3c;

  private light: Light | null = null;

  onStart() {
    this.light = this.entity.getComponent(Light);
    if (!this.light) {
      engine.warn("本节点没有灯光组件（请挂到灯光节点上）");
    }
  }

  onUpdate(_delta: number) {
    if (!this.light) return;
    // 相位 0..1；三角波 k：1 = 正午，0 = 黄昏（前半程白→橙，后半程橙→白）
    const phase = (engine.time.elapsed % this.period) / this.period;
    const k = phase < 0.5 ? phase * 2 : 2 - phase * 2;

    this.light.color = mixColor(this.duskColor, this.noonColor, k);
    this.light.intensity = this.duskIntensity + (this.noonIntensity - this.duskIntensity) * k;

    // 联动旋转：绕 X 轴一周模拟太阳升落（角度制欧拉角，度制写入）
    if (this.rotateNode) {
      this.entity.rotation = { x: phase * 360, y: 0, z: 0 };
    }
  }
}

/** 0xRRGGBB 线性插值（k=0 → a，k=1 → b；RGB 通道各自插值后合成） */
function mixColor(a: number, b: number, k: number): number {
  const l = (x: number, y: number) => Math.round(x + (y - x) * k);
  return (l((a >> 16) & 255, (b >> 16) & 255) << 16)
    | (l((a >> 8) & 255, (b >> 8) & 255) << 8)
    | l(a & 255, b & 255);
}
