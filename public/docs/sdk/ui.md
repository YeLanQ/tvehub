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

锚点解析规则（与编辑器同一套数学）：

- **点锚点轴**（min == max）：矩形由 `anchoredPosition`（枢轴相对锚点的偏移）与 `size` 决定；
- **拉伸轴**（min < max）：矩形 = 父矩形上两锚线之间收进 `offsetMin`（左/下）与 `offsetMax`（右/上）——尺寸由父矩形与边距推导，**写 `size` 不生效**；屏幕适配时随父矩形自动拉伸；
- 枢轴 `pivot` 是点锚点定位与旋转的基准（0.5,0.5 = 中心）。

```ts
// 居中血条：点锚点 + 中心枢轴，血量变化只改 size
const bar = engine.scene.find("UI/HealthBar") as UIImageNode;
bar.anchorMin = { x: 0.5, y: 0.5 }; bar.anchorMax = { x: 0.5, y: 0.5 };
bar.pivot = { x: 0, y: 0.5 };          // 左边缘为基准 → 缩短时右端收缩
bar.size = { x: 8 * hp / maxHp, y: 0.4 };

// 全屏底板：双向拉伸锚点 + 零边距 → 自动铺满任意屏幕
panel.anchorMin = { x: 0, y: 0 }; panel.anchorMax = { x: 1, y: 1 };
panel.offsetMin = { x: 0, y: 0 }; panel.offsetMax = { x: 0, y: 0 };
```

## 画布：UICanvasNode

```ts
canvas.sortOrder;      // 画布整体排序（多画布叠加大者在上，优先于 Widget sortOrder；-500..500）
canvas.designWidth;    // 设计宽度（设计像素；100px = 1 UI 单位；1..16384）
canvas.designHeight;   // 设计高度（设计像素）
canvas.scaleMode;      // 屏幕适配方案（仅预览/构建运行时生效；编辑器布局视图恒 1:1）
```

`scaleMode` 取值与数学（screen = 运行窗口的满视野矩形，宽高比随窗口变化）：

| 值 | 缩放系数 | 效果 |
| --- | --- | --- |
| `"noscale"` | (1, 1) | 画布按设计尺寸原样显示，不随屏幕缩放 |
| `"fixedwidth"` | screenW / 设计宽 | 固定宽度等比缩放（高度随屏幕比例变化） |
| `"fixedheight"` | screenH / 设计高 | 固定高度等比缩放（宽度随屏幕比例变化） |
| `"fixedauto"` | max(W/cw, H/ch) | 等比铺满（cover）：铺满屏幕，超出部分裁切 |
| `"full"` | min(W/cw, H/ch) | 等比包含（contain）：完整显示不裁切，可能有留白 |

## 图片：UIImageNode

```ts
img.image;   // 图片资产相对路径（空串 = 纯色矩形；运行态异步加载后热替换）
img.color;   // 着色 0xRRGGBB（与图片相乘；白图 × 颜色 = 染色）
```

## 文本：UITextNode

```ts
txt.text;        // 文本内容（\n 分行；超界自动换行，逐字符断行对中文友好）
txt.fontSize;    // 字号（设计像素，100px = 1 单位；约 4..512）
txt.color;       // 文本颜色 0xRRGGBB
txt.bold;        // 粗体
txt.italic;      // 斜体
txt.fontFamily;  // "system" | "serif" | "mono"
txt.align;       // "left" | "center" | "right"（相对文本框的水平对齐；垂直恒居中）
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

点击命中的运行时规则：按下/抬起指针位移 ≤ 5px 才算点击；命中测试在画布空间做矩形判定（`|x| ≤ size.x/2 && |y| ≤ size.y/2`），候选按钮按渲染序**降序**取第一个命中的可交互按钮——与视觉层级一致（最上层先收到）。

## 布局容器：UILayoutNode

```ts
layout.layoutMode;    // "none" 不排列 | "horizontal" 横向 | "vertical" 竖向 | "grid" 网格
layout.padding;       // 内容区内边距 { left, right, top, bottom }（UI 单位）
layout.spacing;       // 子元素间距 { x, y }（UI 单位）
layout.gridColumns;   // 网格列数（grid 模式；行数由子元素数量推导）
```

布局容器接管直接子节点的位置（子元素 `anchoredPosition` 被忽略，槽位内居中）；`layoutMode = "none"` 时子节点回归锚点定位。排列规则：

- `horizontal`：从内容区左缘向右排，槽内垂直居中；`vertical`：从内容区顶缘向下排，槽内水平居中；
- `grid`：格子尺寸 = 子元素最大宽高，从左上角按行排（列数 = `gridColumns`，行数自动）；
- padding / spacing 逐项生效（下限 0）；
- 容器自身是「无形 Widget」：有尺寸/锚点/SortOrder（可被父布局排列）但无渲染内容；可嵌套。

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

## engine.ui 布局与坐标查询

把屏幕像素坐标与 UI 节点的实际渲染矩形暴露给脚本——虚拟摇杆、点击区域判定、跟随指针的 UI 等交互的基础。三个接口共用同一空间约定：**画布局部空间，原点 = 画布中心，y 向上，单位 = UI 单位**（与锚点系统一致）。

```ts
// ① 解析矩形：锚点/拉伸/布局容器解析后的实际渲染矩形
const rect = engine.ui.rectOf(joyBase);
// rect = { cx, cy, w, h }（画布局部空间；非 UI 节点/未就绪返回 null）

