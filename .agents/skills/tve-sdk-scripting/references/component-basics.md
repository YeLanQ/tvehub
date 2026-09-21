# 单元：组件骨架 / 属性 / 实体变换

## 契约（速查）

`Component`：`readonly entity: Entity`、`readonly props`（只读属性值视图）、
生命周期钩子全部可选。`Entity`：`id/kind/tag/layer/visible/name(可写)`、
`position/rotation(度)/scale`（读返回快照副本，写接受部分字段 `{x: 5}`）、
`worldPosition`(只读)、`parent/children`、`translate(x,y,z)`、`rotate(xDeg,yDeg,zDeg)`、
`lookAt(worldVec3)`（前向 = -Z）、`find("父/子")`、
`getComponent(类|键)`、`addComponent(类, settings?)`。

## 模板：最小组件（装饰器声明式写法）

```ts
// @desc: 绕 Y 轴匀速自转（速度可调；onUpdate 每帧驱动）
import { Component, property } from "tve";

export default class Rotator extends Component {
  @property({ label: "速度（度/秒）", min: 0 })
  speed = 90;

  onUpdate(delta: number) {
    this.entity.rotate(0, this.speed * delta, 0);  // 帧率无关：速率 × 帧间隔
  }
}
```

## 模板：属性的三种写法

```ts
import { Component, property, nodeType, Transform, MeshNode, AnimationClip } from "tve";

@nodeType({ kind: "meshNode", label: "敌人" })   // 可选：声明为可创建节点类型
export default class Enemy extends Component {
  // ① 基本属性：类型由初值推断（number/boolean/string；颜色/向量须显式 type）
  @property({ label: "血量", min: 0, max: 100, step: 1 })
  hp = 100;

  @property({ type: "color", label: "受击闪白" })
  flashColor = 0xff4444;

  // ② 场景节点引用：检查器按类型列节点，运行期解析为该节点的 Entity 子类
  @property({ type: MeshNode, label: "巡逻目标" })
  target: MeshNode | null = null;

  // ③ 内置组件引用：不出现在检查器；运行期在本实体 get-or-create 并绑定门面
  @property(AnimationClip)
  anim!: AnimationClip;          // 裸声明须带 `!` 或 `| null = null`（strict）

  onStart() {
    this.anim.speed = 2;
    this.anim.play();
    if (this.target) this.target.rotate(0, 10, 0);
    // 无装饰器的私有字段不在检查器显示（如 CameraFollow.offsetVec）
  }
}
```

## 模板：实体树操作

```ts
import { Component, engine, math } from "tve";

export default class Spawner extends Component {
  onStart() {
    // 名称路径查找（未找到 null）；全局查询用 engine.scene.find/findByTag/findAll
    const muzzle = this.entity.find("炮塔/枪口");
    // 变换：读是快照副本，改要整体写回；写接受部分字段
    const p = this.entity.position;
    p.y += 1;
    this.entity.position = p;
    this.entity.position = { x: 0 };             // 部分写：只改 x
    this.entity.lookAt(math.add(this.entity.worldPosition, math.forward));
    this.entity.name = "Boss";                    // 即时生效
    for (const child of this.entity.children) child.visible = false;
  }
}
```

## 测试例

- 工坊示例：`public/repos/code/Rotator.ts`（本模板源）、`LookAtTarget.ts`。
- 验证：项目内新建脚本 → 挂节点 → 预览（F3 看帧率），改检查器属性确认热生效。
- 生命周期时序回归：`scripts/smoke/tracker/smoke-script-hooks.mjs`
  （onEnable→onStart→fixed/update/late 顺序、错误隔离）。
