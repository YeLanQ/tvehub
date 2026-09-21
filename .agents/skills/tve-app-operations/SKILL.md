---
name: tve-app-operations
description: TvE Hub 应用操作手册：项目编辑器（视口/层级/资产/检查器/动画/着色器/地形绘制/预览/构建/项目设置）、图窗口（节点图）与白板的全部用户操作——命令 id 全清单、快捷键、面板流程、交互规则。凡用户问"怎么在编辑器/图窗口/白板里做某事"、要写操作教程、或经 devtools/MCP 远程驱动编辑器，一律先查本技能。
---

# 应用操作手册（编辑器 / 图窗口 / 白板）

三个窗口三种心智：**编辑器**改场景权威状态（Rust 持会话，操作进撤销历史）、
**图窗口**编辑"预览时执行的行为定义"（不回写场景）、**白板**是完全独立的 SVG 文档
（全局目录，不随项目）。

## 操作的规范名 = 命令 id

编辑器全部用户操作收敛在命令注册表（`src/app/commands/`）：UI（工具栏/快捷键/
右键）与 devtools/MCP 走**同一执行器**。要让程序驱动编辑器 → 用命令 id +
`dispatchCommand`（不抛）/`runCommand`（异常语义）；派发机制见 `tve-api-usage`
技能 references/commands-registry.md，33 条命令全清单见本技能
references/editor-commands.md。

## 路由表

| 要做的事 | 读 |
|---|---|
| 查某操作对应的命令/参数（或远程驱动） | references/editor-commands.md |
| 视图模式、视口与层级面板操作 | references/editor-viewport.md |
| 资产面板：导入/新建/移动/右键菜单/只读保护 | references/editor-assets.md |
| 检查器各分区（材质/着色器/物理/粒子/UI…） | references/editor-inspector.md |
| 动画编辑器（轨道/K 帧/曲线/录制） | references/editor-animation.md |
| 地形程序化设置 + 地形绘制模式 | references/editor-terrain.md |
| 预览、构建导出、项目设置、首页、局域网共享 | references/editor-preview-build.md |
| 图窗口：打开/画布交互/试跑 | references/graph-usage.md |
| 图节点类型全集/图变量/自定义节点/保存机制 | references/graph-nodes.md |
| 白板：工具/图层/文本/快捷键 | references/whiteboard-usage.md |
| 白板：文件管理/改名防覆盖/放映/共享发布 | references/whiteboard-files.md |

每单元三段：**操作面**（动作 → 入口/命令，含 文件:行号）→ **规则/要点** →
**测试例**（对应 spec/smoke 或推荐写法）。

## 三窗口速记

| | 编辑器（index.html） | 图窗口（graph.html） | 白板（whiteboard.html） |
|---|---|---|---|
| 打开 | 首页项目卡片 | 首页卡片右键「打开场景图」 | 首页白板分区 |
| 数据 | 场景会话（后端权威，scene:changed 广播） | 场景会话共享 + `graph/<场景>.graph` 侧车 | 全局白板目录 .svg（不随项目） |
| 撤销 | 后端历史（Ctrl+Z） | 画布快照栈 100 条（Ctrl+Z） | 快照栈 100 条（Ctrl+Z） |
| 保存 | 手动 Ctrl+S | 600ms 防抖自动保存 | 手动 Ctrl+S |

## 姊妹技能

命令派发机制与 IPC：`tve-api-usage`；脚本/图逻辑怎么写：`tve-sdk-scripting`、
`tve-engine-interfaces`（graph-logic.md）；测试规范：`tve-unit-testing`。
