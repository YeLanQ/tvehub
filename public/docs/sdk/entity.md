# 实体与查询

场景在脚本运行期有两类对象：**节点**（`Entity` 及其子类，代表场景树中的一个节点）与**组件**（挂载在节点上的功能模块，`Component` 子类或内置门面）。二者 API 不同、获取方式不同、命名也不同——先读下方的「节点 vs 组件」一节区分，再分节详述。

## 节点 vs 组件（先读这一节）

### 概念

- **节点句柄**（`Entity` 子类）：场景树中的一个节点。持有变换（position/rotation/scale）、层级（parent/children）、名称/标签/层。用 `engine.scene.find` 查找，或 `@property({ type: 节点类 })` 引用。类名以 `Node` 结尾，或为 `Transform`。
- **组件门面**（`Component` 子类 / 内置门面）：挂载在节点上的功能模块（灯光、刚体、音源、动画…）。用 `entity.getComponent(组件类)` 获取，`entity.addComponent(...)` 添加。内置门面类名**不带** `Node` 后缀。

### 命名对照

| 节点句柄（`extends Entity`） | 对应组件门面 | 关系 |
| --- | --- | --- |
| `LightNode` | `Light` | 灯光节点上的灯光组件（intensity/color/阴影…） |
| —（任意节点可挂） | `RigidBody` / `Collider` | 物理组件 |
| —（音频源节点） | `AudioSource` | 音源组件 |
| —（任意节点可挂） | `AnimationClip` | 关键帧动画剪辑组件 |
| —（模型网格节点） | `SkeletalAnimation` | 骨骼动画组件 |
| `MeshNode` | — | 网格是节点本身属性，无独立组件门面 |
| `CameraNode` | — | 相机是节点本身属性 |
| `SkyboxNode` / `UICanvasNode` / `UIImageNode` / … | — | 节点本身即功能，无组件门面 |

> 规律：类名以 `Node` 结尾（或 `Transform`）= 节点句柄；去掉 `Node` 后缀 = 对应组件门面（若存在）。

### 常见误用

```ts
// ✗ 错误：LightNode 是节点句柄，不是组件——编译期报 TS2769
const light = entity.getComponent(LightNode);

// ✓ 正确：Light 是组件门面
const light = entity.getComponent(Light);      // 或 entity.getComponent("light")

// ✓ 引用灯光节点本身（变换/层级）用节点句柄类
@property({ type: LightNode }) target: LightNode | null = null;

// ✓ 运行时查找节点后用 instanceof 收窄（find 不支持泛型）
const node = engine.scene.find("Sun");
if (node instanceof LightNode) { /* node 收窄为 LightNode */ }
```

**判定法**：`getComponent` 的参数永远是**组件门面类**或**脚本组件类**（`extends Component`），绝不传节点句柄类（`extends Entity`）。

---

## 节点句柄：Entity

`Entity` 是场景节点在脚本运行期的句柄。变换与编辑器同一套语义：位置/缩放为米制，**旋转为度制欧拉角 XYZ**，前向为 **-Z**（与灯光/相机/粒子发射方向一致）。

### Entity 基类

```ts
// 属性
entity.id: string;              // 节点 id（与场景文件一致）
entity.kind: EntityKind;        // 节点类型键：node/meshNode/pointLightNode…
entity.name: string;            // 名称（可写，即时生效）
entity.tag: string;             // 标签（检查器 Node 卡设置，空串 = 无标签）
entity.layer: number;           // 渲染层级索引 0~31（可写，应用到对象子树渲染层）
entity.visible: boolean;        // 可见性（可写；含子级继承）
entity.position: Vec3;          // 本地位置（读取返回快照副本；写入接受部分字段）
entity.rotation: Vec3;          // 本地旋转（度制欧拉角；同上）
entity.scale: Vec3;             // 本地缩放（同上）
entity.worldPosition: Vec3;     // 世界位置（只读快照）
entity.parent: Entity | null;   // 父实体（根节点 null）
entity.children: Entity[];      // 子实体列表（快照）

// 方法
entity.translate(x, y, z);      // 沿本地轴平移：position += (x,y,z)
entity.rotate(xDeg, yDeg, zDeg);// 本地旋转叠加（度）：rotation += (x,y,z)
entity.lookAt(target: Vec3);    // 朝向世界坐标目标（前向 = -Z，与灯光/相机一致）
entity.find(nameOrPath: string);// 子树内查找："父/子/孙" 名称路径或单名称深度优先；未找到 null
```

### 快照语义（重要）

> `position` 等读取返回**快照副本**，修改副本不会生效；写回才生效：`entity.position = { x: 1, y: 0, z: 0 }`。

