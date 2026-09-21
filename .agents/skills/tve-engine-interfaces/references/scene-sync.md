# 单元：场景镜像与写通道（`src/framework/scene/`）

## 契约

**ScenePrototype.ts** —— 场景文档结构：
`{ metadata: SceneMetadata, settings: SceneSettings, rootId, nodes: Map<id,Node>,
childrenIndex: Map<parentId, id[]> }`；方法 `addNode/removeNode/findNode/getChildren/
traverse/clone()/clear()/isEmpty`。
**序列化契约（四处同约定）**：层级事实源 = **嵌套 children**；`childIds` 冗余字段
被忽略。`fromJSON` 容错：缺字段回默认、悬空 childId 不产出条目；`toJSON` 递归嵌套。
`clone()` 经 cloneNodeInto 递归克隆到目标场景——id 全新、索引在目标重建
（防克隆污染源场景，commit ddc3c55）。

**SceneClient.ts** —— 前端镜像层（权威在后端 Rust SceneSession）：
- 读接口 `GraphLike { get(id), all() }` 与旧 SceneGraph 同构（消费者零改动）；
- **写 = 乐观应用**：先改镜像并广播 `SceneChange`，再提交 SceneTransport 命令；
  后端 `scene:changed` 回执幂等回填；提交失败回滚镜像并告警；
- 连续交互（gizmo 拖动/滑杆）只更新镜像，松手带 before/after 一次性提交
  （一次拖动 = 一个撤销步骤）；
- `HistoryView`：后端历史状态对 UI 的只读视图（undo/redo 按钮态）。

**SceneTransport**（写通道接口，10 方法）：`addNode/addTree/removeNodes/
reparentNodes/rename/setTransform(id,before,after)/patchNode/patchNodes/undo/redo`。
实现见 `src/lib/scene-api.ts`（映射到 scene_* 命令）。

`SceneChangedEvent { root, rel, kind, nodeId, revision, nodes: JsonRecord[], history, dirty }`，
`kind ∈ add|remove|reparent|rename|transform|properties|replace|clear`。

## 使用例

`src/app/services/editorService.ts:195-197`（接线）：

```ts
engine.setSceneTransport(sceneApi.transport());   // 注入写通道
sceneApi.subscribe((e) => { /* 过滤本会话后回灌镜像 */ });
```

消费侧：`engine.graph.get(id)` / `engine.graph.all()`（SceneSynchronizer/HelperSystem
/所有面板的读取面）；写一律经 engine 命令方法（addXxx/patchNode…），**不要**绕过
镜像直接改 Node。

## 测试例

`src/framework/scene/ScenePrototype.spec.ts`（19 用例，核心桶 90/85）：序列化往返、
缺字段回默认、悬空 childId、addNode 指向不存在父节点、clone 新 id 集合、clear 重置。

SceneClient 本身无 spec——它的正确性依赖 IPC 往返（jsdom 无 Tauri），归
`pnpm smoke` 编辑器链路套件（.ts 套件经 vite --ssr 打包）与手工验证。给 SceneClient
提纯的逻辑（如补丁 diff）可抽成纯函数进 framework 按同目录 spec 测。
