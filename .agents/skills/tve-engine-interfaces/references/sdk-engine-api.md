# 单元：tve SDK —— engine.* 运行时 API

## 契约

唯一事实源 `src/framework/scripting/tve.d.ts`（2261 行）；运行时实现镜像
`src/runtime/core/tve.ts` → `public/engine/core/tve.mjs`（VERSION "1.3.0"）。
用户脚本固定导入：`import { Component, property, nodeType, engine } from "tve"`。
设计约束：全部引擎自有类型（Vec3 普通对象、旋转用**度**），不暴露任何 three.js。

`engine: EngineApi` 各域：

| 域 | 要点 |
|---|---|
| `engine.time` | TimeState（dt 累计/帧信息） |
| `engine.input` | InputApi（键鼠状态） |
| `engine.scene` | `find(nameOrPath)/findAll/findByTag/findAllByTag/findComponent/findComponents` |
| `engine.animation` | AnimationApi |
| `engine.audio` | AudioApi |
| `engine.particles` | ParticlesApi |
| `engine.physics` | `applyImpulse/applyForce/setLinearVelocity/setGravityScale/wakeUp/setGravity/castRay({origin,direction,maxDistance,allHits,excludeNodeIds}) → PhysicsRayHit[]|Promise` |
| `engine.ui` | `set/get/onClick/rectOf/metricsOf/screenToUi`（UI 画布叠加） |
| `engine.logic` | LogicApi（FSM/BT 黑板与状态） |
| `engine.tween` | TweenApi（见 sdk-utils.md） |
| `engine.log/warn/error(...args)` | 日志（postLog 转发回编辑器控制台） |

**自动生成文档**：`pnpm gen:api-docs` 由 tve.d.ts 生成 `public/docs/sdk/api.md`
（scripts/gen-api-docs.mjs）——改 API 后重跑，文档**不要手改**。

## 使用例

`public/repos/code/Rotator.ts`（最简范式：property + onUpdate）：

```ts
import { Component, property } from "tve";
export default class Rotator extends Component {
  @property({ label: "速度（度/秒）", min: 0 })
  speed = 90;
  onUpdate(delta: number) {
    this.entity.rotate(0, this.speed * delta, 0);   // 帧率无关匀速旋转
  }
}
```

`public/repos/code/CameraRaycastPick.ts`（物理射线拾取）、`ParticleBurst.ts`
（粒子 play/restart）、`VirtualJoystick.ts`（input）——工坊 code 分类即官方示例集，
新 API 的使用例优先补到那里（描述写首部 `// @desc:`）。

## 测试例

生命周期驱动与时序的真实测试例：
`scripts/smoke/tracker/smoke-script-hooks.mjs`——写入 shim 模块
`export { Component } from <tve.mjs>` 加载脚本编译产物，断言 fixedUpdate/update/
lateUpdate 驱动顺序、1/60 固定步长与掉帧补偿、错误隔离（一个脚本抛错不拖垮其它）。

运行前提：`public/engine` 产物已生成（`pnpm build` 或起过一次 dev）；smoke 用
harness 的 `coreURL("tve.mjs")` 直连产物，路径见 build-assets.md。
