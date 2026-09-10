# 实体与查询

`Entity` 是场景节点在脚本运行期的句柄。变换与编辑器同一套语义：位置/缩放为米制，**旋转为度制欧拉角 XYZ**。

## Entity

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

> 注意：`position` 等读取返回快照副本，修改副本不会生效；写回才生效：`entity.position = { x: 1, y: 0, z: 0 }`。

## 节点类型引用类

既可作字段类型标注，也可作为值传给 `@property({ type })`。运行期字段解析为对应 kind 的 `Entity` 子类实例（`instanceof` 可判断）：

| 类 | 对应编辑器节点 |
| --- | --- |
| `Transform` | 通用节点（可引用任意场景节点） |
| `MeshNode` | 网格节点（基元网格或模型网格） |
| `LightNode` | 灯光节点（point/directional/ambient/spot 各类） |
| `CameraNode` | 相机节点 |
| `SkyboxNode` | 天空盒节点 |
| `ParticleSystemNode` | 粒子系统节点（额外提供播放控制与发射参数读写，见下） |

小写别名 `transform` / `meshNode` / `lightNode` / `cameraNode` / `skyboxNode` / `particleSystemNode` 同样导出。

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

方法：`play()`（暂停态续播 / 停止、播完态从头开始）、`pause()`、`stop()`（停止发射，粒子自然消亡）、`restart()`、`clear()`、`setSettings(patch)`；只读：`playing` / `paused` / `finished` / `aliveCount` / `settings`。可写字段：`duration` `looping` `prewarm` `startDelay` `startLifetime` `startSpeed` `startSize` `startColor` `endColor` `gravityModifier` `emissionRate` `maxParticles` `shape` `shapeRadius` `shapeAngle` `simulationSpace` `colorOverLifetime` `sizeOverLifetime` `blending` `texture`（图片资产相对路径，空串 = 内置软圆点；运行态异步加载后热替换，只能引用已随构建打包的图片）。改 `maxParticles` / `blending` 会重建发射器（粒子从头开始）。

## 场景查询：engine.scene

```ts
engine.scene.root;                 // 根实体（空场景 null）
engine.scene.find("Boss/Hand");    // 从根开始按名称/路径查找（语义同 Entity.find）
engine.scene.findAll();            // 全部实体（快照数组）
engine.scene.findByTag("enemy");   // 按标签查第一个命中；无命中 null
engine.scene.findAllByTag("enemy");// 按标签全量（文档序）
```

## 组件查找：getComponent

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

脚本类在加载后全局可见，脚本之间互相引用组件无需 import 运行时——严格模式下用 `import type` 只引入类型即可获得智能提示（对齐 Unity 按类型名查找）。

## 全场景组件查找

```ts
engine.scene.findComponent(HPBar);    // 文档序第一个命中（未命中 null）
engine.scene.findComponents("enemy"); // 文档序全量（未命中空数组）
// token：脚本类 / 脚本源路径 / 脚本类名 / 内置组件门面类 / 类型键
```

## 动态添加组件：addComponent

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

预览运行态添加的组件不回写场景文件。创建的脚本组件立即进入生命周期（`onEnable` → `onStart`），并进入每帧 `onUpdate` 队列（执行顺序排末尾）。
