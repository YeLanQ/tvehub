---
name: tve-api-usage
description: TvE Hub 工程内部 API 使用手册：Tauri invoke 门面(src/lib/api.ts)、sceneApi、ui-state、stores、services、composables、命令注册表，每个单元含契约+真实使用例+测试例。凡要调用后端能力、读写资产/场景/项目/工坊、开窗口、发构建导出、注册或派发编辑器命令、新增面板功能，一律先查本技能——即使用户没说"API"两个字。
---

# TvE Hub 工程 API 使用方式

本技能是**路由索引**：先在这里定位单元，再读 `references/` 下对应小文件。每个单元文件固定三段：**契约**（方法清单）、**使用例**（仓库真实调用点 `文件:行号`）、**测试例**（已有 spec 引用，或标注"当前无 spec"的推荐写法）。

## 分层地图（谁持有 IPC 出口）

```
src/lib/api.ts        唯一 Tauri invoke 大门面（100+ 方法，camelCase ↔ 后端 snake_case 命令）
src/lib/scene-api.ts  场景会话门面（写通道 transport + open/save/subscribe）
src/lib/ui-state.ts   UI 状态 KV 门面（ui_state_get/set/remove + 跨窗口广播）
        ↓ 只被以下各层消费，业务代码禁止直接 import @tauri-apps/api/*
src/app/services/     业务用例层（assetService 命名/去重/只读保护；editorService 生命周期）
src/app/stores/       惰性单例状态层（无 Pinia：getEditorStore() 等，首次调用才构造）
src/app/composables/  组件用组合层（inspector/assets/anim-editor 三族 + 任务调度）
src/app/commands/     命令注册表（工具栏/快捷键/右键/devtools·MCP 统一执行入口）
```

**门禁**：`scripts/check-layers.mjs`（build 链一环）强制只有 `src/lib/**` 可 import
`@tauri-apps/api/core|event|window`。新代码要碰后端 → 加到 lib 门面或走既有方法，不要绕。

## 路由表：做什么 → 读哪份

| 要做的事 | 读 |
|---|---|
| 扫描/读写/导入/移动/删除资产、建目录 | references/facade-assets.md |
| 读写材质/着色器/天空/地形/FSM/行为树资产 | references/facade-materials.md |
| 打开/新建/重命名项目、最近列表、回收站 | references/facade-projects.md |
| 打开/保存场景、订阅变更、层级行查询 | references/facade-scenes.md |
| 创意工坊仓库与内置资源（internal/…） | references/facade-workshop.md |
| 多窗口互开、待交付项目/白板/文档 hash | references/facade-windows.md |
| 调试日志、devtools 服务、局域网共享 | references/facade-devtools.md |
| 任务队列、网页预览服务、构建导出 | references/facade-tasks-build.md |
| 助手：LLM 流式外呼、浮动面板、devtools 进程内调用桥 | references/facade-ai.md |
| 读改编辑器/项目/资产/脚本全局状态 | references/stores.md |
| 图窗口/白板窗口的 store | references/stores-windows.md |
| 资产业务规则（校验/去重/保护）、编辑器挂载 | references/services.md |
| 检查器/资产/动画组合函数 | references/composables.md |
| 注册新命令或派发既有命令 | references/commands-registry.md |

## 单元三段式规则（新增 API 时必须遵守）

给 lib 门面/服务层新增一个 API 单元时，同步补三样：
1. 契约：在对应 facade 文件补方法条目（后端命令名 + 一句话）；
2. 使用例：至少一处真实调用点（落码后再回填 `文件:行号`）；
3. 测试例：纯逻辑按 tests/README.md 口径补同目录 `*.spec.ts`（正常/边界/异常/空值四类输入）；薄 IPC 封装不直测，测其上游服务层。

## 姊妹技能

- 引擎侧接口设计（EditorEngine/SceneClient/tve SDK/运行时）：`tve-engine-interfaces`
- 用 tve SDK 写脚本（完整代码模板）：`tve-sdk-scripting`
- 写单测的规范与模式：`tve-unit-testing`
- 编辑器/图窗口/白板的用户操作全集（命令 id 清单）：`tve-app-operations`
- 系统层：`tve-agent-autonomy`（自主决策）· `tve-local-ci`（本地 CI）· `tve-self-evolution`（文档自演化）
