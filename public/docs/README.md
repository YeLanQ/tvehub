# tve 文档

tve（three-visual-editor）内置 3D 场景编辑器与脚本 SDK 的用户文档。

## 阅读指引

- **第一次使用**：按 [编辑器总览](editor/overview.md) → [项目管理](editor/projects.md) → [场景编辑](editor/scene.md) 的顺序读，即可完成「建项目 → 搭场景 → 预览」的最小闭环；
- **做 UI**：[UI 系统](editor/ui.md)（编辑器侧）+ [SDK UI](sdk/ui.md)（脚本侧）；
- **做动画**：[动画编辑器](editor/animation.md)（关键帧）+ [内置组件门面](sdk/components.md)（骨骼动画/动画图）；
- **写脚本**：从 [SDK 总览](sdk/overview.md) 入门，[装饰器](sdk/decorators.md) 声明属性，[engine 入口](sdk/engine.md) 查全量 API；
- **自定义效果**：[着色器与自定义效果](editor/shaders.md)；
- **发布**：[预览与构建](editor/preview-build.md)。

## 约定

- 文中「预览」指工具栏预览页签，「产物」指构建导出的网页；两者运行同一套网页运行时；
- 所有单位约定：位置/缩放 = 米，旋转 = 度，UI = 100 设计像素（1 UI 单位）、y 向上，前向 = -Z；
- 运行期脚本写入（变换除外）均为运行态生效、不回写场景文件；编辑器内编辑则随场景保存并可撤销。

## 编辑器文档

| 文档 | 内容 |
| --- | --- |
| [编辑器总览](editor/overview.md) | 双窗口架构、停靠布局、工具栏、视图模式、快捷键、控制台、撤销 |
| [项目管理](editor/projects.md) | 首页、新建/打开项目、目录结构、项目设置四页、创意工坊、开发者服务 |
| [场景编辑](editor/scene.md) | 层级面板、节点类型、视口、粒子系统、阴影、层与标签、场景文件格式 |
| [UI 系统](editor/ui.md) | UI 画布与 Widget、锚点布局、文本/图片/按钮/布局容器、缩放适配、布局配方 |
| [检查器与组件](editor/inspector.md) | 全部组件卡片字段、添加组件、物理、动画卡、脚本组件属性 |
| [资产系统](editor/assets.md) | 资产面板、导入、资产类型、材质参数全集、预制体 |
| [着色器与自定义效果](editor/shaders.md) | .shader 效果着色器：Base 分支、Hook 钩子、Properties 参数、示例拆解、后端差异 |
| [动画编辑器](editor/animation.md) | 关键帧动画剪辑、曲线编辑、录制、.anim 格式、动画图、骨骼调试 |
| [脚本工作台](editor/scripting.md) | 脚本编写、编译、绑定节点、智能提示、调试 |
| [预览与构建](editor/preview-build.md) | 网页预览、设备仿真、构建导出渠道与配置、发布模式、CDN |

## SDK 文档（脚本 API）

脚本以 `import { ... } from "tve"` 使用全部能力，类型契约见编辑器内 `src/framework/scripting/tve.d.ts`（Monaco 智能提示直接可用）。SDK 不暴露任何底层渲染接口，全部为引擎自有类型。

| 文档 | 内容 |
| --- | --- |
| [SDK 总览](sdk/overview.md) | 快速上手、生命周期详解、每帧调度顺序、执行顺序与错误隔离、约定速查 |
| [装饰器](sdk/decorators.md) | `@property` 属性声明（类型推断/节点引用/组件引用/自动挂载）、`@nodeType` 脚本节点、常见错误 |
| [实体与查询](sdk/entity.md) | `Entity` 全量属性与方法、快照语义、节点类型类、场景/组件查询、addComponent、落盘约定 |
| [UI](sdk/ui.md) | UI 画布与 Widget 节点类字段、`engine.ui`、按钮点击订阅、坐标换算、摇杆示例 |
| [engine 入口](sdk/engine.md) | 时间、输入、场景、动画、音频、粒子、物理、UI、补间、日志 |
| [内置组件门面](sdk/components.md) | 刚体、碰撞体、灯光、音源、动画剪辑、骨骼动画（混合/加法层/骨骼/形态键/IK/绑定） |
| [数学库 math](sdk/math.md) | 向量运算纯函数集、角度工具、常见配方速查 |
| [补间动画 tween](sdk/tween.md) | `tween` 工厂、链式配置、序列/并行组、31 个缓动、全局控制 |
| [通用设施](sdk/utils.md) | `Delegate` 委托、`Pool` 对象池、`DataCenter` 数据中心 |
