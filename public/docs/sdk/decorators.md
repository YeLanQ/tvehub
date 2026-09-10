# 装饰器

参考 Cocos Creator `@property` / `@ccclass` 的声明式写法。

## @property

把成员字段声明为脚本组件的可编辑属性，检查器自动按字段类型渲染控件，字段初值即默认值，运行期直接以 `this.字段名` 读写。

```ts
export default class Enemy extends Component {
  @property({ label: "速度", min: 0, max: 10, step: 0.1 })
  speed = 3;

  @property({ type: "color", label: "提示色" })
  tint = "#ff8800";

  @property({ type: "vec3", label: "偏移" })
  offset = { x: 0, y: 1, z: 0 };
}
```

选项：

| 选项 | 说明 |
| --- | --- |
| `type` | 值类型；缺省按字段初值推断 |
| `label` | 检查器显示名（缺省用字段名） |
| `tooltip` | 悬浮说明（显示在控件标题） |
| `min` / `max` / `step` | number 专用：最小值/最大值/步进 |

基本类型：`number` / `string` / `boolean` / `color`（`#rrggbb` 等颜色字符串）/ `vec3`（`{x,y,z}`）。颜色与向量需显式传 `type`。

### 场景节点引用

`type` 传节点类型类即声明「引用一个场景节点」。检查器按类型过滤列出可选节点，运行期字段解析为该节点的 `Entity`（未选择为 `null`）：

```ts
import { Component, property, MeshNode } from "tve";

export default class Game extends Component {
  @property({ type: MeshNode, label: "目标网格" })
  target: MeshNode | null = null;

  onUpdate(delta: number) {
    if (this.target) this.target.rotate(0, 90 * delta, 0);
  }
}
```

节点类型类：`Transform`（任意节点）/ `MeshNode` / `LightNode` / `CameraNode` / `SkyboxNode`；小写别名（`meshNode` 等）与编辑器节点类型键一致。

### 内置组件引用

`type` 传内置组件门面类（`AnimationClip` / `SkeletalAnimation` / `RigidBody` / `Collider` / `Light` / `AudioSource`），或直接以组件类作装饰器实参，即声明「引用一个内置组件」。该字段不出现在检查器中；运行期宿主在本实体上 get-or-create 对应组件并把门面绑定到字段：

```ts
import { Component, property, AnimationClip } from "tve";

export default class Punch extends Component {
  @property(AnimationClip)
  anim!: AnimationClip;

  onStart() {
    this.anim.speed = 2;
    this.anim.play();
  }
}
```

### 用户脚本类字段（自动挂组件）

字段声明为**用户脚本类**类型时（配合 `import type` 只引入类型，不产生运行时 import），宿主同样 get-or-create：实体已挂载该脚本组件则绑定实例，没有则动态创建并立即进入生命周期（对齐 Unity RequireComponent）：

```ts
import type CameraFollow from "./CameraFollow"; // type-only：编译期擦除

export default class Enemy extends Component {
  follow!: CameraFollow; // 自动绑定/创建本实体上的 CameraFollow 组件

  onStart() {
    this.follow.offset = math.v3(0, 3, 5);
  }
}
```

裸声明须带确定类型标注（`!` 断言或 `| null = null` 初值）。

### 旧写法：static props

静态声明 `static props = { 字段: { type, default, ... } }` 仍受支持（不执行用户代码即可解析属性），属性经 `this.props` 读取。推荐改用装饰器字段。

## @nodeType

类装饰器（可选）：声明脚本类同时作为一种**可创建的节点类型**，出现在层级面板「添加节点 > 脚本节点」；创建时生成 `kind` 对应的基础节点并自动挂上本脚本组件（类似 Unity 中以脚本定义 GameObject 行为）。

```ts
import { Component, nodeType } from "tve";

@nodeType({ kind: "meshNode", label: "敌人" })
export default class Enemy extends Component {
  // ...
}
```

- `kind`：基础节点类型，`"node" | "meshNode" | "cameraNode" | "lightNode" | "skyboxNode"`，缺省 `"node"`（空组）；
- `label`：菜单显示名，缺省取类名。
