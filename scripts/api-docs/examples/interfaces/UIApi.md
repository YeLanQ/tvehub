```ts tve
import { Component, property, UICanvasNode, UITextNode, engine } from "tve";

export default class UiRuntime extends Component {
  @property({ type: UITextNode, label: "提示文本" })
  tip: UITextNode | null = null;

  onStart() {
    if (!this.tip) return;
    // 合并 Widget 设置（子集；运行态生效不回写场景文件）
    engine.ui.set(this.tip, { text: "按 E 交互", color: 0xffcc00, fontSize: 24 });
    // 读取当前设置快照（非 UI 节点 null）
    void engine.ui.get(this.tip);

    // 按钮点击订阅 / 解绑（仅 uiButtonNode 且 interactable）
    // const off = engine.ui.onClick(btn, () => {});
    // engine.ui.offClick(btn, handler);
  }

  onUpdate() {
    if (!this.tip) return;
    // 解析矩形（画布局部：原点在中心，y 向上，UI 单位；布局容器子节点返回槽位矩形）
    const r = engine.ui.rectOf(this.tip);
    // 屏幕度量（随窗口/缩放模式变化，建议每帧读取）
    const m = engine.ui.metricsOf(this.tip);
    // 屏幕像素 → 画布局部 UI 坐标（与 engine.input.pointer 同一像素空间）
    const p = engine.ui.screenToUi(this.tip, engine.input.pointer.x, engine.input.pointer.y);
    if (r && p) {
      const inside = Math.abs(p.x - r.cx) <= r.w / 2 && Math.abs(p.y - r.cy) <= r.h / 2;
      engine.ui.set(this.tip, { color: inside ? 0xffffff : 0x888888 });
    }
    void m;
  }
}
```
