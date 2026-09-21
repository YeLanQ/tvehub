# 单元：输入驱动移动（键盘 / 指针 / 摇杆）

## 契约（速查）

`engine.input: InputApi`：`isKeyDown(code)`（KeyboardEvent.code，如 "KeyW"/"Space"/
"ArrowLeft"）、`keys`（Set）、`onKeyDown/onKeyUp(handler) → 解绑函数`；
指针：`pointer`（主指针 {x,y,down,pointerId}，坐标 = 画布内 CSS 像素）、
`pointers`（多点触控 Map）、`getPointer(id)`、`onPointerDown/Up/Cancel/Move`。
模拟量滤抖：`math.deadZone(v, deadZone)`。移动基元：`entity.translate(x,y,z)`
（本地轴）、`math.moveTowards(a,b,maxDelta)`（匀速）、`math.moveTowardsAngle`
（平滑转身，度）。

## 模板：WASD 移动（自动适配刚体：物理/位移双方案）

`public/repos/code/WASDMove.ts` 全文即权威模板，骨架如下：

```ts
import { Component, property, engine } from "tve";

export default class WASDMove extends Component {
  @property({ label: "移动速度（米/秒）", min: 0 })
  speed = 6;

  private scheme: "physics" | "kinematic" = "kinematic";   // onStart 探测
  private moveX = 0; private moveY = 0; private moveZ = 0; // 意图缓存

  onStart() {
    const rb = this.entity.getComponent("rigidBody");
    if (rb && rb.mode === "dynamic") this.scheme = "physics";
  }

  onUpdate(_delta: number) {
    const input = engine.input;                             // 只读键，缓存意图
    this.moveX = (input.isKeyDown("KeyD") ? 1 : 0) - (input.isKeyDown("KeyA") ? 1 : 0);
    this.moveZ = (input.isKeyDown("KeyS") ? 1 : 0) - (input.isKeyDown("KeyW") ? 1 : 0);
    if (this.scheme !== "physics") this.entity.translate(this.moveX, 0, this.moveZ);
  }

  onFixedUpdate(_fixedDelta: number) {                      // 物理写量放固定步长
    if (this.scheme !== "physics") return;
    engine.physics.setLinearVelocity(this.entity,
      this.moveX * this.speed, 0, this.moveZ * this.speed);
  }
}
```

**分工口诀**：动力学体 → onFixedUpdate 写速度（碰撞由引擎解算）；无刚体/运动学 →
onUpdate 直接 translate（平滑但不被阻挡）。

## 模板：平滑转身 + 匀速逼近（追逐/导向）

```ts
import { Component, property, math } from "tve";

export default class Chaser extends Component {
  @property({ type: Transform, label: "目标" })   // import { Transform } from "tve"
  target: Transform | null = null;
  @property({ label: "转速（度/秒）", min: 0 }) turn = 180;

  onUpdate(delta: number) {
    if (!this.target) return;
    const me = this.entity.worldPosition, it = this.target.worldPosition;
    // 水平面朝向：atan2 求目标角（度），moveTowardsAngle 沿最短路径转身
    const want = math.radToDeg(Math.atan2(-(it.x - me.x), -(it.z - me.z)));
    this.entity.rotation = {
      y: math.moveTowardsAngle(this.entity.rotation.y, want, this.turn * delta),
    };
    // 匀速逼近（到点即停，不抖动）
    this.entity.position = math.moveTowards(this.entity.position, it, 3 * delta);
  }
}
```

## 模板：指针 / 虚拟摇杆

```ts
// 单指针拖拽：onPointerDown 记 id，Move 里 getPointer(id) 跟踪，Up 释放
private activeId: number | null = null;
onEnable() {
  this.offDown = engine.input.onPointerDown((p) => { this.activeId = p.pointerId; });
  this.offUp = engine.input.onPointerUp(() => { this.activeId = null; });
}
onDisable() { this.offDown?.(); this.offUp?.(); }        // 订阅必须解绑
// 摇杆读数：joy.x/joy.y ∈ -1..1 → 先过 math.deadZone(v, 0.15) 再驱动
```

完整摇杆脚本：`public/repos/code/VirtualJoystick.ts`（DataCenter 存摇杆状态）。

## 测试例

- 工坊示例：`WASDMove.ts`、`CharacterController.ts`、`VirtualJoystick.ts`。
- 输入运行时回归：`scripts/smoke/tracker/smoke-input-runtime.mjs`（P0，键鼠状态机）。
