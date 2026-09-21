# 单元：tve SDK —— Component / Entity / 节点类 / 内置组件

## 契约

**Component 基类**：`constructor(entity: Entity)`；生命周期钩子（全部可选）：

| 钩子 | 时机 |
|---|---|
| `onEnable` / `onDisable` | 激活态变化 |
| `onStart` | 首次 update 前（一次） |
| `onGraphInput(value)` | 图逻辑写入（graph 行为驱动） |
| `onUpdate(delta)` | 每帧可变步长 |
| `onFixedUpdate(fixedDelta)` | 固定步长 1/60s（累积驱动 0..n 次，掉帧补偿上限 4；与物理同频，确定性逻辑写这里） |
| `onLateUpdate(delta)` | 全部模拟后、相机回填前（相机跟随写这里） |
| `onCollisionEnter(other)` / `onCollisionExit(other)` | 物理碰撞（需双方挂碰撞体 + 项目启用物理） |
| `onDestroy` | 销毁 |

**Entity**：`translate/rotate(度)/lookAt(Vec3)/find(nameOrPath)/getComponent(token)/
addComponent(cls, settings?)/tag/id/name/position/rotation/scale`。

**派生节点类**（`Entity` 语义子类，含小写别名导出）：`Transform, MeshNode, LightNode,
CameraNode(screenToRay), SkyboxNode, FogNode, ParticleSystemNode(play/pause/stop/
restart/clear/setSettings(patch)), TerrainNode(sampleHeight/sampleSlope),
FsmRunnerNode, BtRunnerNode, UICanvasNode, UIImageNode, UITextNode, UIButtonNode,
UILayoutNode`。节点类型键枚举 `EntityKind`（tve.d.ts:29，20 种）。

**内置组件门面**（getComponent/addComponent/@property 引用可用）：
`RigidBody, Collider, Light, AudioSource, AnimationClip, SkeletalAnimation`。

## 使用例

`public/repos/code/CollisionBounce.ts`（碰撞回调 + 冲量）：

```ts
onCollisionEnter(other: Entity) {
  this.touching.add(other.id);
  this.tryBounce(other);            // engine.physics.applyImpulse 弹开对方
}
```

`public/repos/code/CharacterController.ts`（输入驱动位移）、`CameraFollow.ts`
（onLateUpdate 相机跟随）。查 API 细节：`public/docs/sdk/api.md`（自动生成）。

## 测试例

真实测试例：`scripts/smoke/tracker/smoke-script-hooks.mjs`——钩子时序断言
（fixedUpdate 先于 update、lateUpdate 收尾、异常隔离）。物理回调链路由
`smoke-physics-runtime.mjs` 覆盖（worker 步进 + 射线）。

**注意分工**：src/runtime 不进 vitest（vitest.config exclude），SDK 行为回归一律
写 smoke 套件（新增方法 → 对应 P0 套件补导出面断言，见 `tve-unit-testing` 技能
smoke-boundary.md；`smoke-runtime-modules.mjs` 会核对每个模块的导出面）。
