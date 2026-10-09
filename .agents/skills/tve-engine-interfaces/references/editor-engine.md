# 单元：EditorEngine 门面（`src/framework/engine/EditorEngine.ts`）

## 契约

`class EditorEngine`（3155 行）——编辑器引擎聚合门面，成员：

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

**SCRIPT_NODE_BASE 表**（:104）：`Record<EditorNodeType, 创建函数>`——脚本
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

挂载/卸载编排不在引擎内——见 `src/app/services/editorService.ts`（mountEditor :182 /
disposeEditor :459）。

## 测试例

`src/framework/engine/**` **不进单测口径**（vitest coverage exclude，渲染链路归
smoke 与手工）。可测的邻接面真实范例：

`scripts/smoke/tracker/smoke-mesh.ts` —— vite --ssr 打包框架层后断言
`geometryRegistry/buildGeometry/ModelManager` + `NodeFactory(createDefaultRegistry())`
的创建与序列化（引擎邻接逻辑 smoke 化的模板）。

改 EditorEngine 后的最低验证：`pnpm test:regression:core`（P0 全绿）+
`pnpm dev` 手工过一遍视口（创建/拖拽/撤销）。
