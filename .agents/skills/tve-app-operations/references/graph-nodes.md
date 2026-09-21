# 单元：图窗口 —— 节点类型 / 图变量 / 自定义节点 / 保存

## 操作面：节点类型全集（nodeRegistry.ts / opRegistry.ts）

| 分组 | 类型 | 语义 |
|---|---|---|
| 实体 | `entity.proto` | 原型卡（层级拖入）；「接入」口向实体脚本传值（onGraphInput） |
| | `entity.match` | 按标签/类型批量圈定实体（tag/type 双入口，实时命中数） |
| | `entity.prop` | 拉模型按点分路径读目标实体任意属性 |
| 事件 | `event.onBegin / onTick / onClick` | 执行链入口：启动一次 / 每帧 / 指针射线命中 |
| 操作 | `op.set / op.spin / op.bob / op.patrol(路径点) / op.fireFsm / op.setFsmParam / op.children` | 设置属性/持续旋转/上下浮动/路径巡逻/FSM 事件/FSM 参数/获取子级（卡片徽标标触发时机：启动时/每帧/点击时） |
| 驱动器 | `op.navMove / op.chase` | 导航移动贴合代理；追击目标（有导航区域自动寻路） |
| 控制流 | `flow.branch / compare / for / forEach / while(上限 10000) / gate` | 分支/比较/循环/遍历实体集/中断开关（通断锁存） |
| 数学 | `math.add/sub/mul/div/mod / sin/cos/tan(角度制) / vec3Make/vec3Break / stringConcat / toString / lerp / clamp / abs / sense.distance` | 纯数据拉模型 |
| 变量 | `var.get / var.set` | 读/写图变量 |
| 容器 | `fsm.container / bt.container` | 状态机大框（接 .fsm 回填状态）；行为树容器（sequence/selector/parallel，可嵌套） |
| 自定义 | `custom.*` | 用户定义，输出引脚 = JS 表达式求值 |

扩展机制：`registerModule(manifest)` 注入新分组/类型，自动进右键菜单——不改
GraphCanvas 代码（nodeRegistry.ts:197）。

## 操作面：图变量（右侧变量面板）

`+` 添加（number/boolean/string）；双击重命名；下拉改类型（自动修正初始值）；
改初始值；行尾 × 删除（同步清 var.get/var.set 绑定）。选中变量节点后在检查器
下拉绑定变量。

## 操作面：自定义节点（右侧自定义面板）

`+` 添加（默认端口 a→result、表达式 `a`）；改名称/类型键（须 `custom.` 前缀）/
描述/颜色；增删输入输出端口与字段；逐输出写 JS 表达式（可引用端口 id、字段 key、
Math，如 `a * f1`、`Math.sin(a)`）；删除连带清画布同类型节点。定义变更即热注册。

## 操作面：保存机制

- 图文档存 **`graph/<场景名>.graph` 侧车**（与 assets/src 同级，不进 .scene）。
- **600ms 防抖自动保存**（graphStore.ts:238），顶栏显示「自动保存中…/已保存
  HH:MM:SS」；pagehide/关窗冲刷；无需手动保存。
- 加载收敛：未知类型保留为 unresolved 灰卡不丢数据；旧格式自动迁移。
- 与场景保存**完全独立**；场景只在预览导出前由图窗口代存（GraphPreview.vue:99）。

## 测试例

- 图文档类型定义（graphTypes.ts）无 spec——`ScriptGraphDoc` 往返/未知类型保留
  是好的补测点（参照 ScenePrototype.spec.ts 往返模板）。
- 真实测试例：`smoke-graph-runtime.mjs`（kernel 语义）、`smoke-runtime-modules.mjs`
  （graph-behaviors 导出面）。FSM/BT 资产解析真实 spec：
  `src/framework/fsm/fsmTypes.spec.ts`、`src/framework/logic/types.spec.ts`。
