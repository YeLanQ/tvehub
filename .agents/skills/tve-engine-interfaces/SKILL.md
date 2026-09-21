---
name: tve-engine-interfaces
description: TvE Hub 引擎侧全部接口设计：编辑器引擎（EditorEngine/SceneClient/ScenePrototype）与播放运行时（src/runtime → public/engine）、tve 脚本 SDK、场景图逻辑运行时、构建管线，每单元含契约+真实使用例+测试例。凡改引擎、加节点类型/组件、动场景序列化、写 tve 用户脚本、接场景写通道、排查预览/导出产物问题，一律先读本技能。
---

# 引擎侧接口设计

引擎是**双轨**结构，先分清你要动哪一轨：

```
编辑器侧  src/framework/**            常驻 three（node_modules），跟随前端打包
  ├─ engine/EditorEngine.ts           编辑器引擎门面（3155 行）+ modules/ 12 个子系统
  ├─ prototype/ + scene/              数据模型层：Node/Transform/ScenePrototype/SceneClient
  └─ camera/ lighting/ material/ …    各系统（与运行时模块一一对应）

播放侧    src/runtime/**              纯构建产物 public/engine/**（不入库！）
  ├─ core/  tve.ts + scripts/tween/log/particles…   → public/engine/core/*.mjs
  └─ runtime/ stage/nodes/physics/…                  → public/engine/runtime/*.mjs
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
- **SCRIPT_NODE_BASE 表**（EditorEngine.ts:104）：新增可创建节点类型漏登记会编译报错。
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
| 场景图逻辑运行时（GNode/graph kernel） | references/graph-logic.md |
| player.mjs 装配/帧循环/模块清单 | references/player-runtime.md |
| 预览调试协议/单页内联/源↔产物映射 | references/runtime-comm.md |
| buildRuntime 管线/extra 资产/产物清单 | references/build-assets.md |

## 姊妹技能

**写 tve 用户脚本（内置完整代码模板）**：`tve-sdk-scripting`——本技能讲接口设计，
写代码用它；API 调用方式与测试空白区：`tve-api-usage`；单测/smoke 分工：`tve-unit-testing`；
编辑器/图窗口/白板用户操作全集：`tve-app-operations`；
系统层：`tve-agent-autonomy` · `tve-local-ci` · `tve-self-evolution`。
