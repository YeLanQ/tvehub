# tve 文档

tve（three-visual-editor）内置 3D 场景编辑器与脚本 SDK 的用户文档。

## 编辑器文档

| 文档 | 内容 |
| --- | --- |
| [编辑器总览](editor/overview.md) | 工作区布局、视图模式、快捷键 |
| [项目管理](editor/projects.md) | 首页、新建/打开项目、模板、偏好设置 |
| [场景编辑](editor/scene.md) | 层级面板、视口操作、节点系统 |
| [UI 系统](editor/ui.md) | UI 画布与 Widget、锚点布局、文本/图片/按钮/布局容器、缩放适配 |
| [检查器与组件](editor/inspector.md) | 变换、网格、灯光、相机、物理、音频、动画等组件编辑 |
| [资产系统](editor/assets.md) | 资产面板、导入、资产类型、预制体、材质与着色器 |
| [着色器与自定义效果](editor/shaders.md) | .shader 效果着色器：Base 分支、Hook 钩子、Properties 参数、挂载与回退 |
| [动画编辑器](editor/animation.md) | 关键帧动画剪辑、曲线编辑、动画图（状态机） |
| [脚本工作台](editor/scripting.md) | 脚本编写、编译、绑定节点、脚本属性 |
| [预览与构建](editor/preview-build.md) | 网页预览、构建导出渠道与配置 |

## SDK 文档（脚本 API）

脚本以 `import { ... } from "tve"` 使用全部能力，类型契约见编辑器内 `src/framework/scripting/tve.d.ts`（Monaco 智能提示直接可用）。SDK 不暴露任何底层渲染接口，全部为引擎自有类型。

| 文档 | 内容 |
| --- | --- |
| [SDK 总览](sdk/overview.md) | 快速上手、组件生命周期、执行顺序、错误隔离 |
| [装饰器](sdk/decorators.md) | `@property` 属性声明、`@nodeType` 脚本节点 |
| [实体与查询](sdk/entity.md) | `Entity`、节点类型引用、场景/组件查找 |
| [UI](sdk/ui.md) | UI 画布与 Widget 节点类、`engine.ui`、按钮点击订阅 |
| [engine 入口](sdk/engine.md) | 时间、输入、场景、动画、音频、物理、UI、日志 |
| [内置组件门面](sdk/components.md) | 刚体、碰撞体、灯光、音源、动画剪辑、骨骼动画 |
| [数学库 math](sdk/math.md) | 向量运算纯函数集 |
| [补间动画 tween](sdk/tween.md) | `tween` 工厂、缓动函数、delay/loop/yoyo、序列/并行组 |
| [通用设施](sdk/utils.md) | `Delegate` 委托、`Pool` 对象池、`DataCenter` 数据中心 |
