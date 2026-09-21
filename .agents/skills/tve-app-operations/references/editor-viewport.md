# 单元：视图模式 / 视口 / 层级面板

## 操作面：四种视图模式（editor.ts:189 applyViewMode）

| 模式 | 中央面板 | 行为 | 进入方式 |
|---|---|---|---|
| scene | 编辑器视口 | 渲染激活，UI 画布隐藏 | 工具栏页签 |
| layout | 同一视口 | 叠显 UI 画布；选中过滤限定 UI 子树（editor.ts:135） | 页签；**场景视图选中 ui* 节点自动切入**（editor.ts:121） |
| preview | WebPreviewPanel | 引擎暂停后台渲染省资源 | 页签；`preview.open` 命令 |
| script | 脚本工作台（Monaco） | 暂停渲染 | 页签 |

离开 scene 视图自动退出地形绘制；`preview.close` 回 scene。

## 操作面：视口交互（Viewport.vue）

- 选择：左键点选（视口内 isSelectable 谓词；layout 视图仅 UI 画布子树可选）。
- 变换：gizmo 拖拽（移动/旋转/缩放按钮或 W/E/R）；坐标系本地/世界切换（:63）。
- 相机：右键拖拽平移、滚轮缩放；F / 双击层级行聚焦（取景包围球）。
- 拖放：资产面板拖模型/prefab → `node.add` 落在光标命中点（空处回退 y=0，:115）；
  内部原语（mesh/light/camera/group）拖入同理（:71）。
- 地形绘制：「绘制」按钮 → `editor.terrainPaint`（见 editor-terrain.md）。
- 调试统计：视口调试按钮显隐 DebugStatsPanel（:222）。

## 操作面：层级面板（HierarchyPanel.vue）

- 选中：单击；Shift 范围；Ctrl 切换多选（:297）。搜索框按名过滤（后端 DFS）。
- 双击行 → `editor.focusSelected {id}`（:631）。
- 眼睛按钮 → `node.patch` 切 visible/active（:125，可撤销）。
- 折叠箭头：展开状态按项目+场景持久化（:147）。
- 拖拽行改父子/排序 → `node.reparent`（>5px 触发；落点 before/after/inside；
  悬停折叠项自动展开；拖入自身子树被拒 :445）。
- 右键菜单（:376）：添加节点（13 族子菜单）、重命名、复制、对齐到当前视口（相机）、
  **存储为预制体**（saveNodeAsPrefab）、**更新预制体**（仅实例节点）、删除。
- 空白右键：取消选中 + 添加到根（:435）。

## 规则/要点

- 全部结构性改动走命令 → 后端会话 → scene:changed 回灌镜像，天然可撤销；
  直接改镜像 Node 不会同步到后端（禁此路径）。
- 预制体：存储 = serializePrefabTree 落 .prefab；更新 = 实例改动回写原型；
  实例化 = `node.add` 拖 .prefab 或右键「实例化到场景」（id 全部重生成）。

## 测试例

- 层级/视口组件无 spec（app 视图层暂不在覆盖口径）。选中过滤谓词等纯逻辑在
  `src/app/stores/editor.ts:135`（allowInLayoutView）——可抽纯函数按 vitest 测。
- 重父级/删除的后端语义由 scene 会话保证；往返契约真实 spec：
  `src/framework/scene/ScenePrototype.spec.ts`（增删查/悬空引用）。
- 预制体序列化真实 spec：`src/framework/prototype/prefab.spec.ts`。
