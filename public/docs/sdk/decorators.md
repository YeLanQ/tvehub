# 装饰器

声明式的属性 / 节点类型装饰器。装饰器在**保存编译时被静态解析**（不执行用户代码），检查器据此渲染控件；运行期字段值由脚本宿主注入。

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

### 选项

| 选项 | 说明 |
| --- | --- |
| `type` | 值类型；缺省按字段初值推断（见下表） |
| `label` | 检查器显示名（缺省用字段名） |
| `tooltip` | 悬浮说明（显示在控件标题） |
| `min` / `max` / `step` | number 专用：最小值/最大值/步进（检查器输入控件约束） |

### 类型推断与控件

| 字段初值 / type | 推断类型 | 检查器控件 | 脚本内类型 |
| --- | --- | --- | --- |
| `= 3` | `number` | 数值框（可加 min/max/step） | `number` |
| `= "文本"` | `string` | 文本框 | `string` |
| `= true` | `boolean` | 勾选框 | `boolean` |
| `type: "color"` | `color` | 取色器 | `#rrggbb` 颜色字符串 |
| `type: "vec3"` | `vec3` | 三个数值框 | `{ x, y, z }` |

颜色与向量**必须显式传 `type`**（字符串初值无法区分「文本」与「颜色」）。颜色值形态是 `#rrggbb` 字符串；向量是普通 `{x,y,z}` 对象，逐字段读写均可。

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

节点类型类：`Transform`（任意节点）/ `MeshNode` / `LightNode` / `CameraNode` / `SkyboxNode` / `ParticleSystemNode` / 五个 UI 节点类；小写别名（`meshNode` 等）与编辑器节点类型键一致。过滤规则按声明类的 `instanceof` 语义：`Transform` 收全部节点，`LightNode` 收各类灯光节点。

引用的解析时机是**脚本实例创建时**：被引用节点必须存在于场景里（运行期动态创建的节点不会回填到检查器引用里，请用 `engine.scene.find` 自行查找）。被引用节点被删除时字段为 `null`，使用前判空。

### 内置组件引用

`type` 传内置组件门面类（`AnimationClip` / `SkeletalAnimation` / `RigidBody` / `Collider` / `Light` / `AudioSource`），或直接以组件类作装饰器实参，即声明「引用一个内置组件」。该字段**不出现在检查器中**；运行期宿主在本实体上 get-or-create 对应组件并把门面绑定到字段：

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

「get-or-create」语义：实体上已挂该组件 → 直接绑定；没有 → 自动创建一个（用默认设置）再绑定。因此挂了本脚本的节点会**自动长出**所需的组件（例如上面的写法会让节点多出一个动画剪辑组件）。需要自定义组件初始设置时，先在检查器里手动挂组件并配置，脚本字段会绑定到它。

### 用户脚本类字段（自动挂组件）

字段声明为**用户脚本类**类型时（配合 `import type` 只引入类型，不产生运行时 import），宿主同样 get-or-create：实体已挂载该脚本组件则绑定实例，没有则动态创建并立即进入生命周期（按需自动挂载依赖组件）：

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

实现说明（帮助理解边界）：TS 类型标注编译后会被擦除，运行时无法感知——编译器在转译脚本时用自定义 transformer 扫描默认导出类，把组件类型字段收集为 `static __tveComponentKeys = [["字段名", "token"], ...]` 注入类体（内置组件 token 为组件类型键，脚本组件 token 为 `"script:类名"`），播放器实例化后据此 get-or-create。因此：

- `import type` 是关键——真实的运行时 import 反而会把脚本拆成多个模块实例，组件查找按全局类名注册表进行；
- 声明为节点类（`Transform`/`MeshNode` 等）或工具类型（`Entity`/`Vec3`…）的裸字段**不会**被当作组件引用处理；
- 循环依赖（A 的字段类型是 B、B 的字段类型是 A）允许存在：字段按需惰性创建，不会在加载期互相卡死，但运行期可能层层自动创建出一串组件，注意别成环。

### 检查器覆盖值与 this.props

- 字段初值 = 默认值；检查器里改过的值作为「覆盖值」随节点保存，实例化时覆盖默认；
- `this.props` 提供只读属性值视图（字段当前值 + 覆盖值），便于以字典方式遍历（如调试打印全部属性）；不要在该视图写入（写 `this.字段名`）。

### 旧写法：static props

静态声明 `static props = { 字段: { type, default, ... } }` 仍受支持（不执行用户代码即可解析属性），属性经 `this.props` 读取。推荐改用装饰器字段。

```ts
export default class Legacy extends Component {
  static props = {
    speed: { type: "number", default: 3, min: 0, max: 10 },
    title: { type: "string", default: "敌人" },
  };
}
```

## @nodeType

类装饰器（可选）：声明脚本类同时作为一种**可创建的节点类型**，出现在层级面板「添加节点 > 脚本节点」；创建时生成 `kind` 对应的基础节点并自动挂上本脚本组件（以脚本定义节点行为）。

```ts
import { Component, nodeType } from "tve";

@nodeType({ kind: "meshNode", label: "敌人" })
export default class Enemy extends Component {
  // ...
}
```

| 选项 | 说明 |
| --- | --- |
| `kind` | 基础节点类型：`"node"` / `"meshNode"` / `"cameraNode"` / `"lightNode"` / `"skyboxNode"` / `"particleSystemNode"` / 五个 UI 节点键；缺省 `"node"`（空组） |
| `label` | 菜单显示名，缺省取类名 |

行为细节：

- 脚本节点创建出来就是一个普通节点 + 已挂好的脚本组件，后续与手动挂载无异（可再挂其他组件、可存预制体）；
- 多个脚本声明同一 `label` 时菜单都会出现，创建互不影响；
- 脚本编译失败或被删除后，「脚本节点」子菜单不再列出该类型；已创建的节点保留组件（脚本缺失时组件只是不运行，见[脚本工作台 › 编译说明](../editor/scripting.md)）。

## 常见错误

| 现象 | 原因 / 处理 |
| --- | --- |
| 颜色/向量属性在检查器里显示为文本框 | 没写 `type: "color"` / `type: "vec3"`（初值推断不出） |
| 组件字段是 `undefined` | 类型标注缺失导致字段没被收集：补 `!` 断言或 `| null = null` |
| `import type` 写成了普通 `import` | 运行时 import 会拆模块，按类名找不到组件：改成 type-only |
| 节点引用运行期为 `null` | 检查器里没选、被引用节点已被删除、或引用的是运行期动态创建的节点 |
| 检查器不显示某字段 | 字段没加 `@property`、初值为 `undefined`、或脚本编译失败（看控制台） |

## 下一步

- [实体与查询](entity.md)：`Entity`、场景/组件查找
- [engine 入口](engine.md)：时间/输入/物理/音频等系统 API