```ts
const p = entity.position;
p.x += 1;                 // ✗ 只改了副本
entity.position = p;      // ✓ 写回生效（p 是普通对象，可直接回写）

// 等价的单行写法（配合 math）：
entity.position = math.add(entity.position, math.v3(1, 0, 0));
```

**写入接受部分字段**：`entity.position = { x: 5 }` 只改 x，y/z 不动。这让「只转 Y 轴」「只抬升」这类需求免于先读后写：

```ts
entity.rotation = { y: 90 };          // 只改 Y，X/Z 保持
entity.position = { y: entity.position.y + 1 }; // 抬升 1 米
```

`children` 与 `worldPosition` 同为快照：`children` 返回当时子列表的数组副本，遍历中增删子节点不影响快照；`worldPosition` 是只读的，需要移动节点请写本地 `position`（或改父级）。

### 各字段细节

| 字段 | 可写 | 说明 |
| --- | --- | --- |
| `id` | ✗ | 节点 id，与场景文件/检查器一致；预制体实例的 id 在实例化时生成 |
| `kind` | ✗ | 节点类型键（`EntityKind`）；`instanceof` 各节点类是更类型化的判断方式 |
| `name` | ✓ | 即时生效；同名节点并存合法，路径查找取先命中者 |
| `tag` | ✗ | 只读（改标签在检查器 Node 卡操作）；脚本按标签检索见下文 |
| `layer` | ✓ | 0~31；写入应用到对象**子树**的渲染层（整棵一起换层）；配合相机/灯光 Culling Mask 使用 |
| `visible` | ✓ | 即时生效，子级继承隐藏；隐藏不参与渲染但**仍参与物理/脚本/动画** |

### 方法

| 方法 | 语义 |
| --- | --- |
| `translate(x, y, z)` | 沿**本地轴**平移（= position 逐分量累加；本地轴 = 节点自身朝向的轴） |
| `rotate(xDeg, yDeg, zDeg)` | 本地旋转叠加（度）；`rotate(0, 90*delta, 0)` 是标准的自转写法 |
| `lookAt(target)` | 朝向世界坐标目标（**前向 = -Z**，模型的"脸"应朝 -Z 建模；与灯光/相机同约定） |
| `find(nameOrPath)` | 子树内查找：`"Hand"` 深度优先找单名；`"Arm/Hand/Finger"` 按名称路径逐级找；未找到返回 `null` |

```ts
// 常见组合：追踪目标（转向 + 移动分离）
onUpdate(delta: number) {
  const target = engine.scene.find("Player");
  if (!target) return;
  const dir = math.normalize(math.projectXZ(math.sub(target.worldPosition, this.entity.worldPosition)));
  this.entity.lookAt(math.add(this.entity.worldPosition, dir));   // 朝向（可配 moveTowardsAngle 平滑）
  this.entity.position = math.moveTowards(
    this.entity.position, target.worldPosition, this.speed * delta);
}
```

### 节点类型类（Entity 子类）

以下类均 `extends Entity`，是**节点句柄**——既可作字段类型标注，也可作为值传给 `@property({ type })`。运行期字段解析为对应 kind 的 `Entity` 子类实例（`instanceof` 可判断）。**它们不是组件，不能传给 `getComponent`。**

| 类 | 对应编辑器节点 |
| --- | --- |
| `Transform` | 通用节点（可引用任意场景节点） |
| `MeshNode` | 网格节点（基元网格或模型网格） |
| `LightNode` | 灯光节点（point/directional/ambient/spot 各类） |
| `CameraNode` | 相机节点 |
| `SkyboxNode` | 天空盒节点 |
| `ParticleSystemNode` | 粒子系统节点（额外提供播放控制与发射参数读写，见下） |
| `UICanvasNode` / `UIImageNode` / `UITextNode` / `UIButtonNode` / `UILayoutNode` | UI 画布与 Widget 节点（字段见 [UI](ui.md)） |

小写别名 `transform` / `meshNode` / `lightNode` / `cameraNode` / `skyboxNode` / `particleSystemNode` / `uiCanvasNode` / `uiImageNode` / `uiTextNode` / `uiButtonNode` / `uiLayoutNode` 同样导出。

```ts
// instanceof 判别（引用声明为宽类型时收窄）
if (this.target instanceof ParticleSystemNode) {
  this.fx = this.target;          // 自动收窄，可调用粒子专有方法
}
```

### ParticleSystemNode

粒子系统实体在通用节点能力之外提供运行时控制与发射参数读写（运行态生效，不回写场景文件）：

