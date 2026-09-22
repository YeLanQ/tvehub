# 单元：编辑器命令全清单与快捷键

## 操作面：命令注册表（33 条，src/app/commands/）

**编辑器组**（editorCommands.ts）：`editor.undo`（撤销）、`editor.save`（保存；
script 视图连带保存脏脚本）、`editor.gizmoMode`（args `mode`: translate/rotate/scale；
守卫 scene/layout + 非地形绘制 + 非拖拽中）、`editor.focusSelected`（args `id?` 缺省
选中；取景包围球）、`editor.terrainPaint`（toggle 进出地形绘制）、`editor.close`
（脏场景三选一确认 → dispose → 回首页）。

**节点组**（nodeCommands.ts）：`node.add`（args `kind` 13 族：group/mesh/light/
camera/skybox/fog/audio/particle/nav/logic/terrain/ui/script/model + subtype/
geometry/path/scriptRel/name，model 收 `position` 拖放落位）、`node.rename`
（`name`,`id?`）、`node.delete`（`id|ids[]`，根不可删）、`node.duplicate`
（`id|ids[]`，复制子树一次撤销）、`node.reparent`（`moves[]`{id,newParentId,
newIndex}，成环守卫）、`node.patch`（`id,before,after` 整节点补丁）、
`node.setTransform`（`id,snapshot`）、`node.set`（`{id,prop,value}` 单属性或
`{id,...字段}` 字段包：name/visible/active/tag/transform/position/rotation/scale
任意混写，transform 与分量逐轴部分合并；解析/合并纯函数见 nodeSet.ts；禁改
id/父子/children/type）、
`node.alignCameraToViewport`（相机对齐视口）、`node.select`（`id` 空=取消）、
`node.renameSelected`（弹框，F2 共用）。

**资源组**（assetCommands.ts）：`asset.renameSelected`（`rel?`；保护资产拒绝；
脚本改名同步改写场景引用）。

**远程组**（remoteCommands.ts，全部 expose 给 devtools/MCP）：`editor.state`
（状态快照）、`project.recentList/open/close`、`scene.list/open/save/doc`、
`state.restore`（`doc`=scene.doc 快照回放）、`preview.open/close/start/stop/
screenshot`（截图存 `.tmp/devtools/` 返 base64）、`asset.list/create/select/
delete/rename`（create 的 `type`: scene/script/material/shader/texcube/skybox/
prefab/anim/terrain/folder，重名自动 "name 2"）。

## 操作面：快捷键（App.vue:75-124，捕获阶段）

| 键 | 命令 | 备注 |
|---|---|---|
| W / E / R | `editor.gizmoMode` translate/rotate/scale | 仅 scene/layout |
| F | `editor.focusSelected` | |
| Ctrl+Z / Ctrl+S / Ctrl+W / Ctrl+D | undo / save / close / duplicate | Ctrl+W 关项目 |
| F2 | 最近交互面板=资产 → `asset.renameSelected`；否则 `node.renameSelected` | |

条件：装载蒙版期间忽略；文本焦点（输入框/Monaco，`isEditingText()`）全部让位。
Rust 原生菜单 undo/save/close 经 `editor-command` 事件通道兼容保留（App.vue:130）。

## UI 入口速查

- 工具栏 Toolbar.vue：项目 ⚙ 设置、构建、视图页签（场景/布局/预览/脚本）、共享
  （先 build web 单页 gzip 到 `.tmp/share` 再开分享弹层）、撤销、保存（脏标记圆点）。
- 层级右键 HierarchyPanel.vue:376：添加节点（13 族子菜单 node-menu.ts:38）、
  重命名/复制/删除、对齐到当前视口（仅相机）、存储为预制体 / 更新预制体（实例）。
- 视口 Viewport.vue：内部拖放（mesh/light/camera/group）、资产拖放落位（模型/
  prefab 落在光标命中点）、gizmo 本地/世界切换、「绘制」按钮进地形绘制。

## 规则/要点

- 命令不抛错：`dispatchCommand` 返回 `{ok, skipped?, error?}`；canRun false →
  skipped（快捷键静默跳过的机制）。
- 远程驱动示例：MCP 调 `node.add {kind:"mesh", subtype:"box"}` → 层级/视口/撤销
  与手工操作完全一致。

## 测试例

- 命令注册表无 spec——registry 单测示范写法见 `tve-api-usage` 技能
  references/commands-registry.md 测试例段（未知命令/skipped/error 三分支）。
- `node.add` 的创建路径由 `smoke-mesh.ts`（NodeFactory+注册表）与
  `src/framework/factory/NodeFactory.spec.ts` 覆盖工厂层。
