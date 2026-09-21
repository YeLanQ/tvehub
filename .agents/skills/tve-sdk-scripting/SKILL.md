---
name: tve-sdk-scripting
description: 用 tve SDK 为 TvE Hub 编写用户脚本（Component 组件）的代码技能：完整可抄的代码模板覆盖移动/输入/物理/碰撞/射线/补间/动画/UI/音频/粒子/FSM/BT/跨组件通信，含 API 签名速查、常见坑与验证流程。凡要写游戏脚本、给节点挂组件、实现玩法逻辑、用 engine.* 或 tween/property/@nodeType 写代码，一律用本技能——即使只说"写个脚本"。
---

# tve SDK 脚本编写

用户脚本 = 项目 `src/**.ts` 里的一个 `export default class extends Component`，
`import { Component, property, nodeType, engine, math, tween, ... } from "tve"`。
类型契约：`src/framework/scripting/tve.d.ts`（VERSION 1.3.0）；API 参考文档
`public/docs/sdk/api.md`（pnpm gen:api-docs 自动生成）。**示例脚本库 =
`public/repos/code/`（工坊 code 分类），新模板优先补到那里。**

## 硬规则（写之前必须知道）

1. **每个文件一个默认导出类**：`export default class Foo extends Component`；
   类名 PascalCase（新建脚本时类名按文件名注入，保持文件名 = 类名一致最省事）。
2. **编译约束**：保存时经 TS transpileModule 内存编译为 **ES2020 ESM**——
   不能用 ES2021+ 语法/API；不用 npm 包；不写 `import.meta`。
3. **跨脚本引用组件用 `import type`**（只引类型，编译期擦除，运行时按类名全局
   查找 get-or-create）；运行时**不要** import 其他脚本的运行时值。
4. **引擎自有类型**：Vec3 是普通对象 `{x,y,z}`、旋转一律**度**制欧拉角、颜色
   `0xRRGGBB` 数字；拿不到任何 three.js 对象。
5. **属性声明用 @property 装饰器**（字段初值即默认值与类型推断来源）；检查器
   修改的是覆盖值，运行期 `this.字段名` 读写的就是最终值。
6. **生命周期顺序**（scripts.mjs 宿主调度）：全部实例 `onEnable` → 全部 `onStart`
   （一次性初始化）→ 每帧：`onFixedUpdate`（1/60s 固定步长，掉帧补偿 0..4 次，
   物理相关写入放这里）→ 碰撞回调 → `onUpdate`（渲染帧率）→ …全部模拟完成后
   `onLateUpdate`（相机跟随等覆盖性位姿写这里）→ 停机 `onDisable` → `onDestroy`。
7. **运行态写量不落盘**：脚本对灯光/粒子/UI/组件设置的修改只在预览与产物运行态
   生效，不回写场景文件。
8. **调试**：`engine.log/warn/error(...)` → 编辑器控制台（postLog 转发）；
   预览面板 F3 开调试统计。

## 路由表：要写什么 → 读哪份模板

| 需求 | 模板 |
|---|---|
| 组件骨架、属性三种写法、实体变换/层级 | references/component-basics.md |
| WASD/摇杆/指针输入驱动移动 | references/movement-input.md |
| 刚体、碰撞回调、冲量、射线拾取 | references/physics-collision.md |
| 补间动画、关键帧 .anim、骨骼动画/动画图 | references/tween-anim.md |
| 场景查询、节点引用、跨组件通信 | references/scene-query-comm.md |
| UI 画布/按钮、音频、粒子、灯光、地形 | references/ui-audio-fx.md |
| 状态机/行为树的脚本控制 | references/logic-fsm-bt.md |
| 常见坑与自检清单、验证流程 | references/pitfalls.md |

每份模板固定三段：**契约**（签名速查）→ **模板**（完整可抄代码）→ **测试例**
（怎么验证/相关 smoke）。

## 姊妹技能

引擎接口全景（双轨架构/序列化/构建管线）：`tve-engine-interfaces`；
示例脚本入库规范与工坊 IPC：`tve-api-usage`；
脚本在工作台/图窗口/白板等产品界面里的操作上下文：`tve-app-operations`；
系统层：`tve-agent-autonomy` · `tve-local-ci` · `tve-self-evolution`。
