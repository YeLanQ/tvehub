```ts tve
import { Component, property, UIButtonNode, engine } from "tve";

export default class MenuButtons extends Component {
  @property({ type: UIButtonNode, label: "开始按钮" })
  startBtn: UIButtonNode | null = null;

  onStart() {
    // 外观（背景/标签均可运行态改写）
    if (this.startBtn) {
      this.startBtn.label = "开始游戏";
      this.startBtn.labelColor = 0xffffff;
      this.startBtn.fontSize = 28;
      this.startBtn.color = 0x2f6f3f;    // 背景着色（0xRRGGBB）
      this.startBtn.image = "";          // 空串 = 纯色背景
      this.startBtn.interactable = true; // false = 仅展示，不参与点击命中
    }

    // 点击订阅统一走 engine.ui.onClick（见 UIApi；按钮节点须 interactable）
    if (this.startBtn) {
      const off = engine.ui.onClick(this.startBtn, () => engine.log("开始！"));
      void off; // off() 解绑；组件销毁时调用可防悬挂回调
    }
  }
}
```
