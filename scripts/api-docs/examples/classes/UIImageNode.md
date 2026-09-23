```ts tve
import { Component, property, UIImageNode, tween } from "tve";

export default class DamageFlash extends Component {
  @property({ type: UIImageNode, label: "受击遮罩" })
  flash: UIImageNode | null = null;

  onStart() {
    if (!this.flash) return;
    // 图片资产相对路径（空串 = 纯色矩形；运行态异步加载热替换）
    this.flash.image = "assets/vignette.png";
    this.flash.color = 0xff2020; // 着色（与图片相乘）
    this.flash.sortOrder = 100;  // 画布内叠加序（大者在上）

    // 拉伸铺满：锚点 min<max 的轴由父矩形与边距推导
    this.flash.anchorMin = { x: 0, y: 0 };
    this.flash.anchorMax = { x: 1, y: 1 };

    // 淡入淡出（UI 字段可补间：对象字段允许部分分量）
    tween.from(this.flash, { color: 0x000000 }, 0.05);
  }
}
```
