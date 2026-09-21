# 单元：图窗口 —— 打开 / 画布交互 / 试跑

## 操作面：打开与会话

- 入口：首页项目卡片右键「打开场景图」（ProjectsSection.vue:200）——不经编辑器，
  直接开独立窗口（label `graph-N`，多会话可同时开多个）。
- 场景会话与编辑器**按 (root, rel) 复合键共享**（后端 mod.rs:325）：编辑器里的
  未保存修改与撤销历史图窗口直接可见；编辑器改动经 `sceneApi.subscribe` 实时
  同步（250ms 防抖，graphStore.ts:673）。窗口关闭时 flush 图文档 + 关闭会话。
- 工作区布局：左层级 / 中画布|预览 / 右检查器·变量·自定义 / 底控制台·场景面板
  （布局持久化 `tve:graph:dock-layout:v2`；dock-layout:v3 迁移见仓库既有键约定）。

## 操作面：画布交互（GraphCanvas.vue）

| 操作 | 方式 |
|---|---|
| 建原型卡 | 层级行**拖入**画布（去重）；双击实体加入；右键「加入画布/复制名称」 |
| 添加节点 | 画布右键 → 注册表分组菜单（事件/实体/容器/驱动器/操作/控制流/数学/变量/自定义 + 注释框/粘贴/适配视图） |
| 连线 | 拖端口；数据类型校验（exec 与数据互连被拒）；非 multi 口替换旧线、multi 口追加 |
| 选中/框选 | 点选 / Vue Flow 框选 → 右侧检查器联动 |
| 容器 | 拖动整棵子树跟随；拖入容器矩形即归属（可嵌套，最内层命中）；删除级联子树 |
| 复制/粘贴 | Ctrl+C / Ctrl+V（id 与容器归属重映射） |
| 撤销/重做 | Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y（快照栈上限 100） |
| 删除 | Delete / Backspace / 工具栏 / 右键 |
| 视图 | 滚轮缩放 0.2–2.5、MiniMap、**F 适配视图**、16px 网格吸附开关 |
| 注释框 | 工具栏/右键添加，拖角缩放，检查器改文本/颜色 |
| 重命名 | 节点右键「重命名」（留空恢复默认）；连线右键删除 |
| 切场景 | 底部「场景」面板双击场景资产（层级/实体/图随场景切换） |

## 操作面：试跑（预览）

- 顶栏中央「**图 / 预览**」切换（GraphApp.vue:179）→ 预览走与编辑器同一导出链：
  先 `sceneApi.save()` 落盘场景 → 组装网页运行时 + 用户脚本编译产物 → 注入
  `script-graph.json` → iframe 回放（GraphPreview.vue:41）。
- 工具栏「刷新 / 重新导出 / 浏览器打开」；运行时日志转发到底部「控制台」面板。

## 规则/要点

- **图是行为定义，不改场景**：图上操作在预览运行时由 graph kernel 解释执行，
  编辑器场景数据零回写（graphTypes.ts 头注释）。
- exec 执行链与数据通道互连被禁（canConnectDataTypes）；UI 辨识：exec 引脚
  **方形**白线带箭头，数据引脚圆形青色，实体/实体集绿色（styles/graph-window.scss:508）。
- FSM/BT 容器接「作用域」自动读 .fsm/.bt 资产回填状态/模式。

## 测试例

- kernel 执行语义真实测试例：`scripts/smoke/tracker/smoke-graph-runtime.mjs`（P0）。
- 未知类型卡/旧格式迁移：nodeRegistry normalize（graphStore.ts:393）——无 spec，
  图文档类型定义真实 spec 缺位，可按 pattern-logic.md 给 `canConnectDataTypes`
  等纯函数补测。
