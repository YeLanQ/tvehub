# UI（脚本 API）

UI 系统的脚本 API：五个节点类 + `engine.ui` 运行期控制。编辑器侧的画布/锚点/布局概念见[编辑器 UI 文档](../editor/ui.md)，本文只列脚本可用的字段与方法。

- 节点类均为 `Entity` 子类，`kind` 对应编辑器节点类型（`uiCanvasNode` / `uiImageNode` / `uiTextNode` / `uiButtonNode` / `uiLayoutNode`），可作 `@property({ type })` 的**场景节点引用**类型，也可经 `engine.scene.find` 查找；
- 单位与锚点语义与编辑器一致：尺寸/位置/边距为 **UI 单位（100px = 1 单位）**、y 向上，锚点/枢轴为 **0..1 归一化**；
- 运行态属性写入**即时生效，不回写场景文件**（与粒子/音频等组件门面同一约定）。

## Widget 公有字段

图片/文本/按钮/布局容器都实现 `UIWidgetBase`（叠加序 + 矩形 + 锚点）：

```ts
interface UIWidgetBase {
  sortOrder: number;            // 画布内叠加序（大者在上；点击命中也取最上层）
  size: { x: number; y: number };       // 矩形尺寸（UI 单位；拉伸锚点轴由父矩形与边距推导）
  anchorMin: UIVec2;            // 归一化锚点下限（父矩形 0..1；某轴 min==max 为点锚点）
  anchorMax: UIVec2;            // 归一化锚点上限（min<max 该轴拉伸）
  pivot: UIVec2;                // 归一化枢轴（自身 0..1）
  anchoredPosition: UIVec2;     // 点锚点轴：枢轴相对锚点的偏移（UI 单位）
  offsetMin: UIVec2;            // 拉伸轴边距：左/下（UI 单位）
  offsetMax: UIVec2;            // 拉伸轴边距：右/上（UI 单位）
}
```

## 画布：UICanvasNode

```ts
canvas.sortOrder;      // 画布整体排序（多画布叠加大者在上，优先于 Widget sortOrder）
canvas.designWidth;    // 设计宽度（设计像素；100px = 1 UI 单位）
canvas.designHeight;   // 设计高度（设计像素）
canvas.scaleMode;      // 屏幕适配方案（仅预览/构建运行时生效；编辑器布局视图恒 1:1）
```

`scaleMode` 取值：`"noscale"` 不缩放 / `"fixedwidth"` 固定宽度 / `"fixedheight"` 固定高度 / `"fixedauto"` 固定宽高比（cover 铺满裁切）/ `"full"` 等比包含（contain 完整显示）。

## 图片：UIImageNode

```ts
img.image;   // 图片资产相对路径（空串 = 纯色矩形；运行态异步加载后热替换）
img.color;   // 着色 0xRRGGBB（与图片相乘）
```

## 文本：UITextNode

```ts
txt.text;        // 文本内容（\n 分行；超界自动换行）
txt.fontSize;    // 字号（设计像素，100px = 1 单位）
txt.color;       // 文本颜色 0xRRGGBB
txt.bold;        // 粗体
txt.italic;      // 斜体
txt.fontFamily;  // "system" | "serif" | "mono"
txt.align;       // "left" | "center" | "right"（水平对齐）
```

## 按钮：UIButtonNode

```ts
btn.image;          // 背景图片资产相对路径（空串 = 纯色背景）
btn.color;          // 背景着色 0xRRGGBB
btn.label;          // 标签文本
btn.labelColor;     // 标签颜色 0xRRGGBB
btn.fontSize;       // 标签字号（设计像素）
btn.labelBold;      // 标签粗体
btn.interactable;   // 可交互（false 时仅展示，不参与点击命中）
```

## 布局容器：UILayoutNode

```ts
layout.layoutMode;    // "none" 不排列 | "horizontal" 横向 | "vertical" 竖向 | "grid" 网格
layout.padding;       // 内容区内边距 { left, right, top, bottom }（UI 单位）
layout.spacing;       // 子元素间距 { x, y }（UI 单位）
layout.gridColumns;   // 网格列数（grid 模式；行数由子元素数量推导）
```

布局容器接管直接子节点的位置（子元素 `anchoredPosition` 被忽略，槽位内居中）；`layoutMode = "none"` 时子节点回归锚点定位。

## engine.ui

运行期控制（按实体寻址；非 UI 节点的 `get` 返回 `null`）：

```ts
engine.ui.set(entity, { text: "New", color: 0x66ccff }); // 合并 Widget/画布设置（子集；运行态生效）
engine.ui.get(entity);        // 当前设置快照（画布/Widget 按类型返回各自字段集）
engine.ui.onClick(entity, cb); // 订阅按钮点击（仅 uiButtonNode 且 interactable；返回解绑函数）
engine.ui.offClick(entity, cb); // 解除点击订阅
```

- `set` 只需传要改的字段（子集合并），字段名与上表一致；
- `onClick` 的回调在点击命中该按钮时触发（按渲染序取最上层可交互按钮）；请在 `onDisable`/`onDestroy` 中调用返回的解绑函数（或 `offClick`）以免悬挂。

## 示例：开始界面按钮 + 计分文本

```ts
import { Component, property, engine } from "tve";

export default class MainMenu extends Component {
  @property({ type: UIButtonNode, label: "开始按钮" })
  startBtn: UIButtonNode | null = null;

  @property({ type: UITextNode, label: "分数文本" })
  scoreText: UITextNode | null = null;

  private score = 0;
  private unbind?: () => void;

  onStart() {
    if (this.startBtn) {
      this.startBtn.label = "开始游戏";
      this.unbind = engine.ui.onClick(this.startBtn, () => {
        engine.log("开始！");
      });
    }
  }

  addScore(delta: number) {
    this.score += delta;
    if (this.scoreText) {
      // 运行态写 text 即时生效（不回写场景文件）
      this.scoreText.text = `SCORE ${this.score}`;
      this.scoreText.color = delta > 0 ? 0x66ff66 : 0xff6666;
    }
  }

  onDisable() {
    this.unbind?.();   // 解绑按钮点击订阅
  }
}
```

渲染/适配行为（缩放模式、排序、锚点解析）由引擎每帧接管，脚本只关心字段值；参见[编辑器 UI 文档](../editor/ui.md)。
