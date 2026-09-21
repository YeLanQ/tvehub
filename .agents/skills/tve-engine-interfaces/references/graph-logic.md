# 单元：场景图逻辑运行时（`src/framework/graph/` + `src/runtime/runtime/graph-*`）

## 契约

**图文档**（graphTypes.ts，framework 层，不依赖 app/api 与 three）：
`ScriptGraphDoc { formatVersion: 2, modules, nodes: GNode[], edges: GEdge[],
comments, variables: GVariable[], customNodes: GCustomNodeDef[] }`。
- `GNode { id, type, x, y, entityId?, matchMode/matchPattern? }`，kind 四种：
  `proto`（拖入实体原型卡）/`match`（标签|类型批量匹配）/`op`（原子操作）/`event`（执行链入口）；
- `GEdge { id, srcNode, srcPort, dstNode, dstPort }`；
- 类型键示例：`"entity.proto"`、`"op.spin"`、`"event.onBegin"`；容器类型
  `fsm.container | bt.container`；
- 图变量：`{ id, name, dataType: number|boolean|string, value }`（var.get/var.set 引用）；
- 自定义节点：`custom.` 前缀类型键 + 每输出端口一条求值表达式（可引用端口 id、字段、Math）。

会话语义：图是**随场景自动持久化的工作板**（.tve 旁路，用户不感知文件），
预览导出时随产物注入，由运行时解释执行；**操作不回写编辑器场景**。

**注册表**（framework/graph/）：`nodeRegistry.ts`（GNodeTypeDef/GPortDef/GDataType:
exec|entity|entities|number|boolean|string|vec3|any、`canConnectDataTypes`、
`registerModule(manifest)` 扩展点）、`opRegistry.ts`（GRAPH_OP_DEFS 原子操作定义）。

**运行时**（src/runtime/runtime/）：
- `graph-kernel.ts` —— 类型无关引擎：exec 推模型级联 / 数据拉模型求值 / 实体集通道 /
  容器递归 / 驱动器实例缓存 / 事件绑定 / 射线点击。**零类型特判**，语义全靠注册；
- `graph-runtime.ts` —— `GraphRuntimeModule` handler 契约、DataValue、ExecCtx；
- `graph-core-modules.ts` —— 内置类型语义；`graph-behaviors.ts` ——
  `createGraphBehaviors(...)` 装配门面 + `graphReferencedEntityIds(graph, sceneNodes)`
  （批处理排除被图引用的实体）。

## 使用例

图窗口：`src/graph-window/graphStore.ts`（sceneApi 建实体索引 + 图文档编辑/保存）。
运行时装配：`public/web-preview/player.mjs:714`（按配置动态 import graph-behaviors）。

## 测试例

真实测试例：`scripts/smoke/tracker/smoke-graph-runtime.mjs`（P0）——kernel 推/拉
模型、容器递归、驱动器缓存的产物级回归。

**扩展新图节点类型的分工**：framework 侧在 nodeRegistry/opRegistry 注册定义 +
补类型（可按 vitest 纯逻辑测 `canConnectDataTypes` 等）；runtime 侧在
graph-core-modules.ts 加 handler 并让 smoke 覆盖执行语义。两侧模块清单受
smoke-runtime-modules.mjs 导出面断言保护。
