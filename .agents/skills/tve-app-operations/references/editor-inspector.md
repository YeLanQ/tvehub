# 单元：检查器各分区操作

检查器（InspectorPanel.vue）按选中对象切换模式：场景节点 → Transform + 组件卡
（ComponentCard 折叠分区）；资产 → 资产检查器（AssetTypeIcon + 资产字段分区）。
13 个 useInspector* 组合函数 = 13 个分区的逻辑（清单见 `tve-api-usage`
references/composables.md）。编辑均走 commit → 节点补丁进撤销。

## 操作面：分区速查

| 分区 | 用户能做什么 | 要点 |
|---|---|---|
| Transform | 位置/旋转(度)/缩放九字段（NumberField 拖拽微调） | commit 一次一步撤销 |
| Mesh | 几何切换（基元）、模型路径、材质覆盖表 | 几何注册表驱动 |
| Material（节点/资产） | 挂载着色器下拉、渲染分支全参数（PBR/Unlit/Toon 数据驱动）、着色器 Properties 暴露参数、贴图槽（无/内置/项目三组） | 内置材质只读须先「复制到项目材质」；编辑即写引擎缓存 + 300ms 防抖写 .mat（useInspectorMaterial.ts:17） |
| Light/Audio | 灯光类型/颜色/强度/阴影档位（off·hard·soft/分辨率）；音源资产/循环/空间化 2d·3d | 阴影档位 shadowType 优先于单字段 |
| Camera/Sky | 透视/正交、裁剪面、FOV；天空盒程序化/立方贴图、三段配色 | |
| Fog | 线性/Exp2/高度雾参数 | 首个启用且可见的雾节点生效 |
| Physics | 刚体形态 static/kinematic/dynamic、重力缩放；碰撞体形状/摩擦/弹性/传感器 | 前提：项目设置启用物理 |
| Particles | 全量发射参数（duration/lifetime/shape/blending/texture…） | maxParticles/blending 改动重建发射器 |
| Nav | 导航区域/代理绑定与参数 | |
| Logic | FSM/BT 资产绑定、速度；「打开编辑器」进逻辑编辑弹层 | 图见 graph-nodes.md |
| UI（Canvas/Widget） | 画布设计尺寸/缩放模式/排序；Widget 锚点/尺寸/文本富文本/按钮交互 | 布局视图（layout）编辑 |
| Animation（节点） | 动画剪辑组件绑定、播放控制、「在动画编辑器中打开」 | 见 editor-animation.md |
| Terrain | 地形资产绑定/程序化设置/生成 Splatmap/地形材质绑定 | 见 editor-terrain.md |
| 资产 .shader | Base 渲染分支/Hook 钩子清单/Properties 属性表/解析错误展示；「编辑源码」开 Monaco 弹层（Ctrl+S 保存即后端解析校验，错误不阻断保存）；旧版着色器「一键迁移补 Base」 | 效果原型从工坊 effect 分类套用（叠加 Hook） |

## 规则/要点

- 组件的增删在节点「添加组件」入口（脚本组件出现在此处 + 层级添加子菜单）。
- @property 脚本属性卡由 scriptsStore 的 props schema 驱动，保存脚本后 schemaRev
  递增自动刷新控件（script-compile/meta.ts 解析）。
- 材质参数编辑直接生效于视口（引擎缓存先行，防抖落盘），面板卸载 flush 未写盘改动。

## 测试例

- 检查器分区组件无 spec；其依赖的 **parse 收敛函数有真实 spec**（14 个）：
  `src/framework/{audio,camera,fog,lighting,logic,mesh,particles,terrain}/**.spec.ts`
  ——数值钳制/枚举回退/克隆签名，正是检查器写入边的契约。
- 材质读写 IPC：`src/app/lib/materials.ts:20/:51`（调用点）。
