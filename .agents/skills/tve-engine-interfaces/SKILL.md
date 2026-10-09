---
name: tve-engine-interfaces
description: TvE Hub 引擎侧全部接口设计：编辑器引擎（EditorEngine/SceneClient/ScenePrototype）与播放运行时（src/runtime → public/engine）、tve 脚本 SDK、场景图逻辑运行时、构建管线，每单元含契约+真实使用例+测试例。凡改引擎、加节点类型/组件、动场景序列化、写 tve 用户脚本、接场景写通道、排查预览/导出产物问题，一律先读本技能。
---

# 引擎侧接口设计

引擎是**双轨**结构，先分清你要动哪一轨：

```
渲染抽象  src/engine/**                RHI（渲染硬件接口）+ RPI（渲染管线接口）
  ├─ rhi/  types+registry+backends/three（唯一直接 import three 的设备层）
  └─ rpi/  types+layerSet+backends/three（清除/分层多 pass/离屏回贴）
     分层规则见 ARCHITECTURE.md 与 scripts/check-layers.mjs（three 只准
     engine/*/backends + 台账存量；engine 不依赖上层/vue/tauri）；扫描含
     渠道运行时面 runtime/bridge 与 public/web-preview（player.mjs 在台账）

编辑器侧  src/framework/**            Framework 层：可复用引擎功能与通用机制
  ├─ engine/EditorEngine.ts           编辑器引擎门面（~970 行：字段+构造接线+选择+薄委托）
  ├─ engine/{mount,events,nodeOps,assetRefresh,skyEnv,fogEnv,previewView,
  │  pipView,navSources,terrainPaint,viewportQuery,layoutNav}.ts
  │     按关切拆分的实现体：挂载/卸载、事件反应路由、节点操作族、资产刷新、
  │     天空/雾环境、预览与画中画、导航烘焙输入、地形绘制会话、视口查询
  ├─ engine/modules/RendererManager   视口策略层（设备/管线经 src/engine 抽象）
  ├─ prototype/ + scene/              数据模型层：Node/Transform/ScenePrototype/SceneClient
  └─ camera/ lighting/ material/ …    各系统（与运行时模块一一对应）

播放侧    src/runtime/**              纯构建产物 public/engine/**（不入库！）
  ├─ core/  tve.ts + scripts/tween/log/particles…   → public/engine/core/*.mjs
  └─ runtime/ stage/nodes/physics/…                  → public/engine/runtime/*.mjs
             stage.ts 创建 RHI 设备+RPI 管线（src/engine 源码内联进产物）
             装配层 public/web-preview/player.mjs（源即产物，手写）

权威状态  src-tauri/src/scene/        Rust 场景图（撤销历史也在后端）
```

**改了 src/runtime 必须重建产物**：`pnpm build` 链第一步，dev 由 vite 插件
`runtimeBuildPlugin` 自动重建；产物缺失/陈旧 → 预览白屏或 blob 语法错误。

## 消费通道（谁在用播放引擎）

1. **网页预览**：WebPreviewPanel.vue 用 iframe 加载预览服务 URL → player.mjs；
2. **多文件导出**：build/<channel>/ 静态站，同一 player；
3. **单页导出**：数据内联 `window.__TVE_BUILD_DATA` + import map Blob；
4. **局域网共享**：复用导出产物（.tmp/share）。
编辑器画布不走 player——它直接用 EditorEngine + RendererManager。

## 关键契约速查（改动前必读）

- **层级事实源 = 嵌套 children**（`.scene`/`.prefab`/`ScenePrototype.fromJSON`/
  Rust `Graph::from_root_doc` 四处同约定）；`childIds` 冗余字段被忽略。
- **SceneClient 写通道**：乐观应用 → 提交后端 → scene:changed 幂等回填；
  拖拽期间只改镜像、松手一次性提交（一次拖动 = 一个撤销步骤）。
- **tve SDK 版本** 1.3.0（tve.d.ts ↔ public/engine/core/tve.mjs 镜像同步）；
  API 文档 `public/docs/sdk/api.md` 由 `pnpm gen:api-docs` 自动生成，勿手改。
- **SCRIPT_NODE_BASE 表**（engine/nodeOps.ts）：新增可创建节点类型漏登记会编译报错。
- **编辑器↔播放共享单源**（「共享纯逻辑 + 各自适配」边界）：地形全套算法
  （framework/terrain/{types,generate,simplify,dem,noise}——含 ImprovedNoise 自包含
  副本，勿改回 three/examples import）与基元几何/数据网格解码
  （framework/mesh/{geometry,dataGeometry}）由播放侧 src/runtime/runtime/{terrain,mesh}.ts
  直接 import——改参数/算法只改 framework 一处，两端产物一致；播放侧文件只留
  场景装配适配（JSON 收敛/chunk 拆分/回退策略）。
- **词法器**：glslLexer → glslParser → glslToTsl（framework 侧）+ runtime/core/glslToTsl.ts
  （WebGPU 路径），改一处要看另一侧镜像。

## 路由表

| 要做的事 | 读 |
|---|---|
| 写/改 tve 用户脚本（engine.* API） | references/sdk-engine-api.md |
| 组件生命周期/实体/节点类/内置组件 | references/sdk-component.md |
| @property/@nodeType 装饰器与元数据 | references/sdk-decorators.md |
| math/tween/Delegate/Pool/DataCenter | references/sdk-utils.md |
| Node/Transform/prefab 数据模型 | references/prototype-model.md |
| 场景镜像/写通道/序列化契约 | references/scene-sync.md |
| EditorEngine 门面与子系统 | references/editor-engine.md |
| RHI/RPI 渲染抽象（src/engine，双轨共用） | ARCHITECTURE.md（仓库根） |
| 场景图逻辑运行时（GNode/graph kernel） | references/graph-logic.md |
| player.mjs 装配/帧循环/模块清单 | references/player-runtime.md |
| 预览调试协议/单页内联/源↔产物映射 | references/runtime-comm.md |
| buildRuntime 管线/extra 资产/产物清单 | references/build-assets.md |

## 姊妹技能

**写 tve 用户脚本（内置完整代码模板）**：`tve-sdk-scripting`——本技能讲接口设计，
写代码用它；API 调用方式与测试空白区：`tve-api-usage`；单测/smoke 分工：`tve-unit-testing`；
编辑器/图窗口/白板用户操作全集：`tve-app-operations`；
系统层：`tve-agent-autonomy` · `tve-local-ci` · `tve-self-evolution`。