```ts
import { Component, property, ParticleSystemNode } from "tve";

export default class Explode extends Component {
  @property({ type: ParticleSystemNode, label: "爆炸特效" })
  fx: ParticleSystemNode | null = null;

  onStart() {
    if (!this.fx) return;
    this.fx.startColor = 0xffcc33;   // 发射参数逐字段读写（同检查器字段集）
    this.fx.emissionRate = 200;
    this.fx.setSettings({ startLifetime: 0.8, gravityModifier: 1 }); // 批量合并
    this.fx.restart();               // 清空并从头开始
  }

  onUpdate() {
    if (this.fx?.finished) engine.log("特效播完，存活", this.fx.aliveCount);
  }
}
```

**播放控制方法**：

| 方法 | 语义 |
| --- | --- |
| `play()` | 暂停态续播；停止/播完态从头开始 |
| `pause()` | 暂停（保留当前粒子） |
| `stop()` | 停止发射，存活粒子自然消亡 |
| `restart()` | 清空粒子并从头开始（预热系统下一帧快进一个周期） |
| `clear()` | 立即清空全部粒子（不改变播放态） |
| `setSettings(patch)` | 批量合并发射设置（子集；`maxParticles`/`blending` 变化会重建发射器，粒子从头开始） |

**只读状态**：`playing` / `paused` / `finished`（非循环系统已发射完毕且粒子全部消亡）/ `aliveCount` / `settings`（发射设置快照，未绑定 null）。

**可写发射字段**（与检查器 Particle System 卡同一字段集）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `duration` | number | 发射周期（秒）；非循环系统发射持续该时长后停止 |
| `looping` | boolean | 循环发射 |
| `prewarm` | boolean | 预热（仅循环系统）：重启时快进一个周期 |
| `startDelay` | number | 起始延迟（秒） |
| `startLifetime` | number | 粒子寿命（秒） |
| `startSpeed` | number | 初速度（单位/秒） |
| `startSize` | number | 初始直径（世界单位） |
| `startColor` / `endColor` | number | 初始/终点颜色（0xRRGGBB；colorOverLifetime 开启时插值） |
| `gravityModifier` | number | 重力系数（1 = 标准重力；0 = 无重力；负值上浮） |
| `emissionRate` | number | 发射速率（粒子/秒） |
| `maxParticles` | number | 同时存活上限（**改动会重建发射器**） |
| `shape` | `"cone" \| "sphere" \| "hemisphere" \| "box"` | 发射形状（cone/box 沿本地 -Z） |
| `shapeRadius` | number | 形状半径（圆锥底圆 / 球 / 盒半边长） |
| `shapeAngle` | number | 圆锥半角（度；仅 cone） |
| `simulationSpace` | `"local" \| "world"` | 模拟空间（切换会清空当前粒子） |
| `colorOverLifetime` / `sizeOverLifetime` | boolean | 颜色/尺寸随寿命变化开关 |
| `blending` | `"additive" \| "normal"` | 混合模式（**改动会重建发射器**） |
| `texture` | string | 粒子贴图（图片资产相对路径；空串 = 内置软圆点；运行态异步加载后热替换，只能引用已随构建打包的图片） |

## 场景查询：engine.scene

```ts
engine.scene.root;                 // 根实体（空场景 null）
engine.scene.find("Boss/Hand");    // 从根开始按名称/路径查找（语义同 Entity.find）
engine.scene.findAll();            // 全部实体（快照数组，文档序）
engine.scene.findByTag("enemy");   // 按标签查第一个命中；无命中 null
engine.scene.findAllByTag("enemy");// 按标签全量（文档序）
```

- 「文档序」= 场景树的深度优先顺序（与层级面板从上到下一致）；
- 标签在检查器 Node 卡设置（项目设置 › 标签与层 维护列表；节点上存储但不在列表中的标签原样保留），空串 = 无标签；
- 查询是**每帧可重复调用**的轻量操作，但结果应缓存使用（如 `onStart` 里查一次存字段），避免每帧全树遍历；
- `find` 返回 `Entity | null`，需要具体节点类型时用 `instanceof` 收窄（不支持泛型调用）。

---

## 组件门面与组件查找

### 内置组件门面类

以下类是**组件门面**，通过 `getComponent` / `addComponent` / 组件字段声明获得，脚本不要直接 `new`。每个门面均有 `entity`（宿主实体）与 `id`（组件引用 id）只读属性。完整 API 见[内置组件门面](components.md)。