// ② 屏幕度量：px ↔ UI 单位换算（随窗口与缩放模式变化，建议每帧读取）
const m = engine.ui.metricsOf(joyBase);
// m = { width, height,                    // 渲染画布 CSS 尺寸（与 engine.input.pointer 同一空间）
//       rootWidth, rootHeight,            // 屏幕矩形在 UI 单位下的尺寸
//       pxPerUnitX, pxPerUnitY,           // 每单位像素数（= width/rootWidth …）
//       scaleMode, designWidth, designHeight }

// ③ 屏幕像素 → 画布局部 UI 坐标（可直接与 rectOf 结果做包含/距离判定）
const p = engine.ui.screenToUi(joyBase, engine.input.pointer.x, engine.input.pointer.y);
// p = { x, y }
```

典型用法——判断指针是否落在某个 Widget 内（虚拟摇杆抓取就是这一套）：

```ts
const rect = engine.ui.rectOf(btn);
const p = engine.ui.screenToUi(btn, engine.input.pointer.x, engine.input.pointer.y);
if (rect && p && Math.hypot(p.x - rect.cx, p.y - rect.cy) <= Math.min(rect.w, rect.h) / 2) {
  // 指针在按钮圆形范围内
}
```

说明：

- `rectOf` 对布局容器的直接子节点返回布局槽位矩形（`anchoredPosition` 不参与定位）；
- `rectOf`/`metricsOf` 定位画布的方式是沿父链向上找 `uiCanvasNode`，传任意 UI 子节点等价；
- 三个接口在非 UI 节点、不在画布子树内或首帧布局解析未完成时返回 `null`；
- `screenToUi` 的入参 x/y 与 `engine.input.pointer` 同一空间（画布内 CSS 像素），换算已含缩放模式的全部数学。

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

## 示例：虚拟摇杆（rectOf + screenToUi + deadZone）

多点触控下按 `pointerId` 认住占用摇杆的那根手指：其他手指的按下/抬起/移动互不干扰。

```ts
import { Component, property, math, engine, UIImageNode } from "tve";

export default class Joystick extends Component {
  @property({ type: UIImageNode }) base: UIImageNode | null = null;   // 摇杆底座
  @property({ type: UIImageNode }) knob: UIImageNode | null = null;   // 摇杆头
  @property({ min: 0 }) maxRadius = 1.2;                              // 摇杆行程（UI 单位）

  value = { x: 0, y: 0 };           // 归一化输出（-1..1），其他组件读取
  private grabbing = false;
  private grabId = -1;              // 占住摇杆的触点 id（只认这一指）

  onStart() {
    engine.input.onPointerDown((p) => {
      if (this.grabbing) return;     // 已被某根手指占住
      const rect = this.base && engine.ui.rectOf(this.base);
      const pt = this.base && engine.ui.screenToUi(this.base, p.x, p.y);
      if (rect && pt && Math.hypot(pt.x - rect.cx, pt.y - rect.cy) <= rect.w / 2) {
        this.grabbing = true;        // 按在底座范围内才开始拖动
        this.grabId = p.pointerId;
      }
    });
    const release = () => {
      this.grabbing = false;
      this.grabId = -1;
      this.value = { x: 0, y: 0 };
      if (this.knob && this.base) {
        const rect = engine.ui.rectOf(this.base);
        if (rect) this.knob.anchoredPosition = { x: 0, y: 0 };  // 回中
      }
    };
    // up 与 cancel 都要订阅（系统抢占后不会再来 up）；按 id 匹配，其他手指抬起不误释放
    engine.input.onPointerUp((p) => { if (p.pointerId === this.grabId) release(); });
    engine.input.onPointerCancel((p) => { if (p.pointerId === this.grabId) release(); });
  }

  onUpdate() {
    if (!this.grabbing || !this.knob || !this.base) return;
    const p = engine.input.getPointer(this.grabId);   // 只跟随占用摇杆的那根手指
    if (!p) return;
    const rect = engine.ui.rectOf(this.base);
    const pt = engine.ui.screenToUi(this.base, p.x, p.y);
    if (!rect || !pt) return;
    let dx = pt.x - rect.cx, dy = pt.y - rect.cy;
    const len = Math.hypot(dx, dy) || 1;
    if (len > this.maxRadius) { dx = (dx / len) * this.maxRadius; dy = (dy / len) * this.maxRadius; }
    this.knob.anchoredPosition = { x: dx, y: dy };                     // 摇杆头跟随（钳在行程内）
    this.value = {
      x: math.deadZone(dx / this.maxRadius, 0.12),                     // 死区滤抖
      y: math.deadZone(dy / this.maxRadius, 0.12),
    };
  }
}
```

渲染/适配行为（缩放模式、排序、锚点解析）由引擎每帧接管，脚本只关心字段值；参见[编辑器 UI 文档](../editor/ui.md)。
