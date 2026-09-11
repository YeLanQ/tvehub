# 检查器与组件

右侧停靠区的「属性」（检查器）面板编辑选中节点/资产。多选节点时显示多重编辑视图（公共变换统一设置）。面板由若干组件卡片组成，卡片可折叠；顶部⋮菜单支持 上移/下移（执行顺序）、重置、移除等操作，卡片标题栏带启用/停用开关。

## 节点通用卡片

| 卡片 | 内容 |
| --- | --- |
| Node | 名称、层（渲染层级单选）、标签（项目标签下拉，内置 Untagged；脚本按标签查找）、可见；预制体实例显示来源资产 |
| Transform | 本地 位置/旋转/缩放（旋转为度制欧拉角） |

## 网格节点（meshNode）

| 卡片 | 内容 |
| --- | --- |
| Mesh | 基元网格：几何类型与参数（基元为 box/sphere/plane/cylinder/cone/torus/capsule）；模型网格：模型资产引用 |
| Material | 材质资产选择 + 着色器切换（PBR/Unlit/卡通）+ 参数编辑（内置材质只读，可复制为项目材质后编辑）；着色器的 Properties 参数一并呈现 |

## 灯光节点

Light 卡片：灯光类型（点光/平行光/聚光/环境光，切换即重建）、颜色、强度、Culling Mask（只照亮掩码内层的对象）、照射距离、衰减指数、聚光半角与边缘柔和度。点光/平行光/聚光灯另有 **Shadow 类型下拉**：`Off`（无阴影，下方参数禁用）/ `Hard`（硬阴影）/ `Soft`（柔和阴影），以及阴影参数组 Strength（浓度）、Bias（深度偏移）、Normal Bias（法线偏移，0 = 自动）、Near Plane（近裁剪面）、Resolution（阴影贴图分辨率，Auto = 平行光/聚光灯 2048、点光 1024，可选 512~4096）；三种灯各自的阴影实现见「场景编辑 › 阴影」。

## 相机节点

| 项 | 说明 |
| --- | --- |
| 相机类型 | 透视（fov 取景）/ 正交（orthoSize 取景）；切换保留另一类型的参数 |
| Culling Mask | 只渲染掩码内层的对象；编辑器自由视角恒全层可见，预览激活该相机（或运行时）生效。逐层勾选，含 Everything / Nothing 快捷档 |
| 清除标志 | 天空盒 / 纯色 / 仅深度 / 仅颜色；纯色时可选背景色 |
| 视场角 fov | 1–170 度（透视） |
| 正交半高 orthoSize | 取景高度的一半，世界单位（正交） |
| 近/远裁剪面 | near ≥ 0.01、far ≥ 1 |

## 天空盒节点

类型（程序化天空 / 立方体）、材质资产选择（内置材质 + 项目材质）、复制为项目材质。

## 音频节点

Audio 卡片：音频资产引用、自动播放、循环、音量、倍速、空间化（2d/3d）。

## 粒子系统节点

Particle System 卡片（常规粒子系统语义子集；每项改动一次撤销，实时生效不打断已存活粒子）：

| 分组 | 字段 |
| --- | --- |
| 运行时控制 | ▶ 播放（暂停态续播 / 播完态重播）、⏸ 暂停、⏹ 停止发射（粒子自然消亡）、↻ 重启（清空并从头开始）；状态文案显示存活粒子数。**不落盘** |
| Main | Duration（发射周期）、Looping、Prewarm（仅循环）、Start Delay、Start Lifetime、Start Speed、Start Size、Start Color、Gravity（重力系数，1 = 9.81；负值上浮）、Simulation Space（Local / World）、Max Particles |
| Emission | Rate over Time（粒子/秒） |
| Shape | Shape（Cone / Sphere / Hemisphere / Box）、Radius、Angle（圆锥半角，仅 Cone） |
| Color over Lifetime | Enabled、End Color |
| Size over Lifetime | Enabled |
| Renderer | Blending（Additive / Normal）、Texture（内置软圆点 / 内置图片 / 项目图片；贴图 RGB 与 Start/End Color 相乘、alpha 相乘，白底透明 PNG 即着色精灵；缺失回退软圆点，资产被删时回显路径并标「未找到」） |