| 门面 | 对应编辑器组件 | 获取方式 | 运行时创建 |
| --- | --- | --- | --- |
| `RigidBody` | 刚体 | `getComponent(RigidBody)` | ✗（返回 null） |
| `Collider` | 碰撞体（可多） | `getComponent(Collider)` | ✗（返回 null） |
| `Light` | 灯光 | `getComponent(Light)` | ✓（多实例追加） |
| `AudioSource` | 音源 | `getComponent(AudioSource)` | ✓（多实例追加） |
| `AnimationClip` | 动画剪辑 | `getComponent(AnimationClip)` | ✓（多实例追加） |
| `SkeletalAnimation` | Animation 卡（模型内嵌） | `getComponent(SkeletalAnimation)` | ✓（仅模型网格节点） |

**脚本组件**：继承 `Component` 的自定义类（见[组件与装饰器](decorators.md)），同样通过 `getComponent(脚本类)` 获取。

### getComponent

```ts
// 内置组件：传门面类或类型键字符串
const rb = entity.getComponent(RigidBody);      // 或 "rigidBody"
const light = entity.getComponent("light");
const anim = entity.getComponent("anim");       // "animation"/"anim" 为骨骼动画别名
// 未挂载返回 null；多实例组件（如多个动画剪辑）取首个，句柄稳定

// 脚本组件：传脚本类 / 源路径 / 类名字符串
const hp = entity.getComponent(HPBar);
const hp2 = entity.getComponent("src/hp.ts");
const hp3 = entity.getComponent("HPBar");
```

token 对照：

| token 形态 | 内置组件 | 脚本组件 |
| --- | --- | --- |
| 门面类 / 脚本类 | `entity.getComponent(RigidBody)` | `entity.getComponent(HPBar)`（构造器匹配） |
| 类型键字符串 | `"rigidBody"` / `"collider"` / `"light"` / `"audioSource"` / `"animationClip"` / `"animation"`(`"anim"`) | `entity.getComponent("src/hp.ts")`（源路径）或 `"HPBar"`（类名） |

脚本类在加载后**全局可见**，脚本之间互相引用组件无需 import 运行时——严格模式下用 `import type` 只引入类型即可获得智能提示（按类型名查找）。

> **不要传节点句柄类**：`getComponent(LightNode)` / `getComponent(MeshNode)` 等会编译报错（TS2769）。节点句柄类（`extends Entity`）代表节点本身，不是组件；灯光属性用 `getComponent(Light)`，引用节点用 `@property({ type: LightNode })` 或 `engine.scene.find` + `instanceof`。

### 全场景组件查找

```ts
engine.scene.findComponent(HPBar);    // 文档序第一个命中（未命中 null）
engine.scene.findComponents("enemy"); // 文档序全量（未命中空数组）
// token：脚本类 / 脚本源路径 / 脚本类名 / 内置组件门面类 / 类型键
```

### 动态添加组件：addComponent

```ts
// 内置组件（多实例）：追加一个新组件，settings 缺省项回默认
entity.addComponent("light", { kind: "point", intensity: 2, color: 0xffdd88 });
entity.addComponent("audioSource", { source: "assets/audio/bgm.mp3", autoplay: true, loop: true });
entity.addComponent("animationClip", { clip: "assets/anims/idle.anim", autoplay: true });
entity.addComponent("animation", { graph: myGraphDef }); // 仅模型网格节点

// 脚本组件：传脚本类 / 源路径 / 类名；props 为属性配置
entity.addComponent(HPBar, { max: 100 });
entity.addComponent("src/hp.ts", { max: 100 });

// RigidBody / Collider：物理组件仅启动期按场景数据构建，运行时创建返回 null
```

各内置组件的完整创建参数见[内置组件门面 › addComponent 创建参数速查](components.md)。

行为约定：

- 预览运行态添加的组件**不回写场景文件**；
- 创建的脚本组件**立即进入生命周期**（`onEnable` → `onStart`），并进入每帧 `onUpdate` 队列（执行顺序排末尾）；
- `Light` / `AudioSource` / `AnimationClip` 为多实例追加；`SkeletalAnimation` 仅模型网格节点可用；物理组件不支持运行时创建（返回 `null`）。

---

## 运行态 vs 持久化（哪些写入会保存）

| 写入 | 落盘到场景文件？ |
| --- | --- |
| `entity.position/rotation/scale/name/visible/layer`（编辑器视口内） | ✓（走编辑器撤销历史） |
| 预览/运行产物内的任何 Entity 写入 | ✗（纯运行态） |
| 粒子 `setSettings` / UI `engine.ui.set` / 音频 `setVolume` | ✗（运行态约定） |
| `addComponent` 动态添加的组件 | ✗ |

预览停机即全部还原；需要跨局保留的数据用 `DataCenter`（同样不持久化，见[通用设施](utils.md)）。

## 下一步

- [engine 入口](engine.md)：时间/输入/物理/音频等系统 API
- [内置组件门面](components.md)：刚体、灯光、音源、动画等组件 API
