# 单元：白板 —— 工具 / 图层 / 文本 / 快捷键

## 操作面：打开与画布

- 入口：首页「白板」分区（新建 / 打开指定文件）；全局单例窗口，不随项目。
- 视图：**滚轮以光标为锚缩放**（0.05–20）、**空格/中键拖拽平移**、「适应画板
  取景」按钮（WhiteboardStage.vue:90）——无独立缩放工具按钮。
- 画板尺寸：标题栏下拉（预设与项目「设计分辨率」同源 + 自定义 1–8192）。

## 操作面：工具（底部浮动条 TOOLS，WhiteboardApp.vue:151）

| 工具 | 键 | 操作 |
|---|---|---|
| 选择/移动 | V | 点选/框选、拖移动、控制柄缩放 |
| 矩形 / 椭圆 / 直线 | R / O / L | 拖拽绘制 |
| 铅笔（自由笔） | P | 按住绘制 |
| 钢笔 | B | 单击=直角点、拖拽=曲线点；Enter 结束开放路径、双击闭合、Esc 取消 |
| 文本 | T | 点击落点，属性面板输入（富文本语法见下） |

- 线条粗细滑动条 1–24px（直线/铅笔/钢笔时显示）。
- **无橡皮工具**：删除 = 选中后 Delete（曲线选中锚点时优先删锚点）。
- 颜色/填充在右侧**属性面板**（填充/描边色、无填充勾选、**图片填充**：data URL
  + cover/contain/stretch/tile 适配）。
- 撤销/重做：Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y（快照栈上限 100；连续编辑折叠为一条）。

## 操作面：图层

右侧面板「图层」页签：新建/删除/重命名/可见性/锁定/不透明度/拖拽排序；
元素经 layerId 归属，数组顺序即绘制序（svg-doc.ts:124）。

## 操作面：文本富文本语法

内容即语法源：`[b]粗[/b]` 风格标签 **`[b] [i] [u] [color=#hex]`**、`\[` 转义
（svg-doc.ts:281）；渲染/导出为嵌套 tspan。

## 操作面：快捷键全集（WhiteboardApp.vue:239）

`V R O L P B T` 工具切换；`Delete/Backspace` 删除；`Ctrl+Z / Ctrl+Shift+Z /
Ctrl+Y` 撤销重做；`Ctrl+S` 保存；`Enter/Esc` 钢笔路径；放映中 `← → PageUp
PageDown Esc` 翻页退出。

## 规则/要点

- 元素类型仅 6 种：rect/ellipse/line/pencil/path/text（SvgElKind）——图片不是
  独立元素而是形状的**图片填充**；动画挂元素上（motion/opacity/fill 三种，
  导出为内嵌 @keyframes）。
- 文档模型 `SvgDoc {w,h,layers,els}`；序列化 = 自包含 .svg + 完整模型 JSON 存
  根节点 `data-tve-doc` 属性（无损回读）；外部 SVG 导入走 DOM 兜底
  （渐变/图案填充降级）。

## 测试例

- svg-doc 无 spec——**序列化往返是无损回读的契约**，推荐补测（正常/边界/异常/
  空值四类）：`src/whiteboard-window/svg-doc.spec.ts`（serializeDoc→parseSvg
  往返、外部 SVG 兜底、`sanitizeDoc` 旧版富文本迁移）。
- IPC 契约：`tve-api-usage` facade-windows.md（whiteboard_list/read/write/delete）。
