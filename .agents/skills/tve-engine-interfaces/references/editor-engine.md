# 单元：EditorEngine 门面（`src/framework/engine/EditorEngine.ts`）

## 契约

`class EditorEngine`（~970 行）——编辑器引擎聚合门面。按「挂载 / 模块编排 / 事件」
拆分后，门面只保留三类内容，实现体在 engine/ 下关切模块：

| 模块 | 职责 |
|---|---|
| `EditorEngine.ts` | 字段声明 + 构造器（12 子系统实例化与互相接线）+ 选择簿记 + 公共 API 薄委托 |
| `mount.ts` | mount/dispose 序列、initGizmo、后端材质策略、视口点选/布局导航/捕获拦截装配 |
| `events.ts` | handleGraphChange（图事件 → 各子系统差异化同步 + 天空/雾重算 + 资产预取）、视口点选、gizmo 拖拽回写、syncAudioComponents/syncPhysicsNode |
| `nodeOps.ts` | addXxx 创建族 + SCRIPT_NODE_BASE 表、删除/换父（UI 锚点补偿）、补丁/prefab 实例化/复制 |
| `assetRefresh.ts` | 贴图加载/失效、材质/着色器/模型刷新、装载期预取 |
| `skyEnv.ts` / `fogEnv.ts` | 天空背景（含 TextureCube/Nishita 链路与正交天空面）/ 渲染雾应用 |
| `previewView.ts` / `pipView.ts` | 预览相机/清除状态/辅助物显隐 / 画中画取景渲染 |
| `navSources.ts` | NavSystem providers（采样源/范围/障碍/目标 + 签名门控缓存） |
| `terrainPaint.ts` | 地形绘制/雕刻会话编排（begin/commit/invalidate） |
| `viewportQuery.ts` / `layoutNav.ts` | 视口查询与可选性判定 / 布局视口 2D 导航 |

跨模块共享的引擎字段不带 private（engine/ 内部接线面）；模块只 `import type`
门面类型，无运行时环。

门面成员（与拆分前公共 API 完全一致）：

| 成员 | 职责 |
|---|---|
| `factory: NodeFactory` | 节点工厂（默认注册表） |
| `graph: SceneClient` | 场景镜像（读 get/all，写走命令方法） |
| `events: EventBus<EditorEvents>` | 13 种事件：graph:changed、select:changed、gizmo:state、material/shader/model/animation/audio/physics/particles/logic:changed、shader:error、pip:state（画中画浮层状态） |
| `renderer: RendererManager` | 视口渲染策略层：设备创建/后端回退与渲染管线经 `src/engine` RHI/RPI 抽象（three 只进 `engine/*/backends`），帧率双档（活动期 Bresenham 数帧锁 60——`FrameRateLimiter`，60Hz 屏零回归、高刷屏锁 60；空闲降帧 markActivity/addActivityHook/viewportActive：交互与活动内容全速档，静止视口 12fps 省电）；阴影图按需重画（markShadowDirty：图变更/几何重建/活动内容才重画一次，静态场景免整套阴影 pass，DrawCall 约减半）；画中画（setPiPProvider：主渲染后按选中相机节点离屏 RT 渲染 + scissor 回贴右下角矩形，RPI 管线承担；见 modules/CameraPiP.ts） |
| `synchronizer: SceneSynchronizer` | 镜像 Node → three Object3D 同步 |
| `helperSystem / gizmo: GizmoController` | 辅助线 / 变换手柄 |
| `terrainPaint: TerrainPaintController` | 地形绘制笔刷（begin/endTerrainPaint） |
| `materials/shaders/models/animation/audio/particles/physics/nav/logic` | 各 System（缓存/解析/实例化） |

**节点创建方法族**：`addEmptyGroup / addMesh(geometryKind,parent) / addDataMesh(parent)
（source=data 数据化网格，载荷经检查器导入）/ addLight(kind,parent) /
addCamera / addSkybox / addAudio / addParticleSystem / addTerrain / addNavArea /
addNavAgent / addFsmRunner / addBtRunner / addFog / addUICanvas / addUIImage /
addUIText / addUIButton / addUILayout`。

**SCRIPT_NODE_BASE 表**（nodeOps.ts 顶部）：`Record<EditorNodeType, 创建函数>`——脚本
`@nodeType` 可创建类型 → 基础节点创建。用 Record 键穷举是刻意的：
**新增节点类型漏登记会直接编译报错**（旧字符串 switch 会静默建成空组）。

## 使用例

命令层是 addXxx 的统一入口（层级/视口/devtools 共用）：

`src/app/commands/nodeCommands.ts:75`：

```ts
const node = engine().addMesh(subtype, parentId);
```

`src/app/components/Viewport.vue:60`（视口工具条）：`engine.setGizmoMode(mode);`
`src/app/commands/editorCommands.ts:113`（地形绘制）：`store.engine.beginTerrainPaint()`。

应用层挂载/卸载编排见 `src/app/services/editorService.ts`（mountEditor :182 /
disposeEditor :459）；引擎内挂载序列在 `engine/mount.ts`（mountEditorEngine）。

## 测试例

`src/framework/engine/**` **不进单测口径**（vitest coverage exclude，渲染链路归
smoke 与手工）。可测的邻接面真实范例：

`scripts/smoke/tracker/smoke-mesh.ts` —— vite --ssr 打包框架层后断言
`geometryRegistry/buildGeometry/ModelManager` + `NodeFactory(createDefaultRegistry())`
的创建与序列化（引擎邻接逻辑 smoke 化的模板）。

**文本契约注意**：多个 smoke 套件（nav/logic-engine/fog/model-extract/terrain-paint）
直接读引擎源文件文本断言接线存在；引擎结构再拆分时这些断言的读取目标要随迁
（契约不变、路径更新），跑 `pnpm smoke --core` 会拦住漏改。

改 EditorEngine 后的最低验证：`pnpm test:regression:core`（P0 全绿）+
`pnpm dev` 手工过一遍视口（创建/拖拽/撤销）。
