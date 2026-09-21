# 单元：常见坑与验证流程

## 坑清单（按踩中频率排序）

1. **弧度 vs 度**：`entity.rotation`、`rotate()`、`lookAt`、tween.rotation、
   `Light.angle`、`moveTowardsAngle` 全部**度**；唯一例外
   `engine.physics.setAngularVelocity` 是 **rad/s**。换算 `math.degToRad/radToDeg`。
2. **position 是快照副本**：`this.entity.position.y += 1` 无效——读出的副本改完要
   **整体写回** `this.entity.position = p`；写支持部分字段 `{ x: 5 }` 只改 x。
3. **LightNode ≠ Light**：`getComponent(LightNode)` ❌（节点句柄不是组件）；
   灯光属性用 `getComponent(Light)`，引用节点本身用 `@property({ type: LightNode })`。
4. **物理组件不能运行时创建**：`addComponent(RigidBody)` 返回 null——物理体只在
   启动期按场景数据构建；要模拟先在编辑器挂好组件、项目设置启用物理。
5. **钩子选错**：物理相关写入（速度/力）放 `onFixedUpdate`（1/60 固定步长，掉帧
   补偿 0..4 次）；相机跟随等覆盖性位姿放 `onLateUpdate`（晚于全部模拟、渲染前）；
   一次性初始化放 `onStart` 不要放 `onEnable`（onEnable 可能多次触发）。
6. **事件/订阅泄漏**：`input.onXxx / ui.onClick / logic.onFsmEnter / Delegate.add`
   都返回解绑函数——`onDisable`/`onDestroy` 里必须调；`Delegate` 建议在
   onDestroy `clear()`。
7. **跨脚本 import**：运行时值 import 别的脚本会破坏单文件编译模型——组件引用
   用 `import type`（类型）+ 字段声明自动 get-or-create，或 `getComponent("类名")`
   字符串查找。
8. **编译口径**：保存时 transpileModule（ES2020）——`Array.prototype.at`、
   `??=` 以外的 ES2021+ 语法、npm import、`import.meta` 都会挂；保存报错看工作台
   诊断（scriptsStore.compileError）。
9. ** tween 重入**：同一属性两个 tween 并存互相覆盖——用 `busy` 标记或
   `tween.killAll()`/句柄 `stop()` 管理（见 ButtonPulse 的防重入写法）。
10. **castRay 双模式**：Worker 物理返回 Promise——始终 `await`（或
    `Array.isArray` 分支），别直接当数组用。
11. **dataCenter 降冷**：含函数/复杂对象的数据降冷走克隆兜底——共享可变对象请
    保持热（高频访问）或改存纯数据。
12. **运行态不落盘**：脚本对灯光/粒子/UI/组件设置的改动不回写场景文件；要持久
    化的配置放 @property 让编辑器存进节点 properties。

## 自检清单（写完脚本过一遍）

- [ ] `export default class`、类名 = 文件名、`import ... from "tve"`（无其他 import）
- [ ] 每个事件订阅都有对应解绑
- [ ] 物理写在 onFixedUpdate、相机跟在 onLateUpdate、初始化在 onStart
- [ ] 所有角度用度（angularVelocity 除外）、颜色用 0xRRGGBB 数字
- [ ] position/rotation/scale 读改写回（整体赋值）
- [ ] 未选择的可空引用（`| null = null`）都判空再访问
- [ ] 组件销毁清理：tween killAll、Delegate clear、dataCenter delete

## 验证流程

1. **保存即诊断**：脚本工作台保存 = 写盘 + 内存编译 + @property 元数据解析，
   编译错误直接显示在编辑器面板（无需跑预览）。
2. **挂节点预览**：编辑器预览面板跑起来，F3 看调试统计；
   `engine.log(...)` 输出在编辑器控制台。
3. **入册**：好用的通用脚本搬到 `public/repos/code/`，首行加
   `// @desc: 一句话描述`（工坊列表的描述来自这个注释），即成为全项目可见原型。
4. **回归**：SDK 运行时行为变更（改 src/runtime/core/tve/**）必须跑
   `pnpm test:regression:core`（P0 全绿）；生命周期时序契约在
   `smoke-script-hooks.mjs`。
