```ts tve
import { Component, property, UITextNode, dataCenter } from "tve";

export default class ScoreLabel extends Component {
  @property({ type: UITextNode, label: "计分文本" })
  label: UITextNode | null = null;

  onStart() {
    if (!this.label) return;
    // 内容与样式（\n 分行；超界自动换行）
    this.label.text = "得分 0";
    this.label.fontSize = 32;          // 设计像素（100px = 1 单位）
    this.label.color = 0xffffff;
    this.label.bold = true;
    this.label.fontFamily = "mono";    // system / serif / mono
    this.label.align = "center";       // 相对文本框

    // 尺寸与锚点（UI 单位；点锚点用 anchoredPosition）
    this.label.size = { x: 6, y: 1 };
    this.label.anchorMin = { x: 0.5, y: 1 };
    this.label.anchorMax = { x: 0.5, y: 1 };
    this.label.pivot = { x: 0.5, y: 1 };
    this.label.anchoredPosition = { x: 0, y: -0.5 };
  }

  onUpdate() {
    // 与数据中心联动刷新
    const score = dataCenter.get<number>("score") ?? 0;
    if (this.label) this.label.text = `得分 ${score}`;
  }
}
```
