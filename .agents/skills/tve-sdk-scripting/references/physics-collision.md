# 单元：物理（刚体 / 碰撞回调 / 冲量 / 射线）

## 契约（速查）

前提：**项目设置启用物理**，节点在编辑器挂 RigidBody/Collider 组件（物理组件
仅启动期按场景数据构建，运行时 addComponent 返回 null）。刚体形态：
static / kinematic / dynamic。

`engine.physics: PhysicsApi`（按实体寻址）：`applyImpulse(e,x,y,z)`（N·s）、
`applyForce`（N，每帧调）、`setLinearVelocity / setAngularVelocity(rad/s)`、
`getLinearVelocity → Vec3|null`、`setGravityScale(e,scale)`、`wakeUp(e)`、
`setGravity(x,y,z)`、`castRay({origin,direction,maxDistance?,allHits?,excludeNodeIds?})
→ PhysicsRayHit[] | Promise<[]>`（命中 {nodeId,point,normal,distance}，按距离升序；
Worker 模式返回 Promise——统一 `await`）。
`RigidBody` 门面：`mode/gravityScale/setLinearVelocity/applyImpulse/wakeUp`。
碰撞回调（Component 钩子）：`onCollisionEnter(other: Entity)` / `onCollisionExit`，
在 onUpdate 前调用；传感器（isSensor）同样触发。

## 模板：碰撞反弹（接触跟踪 + 冷却防连击）

`public/repos/code/CollisionBounce.ts` 骨架：

```ts
import { Component, property, engine, Entity } from "tve";

export default class CollisionBounce extends Component {
  @property({ label: "冲量强度（0 = 不弹开）", min: 0, step: 0.5 })
  bounce = 5;
  @property({ label: "弹开冷却（秒）", min: 0, step: 0.1 })
  cooldown = 0.5;

  private touching = new Set<string>();
  private lastBounceAt = -1e9;

  onCollisionEnter(other: Entity) {
    this.touching.add(other.id);                       // 接触状态跟踪
    if (engine.time.elapsed - this.lastBounceAt >= this.cooldown) {
      this.lastBounceAt = engine.time.elapsed;
      // 沿"我→对方"水平方向弹开（动力学体才会被推动）
      const dir = math.normalize(math.projectXZ(
        math.sub(other.worldPosition, this.entity.worldPosition)));
      engine.physics.applyImpulse(other, dir.x * this.bounce, 2, dir.z * this.bounce);
    }
  }
  onCollisionExit(other: Entity) { this.touching.delete(other.id); }
}
```

## 模板：屏幕点击射线拾取（相机反投影 + castRay）

`public/repos/code/CameraRaycastPick.ts` 骨架：

```ts
import { Component, property, engine, CameraNode } from "tve";

export default class CameraRaycastPick extends Component {
  @property({ type: CameraNode, label: "相机节点" })
  camera: CameraNode | null = null;

  onEnable() {
    this.offClick = engine.input.onPointerDown((p) => { void this.pick(p.x, p.y); });
  }
  onDisable() { this.offClick?.(); }                   // 订阅必须解绑

  private async pick(screenX: number, screenY: number) {
    const ray = this.camera?.screenToRay(screenX, screenY);   // CSS 像素 → 世界射线
    if (!ray) return;
    const result = engine.physics.castRay({
      origin: ray.origin, direction: ray.direction,
      maxDistance: 100, excludeNodeIds: [this.entity.id],
    });
    const hits = Array.isArray(result) ? result : await result;  // 双模式统一 await
    if (hits.length > 0) engine.log("命中：", engine.scene.find(hits[0].nodeId)?.name);
  }
}
```

## 模板：贴地（地形采样）

```ts
// @property({ type: TerrainNode, label: "地形" }) ground: TerrainNode | null = null;
onUpdate() {
  const p = this.entity.position;
  if (this.ground) p.y = this.ground.sampleHeight(p.x, p.z);   // 本地 x/z 采样
  // 撒放可用性：sampleSlope(x,z) ∈ 0..1（1=平地），低于阈值不放
}
```

## 测试例

- 工坊示例：`CollisionBounce.ts`、`CameraRaycastPick.ts`、`RaycastDetector.ts`。
- 回归：`smoke-physics-runtime.mjs`（worker 步进）、`smoke-physics-pick.mjs`（P0）。