`Max Particles` 与 `Blending` 属于结构参数，改动会重建发射器（粒子从头开始）；其余参数原地更新，换贴图异步加载完成后热替换。切换 Simulation Space 会清空当前粒子。

## 添加组件

检查器底部「添加组件」菜单按分类列出（多实例约束：同一节点不可重复挂载的项会禁用）：

| 分类 | 组件 | 多实例 |
| --- | --- | --- |
| 物理 | 刚体 Rigid Body | 否 |
| 物理 | 碰撞体 Collider | 是 |
| 光照 | 灯光 Light | 否 |
| 音频 | 音源 Audio Source | 是 |
| 动画 | 动画剪辑 Animation Clip | 是 |
| 脚本 | 脚本 Script（选择/新建 `src/` 下脚本） | 是 |

## 物理

挂了刚体/碰撞体的节点显示 **Physics 模拟控制卡片**：▶ 开始模拟（快照变换，动力学体开始受力）/ ⏸ 暂停 / ⏹ 停止（销毁世界并还原变换）；显示绑定/世界就绪状态。引擎/重力/启用开关在 项目设置 → 物理。无刚体的碰撞体 = 静态碰撞体；运动学体由节点变换/动画驱动。

### 刚体 Rigid Body

| 设置 | 说明 | 默认 |
| --- | --- | --- |
| 形态 mode | static（静态）/ kinematic（运动学）/ dynamic（动力学） | dynamic |
| 质量 mass | kg，仅 dynamic 有效（>0） | 1 |
| 线性/角阻尼 | linearDamping / angularDamping | 0.05 |
| 重力缩放 | gravityScale，0 = 不受重力 | 1 |
| 连续碰撞检测 ccd | 高速物体防穿透 | 关 |
| 锁定旋转 lockRotation | 碰撞不改变姿态（全冻结），防撞倒 | 关 |
| 直立不倒 upright | 碰撞不翻倒但保留水平旋转（角色类）；与锁定旋转互斥，勾任一自动清另一 | 关 |

### 碰撞体 Collider（可挂多个）

| 设置 | 说明 | 默认 |
| --- | --- | --- |
| 形状 shape | box / sphere / capsule / cylinder / convex | box |
| 尺寸来源 autoSize | 开 = 按节点渲染包围盒自动推导；关 = 用显式尺寸 | 开 |
| 显式尺寸 size | box = xyz 边长；sphere 直径取 x；capsule/cylinder 直径取 x、柱高取 y | 1,1,1 |
| 偏移 offset | 相对节点原点的局部偏移 | 0,0,0 |
| 摩擦系数 friction | 0 = 无摩擦 | 0.6 |
| 弹性系数 restitution | 0 = 不反弹 | 0.1 |
| 传感器 isSensor | 只产生触发（onCollisionEnter/Exit）不产生碰撞响应 | 关 |

> 角色类节点建议：刚体摩擦为 0（滑动摩擦力矩会导致自转）＋ 直立不倒或锁定旋转。

## 动画

- 模型网格节点显示 **Animation** 卡片（骨骼动画）：剪辑选择、自动播放、倍速、循环模式，以及**动画图**（状态机）编辑——状态（名称 + 绑定剪辑 + 速度/循环）、过渡（from → to + 淡化时长 + 归一化退出时间 + 参数条件）、参数（数值/布尔，改值即时触发过渡）、运行时可查看当前状态并手动切换；
- 任意节点可挂 **动画剪辑 Animation Clip** 组件（绑定 `.anim` 资产）：剪辑、自动播放、循环、倍速；关键帧制作见[动画编辑器](animation.md)。

## 脚本组件

挂载 `src/` 下脚本后，卡片按脚本 `@property` 声明渲染属性控件（number/string/boolean/color/vec3、节点引用下拉、min/max/step），支持启用/停用与执行顺序调整；「编辑脚本」跳转脚本工作台。节点引用属性按声明类型过滤可选场景节点。
