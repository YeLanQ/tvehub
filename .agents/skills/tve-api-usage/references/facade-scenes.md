# 单元：场景会话 IPC（`src/lib/scene-api.ts`）

## 契约

后端是场景权威状态（读盘/迁移/序列化/撤销历史全在 Rust），前端持镜像。

`sceneApi`（`import { sceneApi } from "@/lib/scene-api"`）：

| 方法 | 用途 |
|---|---|
| `transport()` → `SceneTransport` | SceneClient 写通道（项目打开时注入引擎） |
| `open(root, rel, force?)` → `SceneLoadResult` | 打开 .scene（读盘+迁移+建图，历史清零）；force=true 且会话已存在但干净 → 磁盘重装并广播 replace（asset.write 直写后重开即见磁盘版），脏会话仍复用 |
| `loadDoc(doc, root?, rel?)` → `SceneLoadResult` | 前端文档整树替换会话（初始场景/兜底，不落盘） |
| `save()` | 保存（后端序列化+写盘+清脏） |
| `doc()` → unknown | 读当前完整文档（devtools/快照用） |
| `hierarchyRows(view, search)` → `{revision, rows}` | 层级面板行（后端 DFS+域过滤+搜索） |
| `close()` / `dirty()` | 关闭会话 / 查未保存标记 |
| `subscribe(fn)` → 取消函数 | 订阅后端 `scene:changed` 事件 |

写通道 `SceneTransport` 十方法 → `scene_add_node / scene_add_tree / scene_remove_nodes /
scene_reparent_nodes / scene_rename / scene_set_transform / scene_patch_node(s) /
scene_undo / scene_redo`。

`scene:changed` 载荷 `SceneChangedEvent { root, rel, kind, nodeId, revision,
nodes: JsonRecord[], history, dirty }`，`kind ∈ add|remove|reparent|rename|transform|properties|replace|clear`。

## 使用例

`src/app/services/editorService.ts:195-197`（挂载时接线：写通道注入引擎 + 事件回灌镜像）：

```ts
engine.setSceneTransport(sceneApi.transport());
sceneApi.subscribe((e) => { /* 按项目/场景过滤后 applyRemote */ });
```

`src/app/lib/save-scene.ts:11`（统一保存入口，命令 editor.save 经此）：

```ts
export async function saveCurrentSceneToMain(): Promise<void> {
  await sceneApi.save();
}
```

`src/graph-window/graphStore.ts:673`（图窗口独立订阅场景变更建实体索引）。

## 测试例

传输层是薄 IPC，不直测；**场景数据层的真实测试例**：

`src/framework/scene/ScenePrototype.spec.ts`（19 用例，四类输入的组织范本）：
序列化往返（toJSON→fromJSON）、缺字段回默认、悬空 childId 不产出条目、
addNode 指向不存在父节点、clone 深拷贝新 id 集合、traverse 空场景无回调。

场景文档的层级事实源契约（嵌套 children，childIds 忽略）见
`tve-engine-interfaces` 技能 references/scene-sync.md。
