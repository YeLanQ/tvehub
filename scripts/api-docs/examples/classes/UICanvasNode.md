```ts tve
import { Component, property, UICanvasNode, UITextNode, UIVec2 } from "tve";

export default class HUD extends Component {
  @property({ type: UICanvasNode, label: "主画布" })
  canvas: UICanvasNode | null = null;

  @property({ type: UITextNode, label: "计分文本" })
  scoreText: UITextNode | null = null;

  onStart() {
    if (!this.canvas) return;
    // 画布整体叠加序（多画布大者在上）与屏幕适配（仅预览/产物运行时生效）
    this.canvas.sortOrder = 10;
    this.canvas.designWidth = 1920; // 设计像素，100px = 1 UI 单位
    this.canvas.designHeight = 1080;
    this.canvas.scaleMode = "fixedauto";

    // 点锚点定位：枢轴相对锚点的偏移（UI 单位）
    if (this.scoreText) {
      const pos: UIVec2 = { x: -8, y: 4.5 }; // 画布局部：原点在中心，y 向上
      this.scoreText.anchoredPosition = pos;
      this.scoreText.text = "得分 0";
    }
  }
}
```
