```ts tve
import { Component, property, UILayoutNode, UITextNode, UIVec2, UIPadding, engine } from "tve";

export default class StatList extends Component {
  @property({ type: UILayoutNode, label: "属性列表容器" })
  list: UILayoutNode | null = null;

  onStart() {
    if (!this.list) return;
    // 排列模式：横向一行 / 竖向一列 / 网格（none = 子节点回归锚点定位）
    this.list.layoutMode = "vertical";
    this.list.padding = { left: 0.5, right: 0.5, top: 0.3, bottom: 0.3 } as UIPadding;
    this.list.spacing = { x: 0.2, y: 0.3 } as UIVec2; // 子元素间距（UI 单位）
    this.list.gridColumns = 2;                          // 仅 grid 模式

    // 布局槽位矩形可查询（布局解析后的实际位置）
    void engine.ui.rectOf(this.list);
  }
}
```

网格背包（grid 模式，行数由子元素数量推导）：

```ts tve
import { Component, property, UILayoutNode, UITextNode, engine } from "tve";

export default class Inventory extends Component {
  @property({ type: UILayoutNode, label: "背包网格" })
  grid: UILayoutNode | null = null;

  onStart() {
    if (!this.grid) return;
    this.grid.layoutMode = "grid";
    this.grid.gridColumns = 5;
    this.grid.spacing = { x: 0.15, y: 0.15 };
    // 直接子 UI 节点自动入槽（大小可再经 size 微调）
    void this.grid.children.filter((c) => c instanceof UITextNode).length;
  }
}
```
