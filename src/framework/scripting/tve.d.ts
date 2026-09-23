// ---------------------------------------------------------------------------
// tve —— 引擎脚本 SDK 类型契约（模块说明符 "tve"）。
//
// 用户脚本以 `import { Component, property, nodeType, engine } from "tve"`
// 访问引擎能力。本文件是脚本类型的唯一事实源：编辑器（Monaco 智能提示 /
// 诊断）直接加载本文件，运行时实现在 public/engine/core/tve.mjs
// （播放器侧；两者保持镜像同步）。
// 对外 API 参考文档 public/docs/sdk/api.md 由本文件自动生成
// （pnpm gen:api-docs），改 API 后重跑即可，文档本身不要手改。
//
// 设计约束：全部为引擎自有类型（Vec3 普通对象、度制欧拉角，与编辑器数据模型
// 一致），不暴露任何 three.js / WebGL 接口。
// ---------------------------------------------------------------------------

/** 三维向量（引擎自有类型；旋转型 Vec3 使用"度"为单位） */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 组件属性类型（检查器按此渲染编辑控件；也可由字段初值/类型推断） */
export type PropType = "number" | "string" | "boolean" | "color" | "vec3";

/**
 * 场景节点类型键（与编辑器节点序列化的 type 字段一致）。
 * 脚本节点引用属性（type 用节点类）按此过滤候选场景节点。
 */
export type EntityKind =
  | "node"
  | "meshNode"
  | "cameraNode"
  | "lightNode"
  | "pointLightNode"
  | "directionalLightNode"
  | "ambientLightNode"
  | "spotLightNode"
  | "skyboxNode"
  | "fogNode"
  | "audioNode"
  | "particleSystemNode"
  | "terrainNode"
  | "fsmRunnerNode"
  | "btRunnerNode"
  | "uiCanvasNode"
  | "uiImageNode"
  | "uiTextNode"
  | "uiButtonNode"
  | "uiLayoutNode";

/** 节点类型 token 类的构造器形状（@property 的 type 选项可用） */
export type NodeClass =
  | typeof Transform
  | typeof MeshNode
  | typeof LightNode
  | typeof CameraNode
  | typeof SkyboxNode
  | typeof FogNode
  | typeof ParticleSystemNode
  | typeof TerrainNode
  | typeof FsmRunnerNode
  | typeof BtRunnerNode
  | typeof UICanvasNode
  | typeof UIImageNode
  | typeof UITextNode
  | typeof UIButtonNode
  | typeof UILayoutNode;

/** 内置组件门面类（@property 组件引用字段 / getComponent / addComponent 可用） */
export type ComponentClass =
  | typeof RigidBody
  | typeof Collider
  | typeof Light
  | typeof AudioSource
  | typeof AnimationClip
  | typeof SkeletalAnimation;

/** 单个组件属性的定义（运行时组件声明用；编辑器侧另有同名 AST 结构） */
export interface PropDef {
  type: PropType | string;
  default: number | string | boolean | Vec3;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
}

/** 脚本声明的可创建节点类型基础（对应编辑器节点类型键） */
export type ScriptNodeKind =
  | "node"
  | "meshNode"
  | "cameraNode"
  | "lightNode"
  | "skyboxNode"
  | "fogNode"
  | "particleSystemNode"
  | "terrainNode"
  | "uiCanvasNode"
  | "uiImageNode"
  | "uiTextNode"
  | "uiButtonNode"
  | "uiLayoutNode";

// ---------------------------------------------------------------------------
// 装饰器（@property / @nodeType 声明式写法）
// ---------------------------------------------------------------------------

/**
 * 属性装饰器：把成员字段声明为脚本组件的可编辑属性（检查器自动按字段类型
 * 渲染控件；字段初值即默认值；运行期直接以 `this.字段名` 读写）。
 *
 * 类型由字段初值推断：number / boolean / string；颜色字符串（#rrggbb 等）与
 * {x,y,z} 向量对象需显式传 type 或声明对应类型。
 *
 * **场景节点引用**：type 传节点类型类（Transform / MeshNode / LightNode /
 * CameraNode / SkyboxNode / ParticleSystemNode / FsmRunnerNode / BtRunnerNode，
 * 或用小写别名 meshNode 等）即声明"引用一个场景节点"。
 * 检查器按类型过滤列出可选的场景节点，选择结果在运行期解析为该节点的 Entity
 * （未选择为 null）：
 *
 * ```ts
 * import { Component, property, MeshNode } from "tve";
 *
 * export default class Game extends Component {
 *   @property({ type: MeshNode, label: "目标网格" })
 *   target: MeshNode | null = null;   // 运行期指向被引用的网格节点
 *
 *   onUpdate(delta: number) {
 *     if (this.target) this.target.rotate(0, 90 * delta, 0);
 *   }
 * }
 * ```
 *
 * **内置组件引用**：type 传内置组件门面类（AnimationClip / SkeletalAnimation /
 * RigidBody / Collider / Light / AudioSource），或直接以组件类作装饰器实参
 * （`@property(AnimationClip)`），即声明"引用一个内置组件"。该字段不出现在
 * 检查器中；运行期宿主在本实体上 get-or-create 对应组件并把门面绑定到字段：
 *
 * ```ts
 * import { Component, property, AnimationClip } from "tve";
 *
 * export default class Punch extends Component {
 *   @property(AnimationClip)
 *   anim!: AnimationClip;            // 运行期 = 实体上的关键帧动画剪辑组件
 *
 *   onStart() {
 *     this.anim.speed = 2;
 *     this.anim.play();
 *   }
 * }
 * ```
 */
export function property(options?: {
  /**
   * 值类型。基本类型：number/string/boolean/color/vec3（缺省按字段初值推断）；
   * 或节点类型类：把该属性声明为场景节点引用（检查器选择场景节点，
   * 运行期字段为该节点的 Entity）；
   * 或内置组件门面类：把该属性声明为组件引用（运行期 get-or-create 绑定门面）。
   */
  type?: PropType | NodeClass | ComponentClass;
  /** 检查器显示名（缺省用字段名） */
  label?: string;
  /** 悬浮说明（显示在控件标题） */
  tooltip?: string;
  /** number 专用：最小值 / 最大值 / 步进 */
  min?: number;
  max?: number;
  step?: number;
}): PropertyDecorator;
/**
 * 组件引用速记重载：装饰器实参直接传内置组件门面类（等价
 * `@property({ type: AnimationClip })`）——声明组件引用字段，不出现在检查器，
 * 运行期宿主 get-or-create 绑定门面。
 */
export function property(component: ComponentClass): PropertyDecorator;

/**
 * 节点类型装饰器（类装饰器，可选）：声明脚本类同时作为一种可创建的节点类型，
 * 出现在层级面板「添加节点 > 脚本节点」；创建时生成 kind 对应的基础节点并自动
 * 挂上本脚本组件（以脚本定义节点行为）。
 *
 * ```ts
 * import { Component, nodeType } from "tve";
 *
 * @nodeType({ kind: "meshNode", label: "敌人" })
 * export default class Enemy extends Component {
 *   // ...
 * }
 * ```
 * kind 缺省 node（空组）；label 缺省取类名。
 */
export function nodeType(options?: {
  kind?: ScriptNodeKind;
  label?: string;
}): ClassDecorator;

// ---------------------------------------------------------------------------
// 组件 / 实体
// ---------------------------------------------------------------------------

/** 组件属性值集合（供声明式引用；装饰器字段写法无需本类型） */
export type ComponentProps = Record<string, unknown>;

/**
 * 场景图接入口传入值（原型卡「接入」口 → 本实体上的脚本组件）：
 * 实体（集）为 Entity/Entity[]，数据为标量/向量；未接入或上游为空为 null。
 */
export type GraphInputValue = Entity | Entity[] | number | boolean | string | Vec3 | null;

/**
 * 组件生命周期回调契约（Component 基类的钩子接口；全部可选，按需实现）。
 * 调度方为播放器脚本宿主（engine/core/scripts.mjs）：
 * 全部实例化后先统一 onEnable 再统一 onStart；
 * 每帧先按固定步长驱动 onFixedUpdate，再分派物理碰撞回调并调 onUpdate；
 * 全部模拟（脚本/动画/物理/粒子）更新后、渲染前驱动 onLateUpdate；
 * 停机时逐实例 onDisable → onDestroy。
 */
export interface ComponentLifecycle {
  /**
   * 生命周期：实例创建后调用（全部实例的 onEnable 先于全部 onStart）；此时可安全引用其他实体与组件。
   */
  onEnable?(): void;

  /** 生命周期：全部脚本实例创建后、首个 onUpdate 前调用一次（初始化玩法逻辑） */
  onStart?(): void;

  /**
   * 场景图接入口：本实体原型卡片的「接入」口收到新值时调用（值变化边沿触发；
   * 装配期收到初值即回调一次）。value 与 this.graphInput 同源；实体集为
   * Entity[]，数据为标量/向量。仅场景图模式（预览/导出注入 script-graph.json）
   * 且接入口接线时触发。
   */
  onGraphInput?(value: GraphInputValue): void;

  /** 生命周期：每帧调用（delta = 距上一帧的秒数） */
  onUpdate?(delta: number): void;

  /**
   * 生命周期：固定步长更新，每 1/60 秒一次（与物理步进同频；fixedDelta = 固定
   * 步长秒数）。帧率无关：一次渲染帧内可能不调用或连续调用多次（掉帧补偿，
   * 上限 4 次）。适合与物理相关的确定性逻辑（施力/速度控制）；调用先于同帧的
   * onUpdate 与物理步进。
   */
  onFixedUpdate?(fixedDelta: number): void;

  /**
   * 生命周期：晚更新，每帧一次。在全部脚本/动画/物理/粒子更新完成后、相机
   * 位姿回填与渲染前调用（delta = 距上一帧的秒数）——需要覆盖本帧一切位姿
   * 写入的逻辑（相机跟随、HUD 对齐等）放这里。
   */
  onLateUpdate?(delta: number): void;

  /**
   * 物理碰撞开始（本节点碰撞体与 other 的碰撞体开始接触；在 onUpdate 前调用）。
   * 需要：本节点挂碰撞体组件 + 项目设置启用物理。传感器（isSensor）同样触发。
   */
  onCollisionEnter?(other: Entity): void;

  /** 物理碰撞结束（与 other 的接触断开；参数为对方实体） */
  onCollisionExit?(other: Entity): void;

  /**
   * 生命周期：页面卸载/预览停机时调用一次（先于 onDestroy），用于释放
   * 定时器/事件订阅等外部资源。
   */
  onDisable?(): void;

  /** 生命周期：实例销毁时调用（页面卸载/预览停机时先于本回调触发 onDisable） */
  onDestroy?(): void;
}

/**
 * 脚本组件基类（装饰器声明式写法，推荐）：
 *
 * ```ts
 * import { Component, nodeType, property, engine } from "tve";
 *
 * @nodeType({ kind: "node", label: "旋转体" })
 * export default class Spin extends Component {
 *   @property({ label: "速度", min: 0 })
 *   speed = 90;
 *
 *   onStart() {
 *     engine.log("挂载于", this.entity.name);
 *   }
 *
 *   onUpdate(delta: number) {
 *     this.entity.rotate(0, this.speed * delta, 0); // this.speed 类型为 number
 *   }
 * }
 * ```
 *
 * 生命周期：onStart 挂载后调用一次；onUpdate 每帧调用（delta = 秒）；
 * onFixedUpdate 固定步长调用（1/60s，与物理同频）；onLateUpdate 在全部模拟
 * 更新后、渲染前调用。
 * 运行时 `this` 上还提供一个只读属性值视图 `this.props`（装饰器字段的
 * 当前值 + 检查器配置的覆盖值），便于以字典方式遍历。
 *
 * **组件字段**：字段声明为内置组件门面类型（`anim!: AnimationClip;` 或
 * `@property(AnimationClip) anim: AnimationClip | null = null;`）时，运行期宿主
 * 自动在本实体上 get-or-create 对应组件并把门面绑定到字段——无需手写
 * getComponent。裸声明须带确定类型标注（`!` 断言或 `| null = null` 初值，
 * strict 模式下无初值字段需要其中一种写法）。
 *
 * 字段类型为**用户脚本类**时（配合 `import type` 只引入类型，不产生运行时
 * import 依赖），宿主同样 get-or-create：实体已挂载该脚本组件则绑定实例，
 * 没有则动态创建并立即进入生命周期（按需自动挂载依赖组件）：
 *
 * ```ts
 * import { Component, math } from "tve";
 *
 * // 跨脚本文件时用 import type 只引类型（编译期擦除）；下例同文件演示
 * class CameraFollow extends Component {
 *   offset = math.v3(0, 0, 0);
 * }
 *
 * export default class Enemy extends Component {
 *   follow!: CameraFollow;   // 自动绑定/创建本实体上的 CameraFollow 组件
 *
 *   onStart() {
 *     this.follow.offset = math.v3(0, 3, 5);
 *   }
 * }
 * ```
 */
export class Component<P extends ComponentProps = ComponentProps> implements ComponentLifecycle {
  /**
   * @deprecated 推荐使用字段 + @property 装饰器声明属性。此静态声明仍受支持：
   * 声明后检查器按此渲染编辑控件，未在节点上配置的属性取 default，
   * 运行期经 `this.props` 读取（此时用泛型 P 声明 this.props 的类型）。
   */
  static props?: { [key: string]: PropDef };

  /** @internal 由运行时构造（挂载到节点时创建实例），脚本不要直接 new。 */
  constructor(entity: Entity);

  /** 宿主实体（挂载所在节点） */
  readonly entity: Entity;

  /**
   * 属性值视图（只读）：字段装饰器字段的当前值，叠加检查器配置的覆盖值；
   * 兼容旧静态 props 声明的脚本。不要在本视图写入。
   */
  readonly props: Readonly<P>;

  /**
   * 场景图接入口的最新值（只读轮询；与 onGraphInput 的 value 同源）：
   * 原型卡「接入」口接入实体集 → Entity[]，接入数据 → 标量/向量，
   * 未接线/上游为空 → null。仅场景图模式下由宿主写入。
   */
  readonly graphInput: GraphInputValue;

  /** 生命周期：实例创建后调用（全部实例的 onEnable 先于全部 onStart） */
  onEnable?(): void;

  /** 生命周期：全部脚本实例创建后、首个 onUpdate 前调用一次（初始化玩法逻辑） */
  onStart?(): void;

  /** 生命周期：每帧调用（delta = 距上一帧的秒数） */
  onUpdate?(delta: number): void;

  /**
   * 生命周期：固定步长更新，每 1/60 秒一次（与物理步进同频；fixedDelta = 固定
   * 步长秒数）。一次渲染帧内可能不调用或连续调用多次（掉帧补偿，上限 4 次）；
   * 调用先于同帧的 onUpdate 与物理步进。
   */
  onFixedUpdate?(fixedDelta: number): void;

  /** 生命周期：每帧一次，全部脚本/动画/物理/粒子更新后、渲染前调用（相机跟随等） */
  onLateUpdate?(delta: number): void;

  /** 物理碰撞开始（本节点碰撞体与 other 的碰撞体开始接触；在 onUpdate 前调用） */
  onCollisionEnter?(other: Entity): void;

  /** 物理碰撞结束（与 other 的接触断开；参数为对方实体） */
  onCollisionExit?(other: Entity): void;

  /** 生命周期：页面卸载/预览停机时调用一次（先于 onDestroy），用于释放外部资源 */
  onDisable?(): void;

  /** 生命周期：实例销毁时调用（先于本回调触发 onDisable） */
  onDestroy?(): void;
}

/** 场景实体（节点在脚本运行期的句柄；变换与编辑器同一套语义，旋转为度制欧拉角） */
export class Entity {
  /** @internal 由运行时构造 */
  constructor();

  /** 节点 id（与场景文件中的节点 id 一致） */
  readonly id: string;

  /** 节点类型键（与场景序列化的 type 字段一致：node/meshNode/pointLightNode…） */
  readonly kind: EntityKind;

  /** 名称（可写，即时生效） */
  get name(): string;
  set name(value: string);

  /** 节点标签（检查器 Node 卡设置，空串 = 无标签） */
  readonly tag: string;

  /** 渲染层级索引（0~31；可写，应用到对象子树的渲染层） */
  get layer(): number;
  set layer(value: number);

  /** 可见性（可写，即时生效；含子级继承） */
  get visible(): boolean;
  set visible(value: boolean);

  /** 本地位置（读取返回快照副本；写入接受部分字段——缺省分量保持不变） */
  get position(): Vec3;
  set position(value: Partial<Vec3>);

  /** 本地旋转（度制欧拉角 XYZ；读取返回快照副本；写入接受部分字段） */
  get rotation(): Vec3;
  set rotation(value: Partial<Vec3>);

  /** 本地缩放（读取返回快照副本；写入接受部分字段） */
  get scale(): Vec3;
  set scale(value: Partial<Vec3>);

  /** 世界位置（只读快照） */
  get worldPosition(): Vec3;

  /** 父实体（根节点返回 null） */
  get parent(): Entity | null;

  /** 子实体列表（快照） */
  get children(): Entity[];

  /** 沿本地轴平移：position += (x, y, z) */
  translate(x: number, y: number, z: number): void;

  /** 本地旋转叠加（度）：rotation += (x, y, z) */
  rotate(xDeg: number, yDeg: number, zDeg: number): void;

  /** 朝向世界坐标目标（前向 = -Z，与灯光/相机朝向约定一致） */
  lookAt(target: Vec3): void;

  /**
   * 在本实体子树内查找：支持名称路径（"父/子/孙"）或单名称深度优先匹配。
   * 未找到返回 null。
   */
  find(nameOrPath: string): Entity | null;

  /**
   * 获取实体上挂载的组件（未挂载返回 null）。
   * - 内置组件：传门面类（RigidBody/Light/AudioSource/AnimationClip/
   *   SkeletalAnimation/Collider）或类型键字符串（"rigidBody" 等；"animation"/
   *   "anim" 为骨骼动画别名）。多实例组件（如多个动画剪辑组件）取首个，句柄稳定；
   * - 脚本组件：传脚本类（构造器）按类匹配；或传脚本源路径 / 类名字符串
   *   （"src/hp.ts" / "HPBar"）——按类型名查找：所有脚本类在加载后
   *   全局可见，脚本之间互相引用组件无需 import（严格模式下用
   *   `import type` 只引入类型即可获得智能提示）。
   * - 注意：节点句柄类（LightNode/MeshNode/CameraNode/Transform 等，均
   *   extends Entity）是场景节点而非组件，不能传给 getComponent；灯光属性
   *   用 `getComponent(Light)`，引用节点本身用 `@property({ type: LightNode })`
   *   或 `engine.scene.find("name")` 后以 `instanceof LightNode` 收窄。
   */
  getComponent(component: "rigidBody" | typeof RigidBody): RigidBody | null;
  getComponent(component: "collider" | typeof Collider): Collider | null;
  getComponent(component: "light" | typeof Light): Light | null;
  getComponent(component: "audioSource" | typeof AudioSource): AudioSource | null;
  getComponent(component: "animationClip" | typeof AnimationClip): AnimationClip | null;
  getComponent(
    component: "animation" | "anim" | "skeletalAnimation" | typeof SkeletalAnimation,
  ): SkeletalAnimation | null;
  /** 按脚本源路径 / 脚本类名获取已挂载的脚本组件（未挂载返回 null） */
  getComponent(component: string): Component | null;
  getComponent<T extends Component>(componentClass: new (...args: never[]) => T): T | null;

  /**
   * 动态添加组件并返回实例/门面（预览运行态生效，不回写场景文件）。
   * - 内置组件 Light / AudioSource / AnimationClip：在本节点追加一个新组件
   *   （多实例）；settings 为组件设置对象（缺省项回默认）；
   * - 内置组件 SkeletalAnimation：仅模型网格节点可用；settings 可含 clip/
   *   autoplay/speed/loop/graph（graph 为动画图定义，传即创建动画图模式）；
   * - 脚本组件：传脚本类（构造器）或脚本源路径 / 类名字符串，在本实体上
   *   实例化并立即进入生命周期（onEnable/onStart），props 作为属性配置；
   * - RigidBody / Collider：物理组件仅启动期按场景数据构建，运行时创建返回 null。
   */
  addComponent(component: "light" | typeof Light, settings?: LightAddOptions): Light | null;
  addComponent(
    component: "audioSource" | typeof AudioSource,
    settings?: AudioSourceAddOptions,
  ): AudioSource | null;
  addComponent(
    component: "animationClip" | typeof AnimationClip,
    settings?: AnimationClipAddOptions,
  ): AnimationClip | null;
  addComponent(
    component: "animation" | "skeletalAnimation" | typeof SkeletalAnimation,
    settings?: SkeletalAnimationAddOptions,
  ): SkeletalAnimation | null;
  /** 动态创建脚本组件（按脚本类 / 源路径 / 类名查找；props = 属性配置） */
  addComponent(
    component: string | (new (entity: Entity) => Component),
    props?: ComponentProps,
  ): Component | null;
  addComponent(
    component: "rigidBody" | "collider" | typeof RigidBody | typeof Collider,
    settings?: never,
  ): null;
}

// ---------------------------------------------------------------------------
// 节点类型（场景节点引用的类型 token）
//
// 既可作类型标注（字段类型），也可作为值传给 @property({ type })：
//   @property({ type: MeshNode }) target: MeshNode | null = null;
// 编辑器按类型过滤可选场景节点；运行期字段解析为对应 kind 的 Entity 子类实例
// （instanceof 可判断）。小写别名与编辑器节点名一致（meshNode/cameraNode/…）。
// ---------------------------------------------------------------------------

/** 通用节点（Transform/空组；可引用任意场景节点） */
export class Transform extends Entity {}

/** 网格节点（编辑器 meshNode：基元网格或模型网格） */
export class MeshNode extends Entity {}

/**
 * 灯光节点句柄（编辑器 lightNode / pointLightNode / directionalLightNode / ambientLightNode / spotLightNode）。
 *
 * 这是场景**节点**句柄（extends Entity），不是组件——不能用 `getComponent(LightNode)`。
 * 灯光属性（intensity/color/kind/...）通过组件门面 `Light` 访问：
 * ```ts
 * import { Component, Light } from "tve";
 *
 * export default class Torch extends Component {
 *   onStart() {
 *     const light = this.entity.getComponent(Light);   // ✅ 组件门面
 *     // const light2 = this.entity.getComponent("light"); // ✅ 字符串键
 *     // this.entity.getComponent(LightNode)          // ❌ LightNode 是节点句柄，非组件
 *     if (light) light.intensity = 2;
 *   }
 * }
 * ```
 * 引用灯光节点本身（变换/层级）用 `@property({ type: LightNode })` 声明字段，
 * 或 `engine.scene.find("name")` 后以 `instanceof LightNode` 收窄。
 */
export class LightNode extends Entity {}

/** 相机节点（编辑器 cameraNode） */
export class CameraNode extends Entity {
  /**
   * 屏幕坐标 → 世界空间射线（用于物理拾取/视线检测等）。
   * screenX/screenY 为画布内 CSS 像素（左上角原点；与 engine.input 指针坐标同一空间）。
   * 返回 `{ origin, direction }`（origin = 相机世界位置，direction = 归一化世界方向）；
   * 相机未就绪/坐标越界返回 null。
   */
  screenToRay(screenX: number, screenY: number): { origin: Vec3; direction: Vec3 } | null;
}

/** 天空盒节点（编辑器 skyboxNode） */
export class SkyboxNode extends Entity {}

/** 雾节点（编辑器 fogNode；场景环境级，第一个启用且可见的雾节点生效） */
export class FogNode extends Entity {}

/** 粒子发射形状：cone = 圆锥（沿节点本地 -Z）| sphere = 球面 | hemisphere = 上半球 | box = 盒体 */
export type ParticleShape = "cone" | "sphere" | "hemisphere" | "box";

/** 粒子系统发射设置（与编辑器检查器 Particle System 卡同一字段集） */
export interface ParticleSettings {
  /** 发射周期（秒）：非循环系统发射持续该时长后停止 */
  duration: number;
  /** 循环发射 */
  looping: boolean;
  /** 预热：重启时快进一个周期（仅循环系统） */
  prewarm: boolean;
  /** 起始延迟（秒） */
  startDelay: number;
  /** 粒子寿命（秒） */
  startLifetime: number;
  /** 初速度（世界单位/秒） */
  startSpeed: number;
  /** 初始直径（世界单位） */
  startSize: number;
  /** 初始颜色（0xRRGGBB） */
  startColor: number;
  /** 终点颜色（0xRRGGBB；colorOverLifetime 开启时插值到该色） */
  endColor: number;
  /** 重力系数（1 = 标准重力；0 = 无重力；负值上浮） */
  gravityModifier: number;
  /** 发射速率（粒子/秒） */
  emissionRate: number;
  /** 同时存活粒子上限（改动会重建发射器） */
  maxParticles: number;
  shape: ParticleShape;
  /** 形状半径（圆锥底圆 / 球 / 盒半边长） */
  shapeRadius: number;
  /** 圆锥半角（度；仅 cone） */
  shapeAngle: number;
  /** 模拟空间：local 跟随节点 / world 留在世界 */
  simulationSpace: "local" | "world";
  /** 颜色随寿命（start → end + 末段淡出） */
  colorOverLifetime: boolean;
  /** 尺寸随寿命（线性缩到 0） */
  sizeOverLifetime: boolean;
  /** 混合：additive 叠加 / normal 透明混合（改动会重建发射器） */
  blending: "additive" | "normal";
  /** 粒子贴图（图片资产相对路径；空串 = 内置软圆点。RGB 与粒子颜色相乘、alpha 相乘） */
  texture: string;
}

/** 粒子系统运行态 */
export interface ParticleState {
  /** 正在推进（未暂停且未播完） */
  playing: boolean;
  paused: boolean;
  /** 非循环系统已发射完毕且粒子全部消亡 */
  finished: boolean;
  /** 当前存活粒子数 */
  alive: number;
  /** 系统时间（秒；自播放起累计） */
  time: number;
}

/**
 * 粒子系统节点（编辑器 particleSystemNode）：通用节点能力 + 运行时播放控制 +
 * 发射参数读写（运行态生效，不回写场景文件）。
 *
 * ```ts
 * import { Component, property, ParticleSystemNode } from "tve";
 *
 * export default class Explode extends Component {
 *   @property({ type: ParticleSystemNode, label: "爆炸特效" })
 *   fx: ParticleSystemNode | null = null;
 *
 *   onStart() {
 *     if (!this.fx) return;
 *     this.fx.startColor = 0xffcc33;
 *     this.fx.emissionRate = 200;
 *     this.fx.restart();
 *   }
 * }
 * ```
 */
export class ParticleSystemNode extends Entity {
  /** 播放（暂停态续播；停止/播完态从头开始） */
  play(): void;
  /** 暂停（保留当前粒子） */
  pause(): void;
  /** 停止发射（存活粒子自然消亡） */
  stop(): void;
  /** 清空粒子并从头开始（预热系统下一帧快进一个周期） */
  restart(): void;
  /** 立即清空全部粒子（不改变播放态） */
  clear(): void;
  readonly playing: boolean;
  readonly paused: boolean;
  /** 非循环系统已发射完毕且粒子全部消亡 */
  readonly finished: boolean;
  /** 当前存活粒子数 */
  readonly aliveCount: number;
  /** 发射设置快照（未绑定返回 null） */
  readonly settings: ParticleSettings | null;
  /** 批量合并发射设置（子集；maxParticles/blending 变化会重建发射器） */
  setSettings(patch: Partial<ParticleSettings>): void;
  duration: number;
  looping: boolean;
  prewarm: boolean;
  startDelay: number;
  startLifetime: number;
  startSpeed: number;
  startSize: number;
  /** 初始颜色（0xRRGGBB） */
  startColor: number;
  /** 终点颜色（0xRRGGBB） */
  endColor: number;
  gravityModifier: number;
  emissionRate: number;
  maxParticles: number;
  shape: ParticleShape;
  shapeRadius: number;
  shapeAngle: number;
  simulationSpace: "local" | "world";
  colorOverLifetime: boolean;
  sizeOverLifetime: boolean;
  blending: "additive" | "normal";
  /** 粒子贴图（图片资产相对路径；空串 = 内置软圆点；运行态异步加载后热替换） */
  texture: string;
}

/**
 * 地形节点（编辑器 terrainNode）：通用节点能力 + 贴地采样
 * （脚本把物体摆到地表、按坡度撒放植被/装饰物用）。
 *
 * ```ts
 * import { Component, property, TerrainNode } from "tve";
 *
 * export default class Drop extends Component {
 *   @property({ type: TerrainNode, label: "地形" })
 *   ground: TerrainNode | null = null;
 *
 *   onUpdate() {
 *     const p = this.entity.position;
 *     if (this.ground) p.y = this.ground.sampleHeight(p.x, p.z);
 *   }
 * }
 * ```
 */
export class TerrainNode extends Entity {
  /** 双线性采样地表高度（节点本地 x/z；节点仅平移时即世界坐标；未命中返回 0） */
  sampleHeight(x: number, z: number): number;
  /** 地表平坦度（1 = 平地 → 0 = 崖壁；有限差分估算，撒放可用性检测用） */
  sampleSlope(x: number, z: number): number;
  /** 地形设置快照（未绑定返回 null） */
  readonly settings: TerrainSettingsSnapshot | null;
}

/** 地形设置快照（SDK 只读视图；与编辑器 TerrainSettings 同形状） */
export interface TerrainSettingsSnapshot {
  seed: number;
  size: number;
  segments: number;
  heightScale: number;
  frequency: number;
  octaves: number;
  lacunarity: number;
  gain: number;
  erosion: number;
  warp: number;
  valleyBias: number;
  seaLevel: number;
  talus: number;
  talusPasses: number;
  grassColor: number;
  rockColor: number;
  snowColor: number;
}

// ---------------------------------------------------------------------------
// 逻辑运行器（状态机/行为树）：场景节点句柄 + engine.logic 控制接口
// .fsm/.bt 资产在编辑器经「逻辑」分组的运行器节点绑定；运行态（当前状态/
// 黑板/运行记忆）不序列化。控制统一走 engine.logic（按实体寻址）。
// ---------------------------------------------------------------------------

/** 状态机运行器节点（编辑器 fsmRunnerNode）：控制走 {@link engine.logic} */
export class FsmRunnerNode extends Entity {}

/** 行为树运行器节点（编辑器 btRunnerNode）：控制走 {@link engine.logic} */
export class BtRunnerNode extends Entity {}

/** 行为树节点求值状态 */
export type BTStatus = "success" | "failure" | "running";

/** 状态机状态快照 */
export interface LogicStateInfo {
  /** 状态 id（图内唯一） */
  id: string;
  /** 显示名 */
  name: string;
  /** 当前状态停留秒数 */
  time: number;
}

/** 动作叶子数据（engine.logic.onAction 处理器的入参） */
export interface BTActionLeaf {
  /** 叶节点 id（树内唯一；同动作名多处使用时用它区分实例） */
  id: string;
  /** 动作名 */
  action: string;
}

/**
 * 动作求值会话：seq 为求值代际，每次全新开始（首次 / 完成后树重启再入 /
 * 被中断后重入）自增；running 续行时不变——有状态的动作比对 seq 复位。
 */
export interface BTActionSession {
  seq: number;
}

/** 动作处理器：返回三值状态（缺省视为 success） */
export type BTActionHandler = (
  leaf: BTActionLeaf,
  session: BTActionSession,
) => BTStatus | void;

/** 逻辑控制接口（engine.logic）：状态机/行为树运行器的脚本入口 */
export interface LogicApi {
  // —— 状态机（fsmRunnerNode 实体）——
  /** 状态机当前状态（未绑定/未启动返回 null） */
  fsmState(entity: Entity): LogicStateInfo | null;
  /** 发射事件（进入当前状态以来的首次发射有效；事件过渡的触发器） */
  fire(entity: Entity, event: string): void;
  /** 写运行参数（条件过渡的黑板；布尔按 0/1 参与比较） */
  setFsmParam(entity: Entity, name: string, value: number | boolean): void;
  /** 读运行参数（未定义返回 undefined） */
  getFsmParam(entity: Entity, name: string): number | boolean | undefined;
  /** 强制切换状态（stateId 或状态名；不经触发器；未知忽略） */
  forceFsmState(entity: Entity, stateId: string): void;
  /**
   * 订阅状态进入（含初始进入）。match = 状态 id 或显示名（空 = 任意状态）；
   * 返回解绑函数。回调里可安全操作实体（engine.animation.play 等）。
   */
  onFsmEnter(
    entity: Entity,
    match: string,
    cb: (state: LogicStateInfo) => void,
  ): () => void;
  /** 订阅状态退出（match 参数同 {@link LogicApi.onFsmEnter}） */
  onFsmExit(
    entity: Entity,
    match: string,
    cb: (state: LogicStateInfo) => void,
  ): () => void;
  /** 订阅任意过渡（cb(from, to)；返回解绑函数） */
  onFsmTransition(
    entity: Entity,
    cb: (from: LogicStateInfo, to: LogicStateInfo) => void,
  ): () => void;

  // —— 行为树（btRunnerNode 实体）——
  /** 整树最近一次 tick 结果（未就绪返回 null） */
  btStatus(entity: Entity): BTStatus | null;
  /** 写黑板（条件叶子的求值对象） */
  setBtParam(entity: Entity, name: string, value: number | boolean): void;
  /** 读黑板（未定义返回 undefined） */
  getBtParam(entity: Entity, name: string): number | boolean | undefined;
  /**
   * 注册动作叶处理器（按动作名；后注册覆盖；返回解绑函数）。
   * 未注册的动作按成功处理。handler 返回 "running" 时下一帧会再次调用
   * 同一动作叶（续行，session.seq 不变）；动作重新开始时 seq 自增，据此复位：
   *
   * ```ts
   * import { Component, engine } from "tve";
   *
   * export default class Walk extends Component {
   *   private lastSeq = -1;
   *   private step = 0;
   *
   *   onStart() {
   *     engine.logic.onAction(this.entity, "walkTo", (leaf, session) => {
   *       void leaf.id;
   *       if (session.seq !== this.lastSeq) { this.lastSeq = session.seq; this.step = 0; }
   *       return ++this.step >= 10 ? "success" : "running";
   *     });
   *   }
   * }
   * ```
   */
  onAction(entity: Entity, name: string, handler: BTActionHandler): () => void;

  // —— 通用 ——
  /** 运行开关（暂停/恢复；恢复时未启动则从入口开始） */
  setRunning(entity: Entity, running: boolean): void;
  /** 重启（状态回入口/黑板回默认/清运行记忆） */
  restart(entity: Entity): void;
}

// ---------------------------------------------------------------------------
// UI（Canvas-Widget）：画布容器 + 图片/文本/按钮 Widget + 布局容器
// 2D 定位标准：100px = 1 UI 单位；锚点 anchorMin/Max/pivot 为 0..1 归一化
//（父矩形/自身），anchoredPosition/offset 单位与 size 一致（UI 单位）。
// ---------------------------------------------------------------------------

/** UI 缩放模式（与项目设置 scaleMode 同名集） */
export type UIScaleMode = "noscale" | "fixedwidth" | "fixedheight" | "fixedauto" | "full";

/** UI 锚点/布局容器的二维向量（分量语义见各字段） */
export interface UIVec2 {
  x: number;
  y: number;
}

/** UI 内边距（UI 单位） */
export interface UIPadding {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * UI 画布节点（编辑器 uiCanvasNode）：屏幕叠加渲染的 UI 容器根，
 * Widget（图片/文本/按钮/布局容器）作为其子节点参与叠加；SortOrder 控制叠加顺序。
 */
export class UICanvasNode extends Entity {
  /** 画布整体排序（多画布叠加时大者在上；优先于画布内 Widget 排序） */
  sortOrder: number;
  /** 设计宽度（设计像素；100px = 1 UI 单位） */
  designWidth: number;
  /** 设计高度（设计像素） */
  designHeight: number;
  /** 屏幕适配方案（仅预览/构建产物运行时生效；编辑器布局视图恒按设计尺寸 1:1 显示） */
  scaleMode: UIScaleMode;
}

/** UI 元素共有锚点字段（位置由锚点系统解析：点锚点用 anchoredPosition，拉伸轴用 offset） */
export interface UIAnchorBase {
  /** 归一化锚点下限（父矩形 0..1；某轴 min==max 为点锚点） */
  anchorMin: UIVec2;
  /** 归一化锚点上限（min<max 该轴拉伸，尺寸由边距推导） */
  anchorMax: UIVec2;
  /** 归一化枢轴（自身 0..1） */
  pivot: UIVec2;
  /** 点锚点轴：枢轴相对锚点的偏移（UI 单位） */
  anchoredPosition: UIVec2;
  /** 拉伸轴边距：左/下（UI 单位） */
  offsetMin: UIVec2;
  /** 拉伸轴边距：右/上（UI 单位） */
  offsetMax: UIVec2;
}

/** UI Widget 共有字段（叠加序 + 矩形尺寸 + 锚点；尺寸/位置单位 = UI 单位，100px = 1 单位） */
export interface UIWidgetBase extends UIAnchorBase {
  /** 画布内叠加序（大者在上；点击命中也按此取最上层） */
  sortOrder: number;
  /** 矩形尺寸（UI 单位；拉伸锚点轴由父矩形与边距推导） */
  size: { x: number; y: number };
}

/** UI 图片节点（编辑器 uiImageNode）：矩形图片或纯色块 */
export class UIImageNode extends Entity implements UIWidgetBase {
  sortOrder: number;
  size: { x: number; y: number };
  anchorMin: UIVec2;
  anchorMax: UIVec2;
  pivot: UIVec2;
  anchoredPosition: UIVec2;
  offsetMin: UIVec2;
  offsetMax: UIVec2;
  /** 图片资产相对路径（空串 = 纯色矩形；运行态异步加载后热替换） */
  image: string;
  /** 着色（0xRRGGBB；与图片相乘） */
  color: number;
}

/** UI 文本节点（编辑器 uiTextNode）：多行文本（自动换行，样式可调） */
export class UITextNode extends Entity implements UIWidgetBase {
  sortOrder: number;
  size: { x: number; y: number };
  anchorMin: UIVec2;
  anchorMax: UIVec2;
  pivot: UIVec2;
  anchoredPosition: UIVec2;
  offsetMin: UIVec2;
  offsetMax: UIVec2;
  /** 文本内容（\n 分行；超界自动换行） */
  text: string;
  /** 字号（设计像素，100px = 1 单位） */
  fontSize: number;
  /** 文本颜色（0xRRGGBB） */
  color: number;
  bold: boolean;
  italic: boolean;
  /** 字族：system 系统无衬线 / serif 衬线 / mono 等宽 */
  fontFamily: "system" | "serif" | "mono";
  /** 相对文本框的水平对齐 */
  align: "left" | "center" | "right";
}

/** UI 按钮节点（编辑器 uiButtonNode）：背景 + 标签，运行时可点击 */
export class UIButtonNode extends Entity implements UIWidgetBase {
  sortOrder: number;
  size: { x: number; y: number };
  anchorMin: UIVec2;
  anchorMax: UIVec2;
  pivot: UIVec2;
  anchoredPosition: UIVec2;
  offsetMin: UIVec2;
  offsetMax: UIVec2;
  /** 背景图片资产相对路径（空串 = 纯色背景） */
  image: string;
  /** 背景着色（0xRRGGBB） */
  color: number;
  /** 标签文本 */
  label: string;
  /** 标签颜色（0xRRGGBB） */
  labelColor: number;
  /** 标签字号（设计像素，100px = 1 单位） */
  fontSize: number;
  labelBold: boolean;
  /** 可交互（false 时仅展示，不参与点击命中） */
  interactable: boolean;
}

/**
 * UI 布局容器节点（编辑器 uiLayoutNode）：按横向/竖向/网格排列直接子 UI 节点。
 * 自身有尺寸/锚点（可被父布局排列），无渲染内容；layoutMode=none 时子节点回归锚点定位。
 */
export class UILayoutNode extends Entity implements UIWidgetBase {
  sortOrder: number;
  size: { x: number; y: number };
  anchorMin: UIVec2;
  anchorMax: UIVec2;
  pivot: UIVec2;
  anchoredPosition: UIVec2;
  offsetMin: UIVec2;
  offsetMax: UIVec2;
  /** 排列模式：none 不排列 / horizontal 横向一行 / vertical 竖向一列 / grid 网格 */
  layoutMode: "none" | "horizontal" | "vertical" | "grid";
  /** 内容区内边距（UI 单位） */
  padding: UIPadding;
  /** 子元素间距（UI 单位；x 横向 / y 纵向） */
  spacing: UIVec2;
  /** 网格列数（grid 模式；行数由子元素数量推导） */
  gridColumns: number;
}

export {
  Transform as transform,
  MeshNode as meshNode,
  LightNode as lightNode,
  CameraNode as cameraNode,
  SkyboxNode as skyboxNode,
  FogNode as fogNode,
  ParticleSystemNode as particleSystemNode,
  TerrainNode as terrainNode,
  UICanvasNode as uiCanvasNode,
  UIImageNode as uiImageNode,
  UITextNode as uiTextNode,
  UIButtonNode as uiButtonNode,
  UILayoutNode as uiLayoutNode,
};

// ---------------------------------------------------------------------------
// math —— 向量数学库
// ---------------------------------------------------------------------------

/**
 * 向量数学库（引擎自有类型；纯函数，全部返回新对象，不改写入参）。
 *
 * ```ts
 * import { math, Component } from "tve";
 *
 * export default class Orbit extends Component {
 *   onUpdate(delta: number) {
 *     const dir = math.normalize(math.sub(this.entity.position, math.zero));
 *     this.entity.position = math.scale(dir, 5);
 *   }
 * }
 * ```
 */
export interface MathApi {
  /** 创建向量 {x,y,z}（缺省 0） */
  v3(x?: number, y?: number, z?: number): Vec3;
  /** 常量：零向量（冻结，勿改写） */
  readonly zero: Vec3;
  /** 常量：单位向量 (1,1,1)（冻结，勿改写） */
  readonly one: Vec3;
  /** 常量：世界上方向 (0,1,0)（冻结，勿改写） */
  readonly up: Vec3;
  /** 常量：世界下方向 (0,-1,0)（冻结，勿改写） */
  readonly down: Vec3;
  /** 常量：前方向 (0,0,-1)（冻结，勿改写） */
  readonly forward: Vec3;
  /** 常量：后方向 (0,0,1)（冻结，勿改写） */
  readonly back: Vec3;
  /** 常量：左方向 (-1,0,0)（冻结，勿改写） */
  readonly left: Vec3;
  /** 常量：右方向 (1,0,0)（冻结，勿改写） */
  readonly right: Vec3;
  /** 克隆（快照副本，写入不影响原向量） */
  clone(v: Vec3): Vec3;
  /** 加法 a + b */
  add(a: Vec3, b: Vec3): Vec3;
  /** 减法 a - b */
  sub(a: Vec3, b: Vec3): Vec3;
  /** 数乘 v * s */
  scale(v: Vec3, s: number): Vec3;
  /** 逐分量取反 */
  negate(v: Vec3): Vec3;
  /** 逐分量取绝对值 */
  abs(v: Vec3): Vec3;
  /** 逐分量取最小 */
  min(a: Vec3, b: Vec3): Vec3;
  /** 逐分量取最大 */
  max(a: Vec3, b: Vec3): Vec3;
  /** 点积（结果 = |a||b|cosθ） */
  dot(a: Vec3, b: Vec3): number;
  /** 叉积（结果同时垂直于 a、b，方向满足右手定则） */
  cross(a: Vec3, b: Vec3): Vec3;
  /** 模长平方（避免开方，比较距离时更快） */
  lengthSq(v: Vec3): number;
  /** 模长（到原点的直线距离） */
  length(v: Vec3): number;
  /** 两点直线距离 */
  distance(a: Vec3, b: Vec3): number;
  /** 距离平方 */
  distanceSq(a: Vec3, b: Vec3): number;
  /** 归一化（模长归 1；零向量返回零向量，不产生 NaN） */
  normalize(v: Vec3): Vec3;
  /** 线性插值 t∈[0,1]（t=0 返回 a 克隆，t=1 返回 b 克隆） */
  lerp(a: Vec3, b: Vec3, t: number): Vec3;
  /** 由 a 向 b 移动最多 maxDelta（不超过直线距离；匀速移动用） */
  moveTowards(a: Vec3, b: Vec3, maxDelta: number): Vec3;
  /** 近似相等（逐分量误差 ≤ eps，缺省 1e-6） */
  equals(a: Vec3, b: Vec3, eps?: number): boolean;

  /** 标量钳制（结果落在 [min, max]） */
  clamp(v: number, min: number, max: number): number;
  /** XZ 平面投影（返回 y = 0 的副本；把方向约束到水平面） */
  projectXZ(v: Vec3): Vec3;
  /**
   * 角度差（度）= target − current 的最短有符号差（结果 ∈ [-180, 180]）。
   * 角度约定与 Entity.rotation 一致（度制欧拉角）；多圈差值自动归一化。
   */
  deltaAngle(current: number, target: number): number;
  /**
   * 角度移近（度）：从 current 沿最短路径向 target 移动最多 maxDelta
   * （配合 delta = 转速×帧间隔 即帧率无关的平滑转身）。
   */
  moveTowardsAngle(current: number, target: number, maxDelta: number): number;
  /**
   * 模拟输入死区（线性重映射）：|v| ≤ deadZone 归零，其余按符号缩放回 0..1 满量程
   * （摇杆/扳机等模拟量的标准滤抖处理）。
   */
  deadZone(v: number, deadZone: number): number;
  /** 度 → 弧度（角度约定与 Entity.rotation 一致） */
  degToRad(degrees: number): number;
  /** 弧度 → 度 */
  radToDeg(radians: number): number;

  // ---- Mat4：4×4 矩阵（列主序，长度 16 数组；与 Three.js/WebGPU 同布局）----

  /** 创建 4×4 单位矩阵（列主序长度 16） */
  mat4(): number[];
  /** 矩阵乘法 a × b（列主序；结果 = 先 b 变换再 a 变换） */
  mat4Multiply(a: number[], b: number[]): number[];
  /** 矩阵求逆（列主序；不可逆返回单位矩阵，不产生 NaN） */
  mat4Invert(m: number[]): number[];
  /**
   * 屏幕坐标 → 世界坐标（逆投影）。
   * ndcX/ndcY ∈ [-1,1]（屏幕像素经 NDC 归一化后），ndcZ ∈ [-1,1]（-1 近 1 远）；
   * invVP = (projection × view)^-1（列主序 16 数组，可用 mat4Invert 求逆）。
   * 返回世界空间 Vec3。
   */
  unproject(ndcX: number, ndcY: number, ndcZ: number, invVP: number[]): Vec3;
}

// ---------------------------------------------------------------------------
// tween —— 补间动画系统
// 驱动方式：由引擎每帧自动推进（脚本 onUpdate 前），创建即开始播放；
// 无需手动驱动。全部 tween 可链式配置并在任意时刻 stop/pause/resume。
// ---------------------------------------------------------------------------

/**
 * 缓动函数名（Robert Penner 标准族；"linear" 无方向后缀）。
 * In = 加速起步，Out = 减速收尾，InOut = 两端缓入缓出。
 */
export type EaseName =
  | "linear"
  | "quadIn" | "quadOut" | "quadInOut"
  | "cubicIn" | "cubicOut" | "cubicInOut"
  | "quartIn" | "quartOut" | "quartInOut"
  | "quintIn" | "quintOut" | "quintInOut"
  | "sineIn" | "sineOut" | "sineInOut"
  | "expoIn" | "expoOut" | "expoInOut"
  | "circIn" | "circOut" | "circInOut"
  | "backIn" | "backOut" | "backInOut"
  | "elasticIn" | "elasticOut" | "elasticInOut"
  | "bounceIn" | "bounceOut" | "bounceInOut";

/** 缓动函数表：名称 → 插值函数（t 0..1 → eased；back/elastic 中间超调出界） */
export const easing: Readonly<Record<EaseName, (t: number) => number>>;

/**
 * 可插值目标值：数字，或数值字段对象——{x,y,z} 向量 / {x,y}（size、
 * anchoredPosition、pivot、spacing）/ {left,right,top,bottom}（padding）等，
 * 允许部分字段（缺省分量保持不动）。
 */
export type TweenValue = number | Partial<Vec3> & Record<string, number | undefined>;

/**
 * 补间句柄：链式配置 + 播放控制。由 tween 工厂创建（创建即自动播放，
 * 同一语句内的链式配置全部生效），脚本不要直接 new。
 *
 * ```ts
 * import { tween, engine, Component } from "tve";
 *
 * export default class Punch extends Component {
 *   onStart() {
 *     tween.position(this.entity, { x: 5, y: 0, z: 0 }, 1)
 *       .easing("quadOut")
 *       .onComplete(() => engine.log("到位"));
 *   }
 * }
 * ```
 */
export class Tween {
  /** @internal 由 tween 工厂创建，脚本不要直接 new */
  constructor();

  /** 缓动：名称（EaseName）或自定义函数 (t 0..1) => eased */
  easing(nameOrFn: EaseName | ((t: number) => number)): this;

  /** 开始前延时（秒；多次调用取最后一次） */
  delay(seconds: number): this;

  /** 循环次数：1 = 单次（缺省）；n = n 次；-1 = 无限循环 */
  loop(count: number): this;

  /** 往返：偶数次循环反向插值（终点 → 起点；对 sequence/parallel 组无效） */
  yoyo(on?: boolean): this;

  /** 开始回调（delay 结束、首轮插值前触发一次） */
  onStart(cb: () => void): this;

  /**
   * 每帧回调。value = 插值输出（tween.value/tween.color 为插值结果，
   * 其余为系数）；t = easing 后的插值系数 0..1。
   */
  onUpdate(cb: (value: number, t: number) => void): this;

  /** 完成回调（循环计满触发一次；stop(true) 快进完成同样触发） */
  onComplete(cb: () => void): this;

  /**
   * 串接：本 tween 完成后自动启动 next（next 无需手动 start）。
   * 返回 next 以便继续链式配置。
   */
  then(next: Tween): Tween;

  /**
   * 停止：移出推进列表不再恢复。
   * complete = true 时先快进到最终落点并触发 onComplete（不启动 then 链）。
   */
  stop(complete?: boolean): this;

  /** 暂停（保留进度） */
  pause(): this;

  /** 从暂停处继续 */
  resume(): this;

  /** 是否正在推进（不含暂停） */
  readonly playing: boolean;
  /** 是否处于暂停态 */
  readonly paused: boolean;
  /** 是否已完成（自然播完或 stop(true)） */
  readonly completed: boolean;
  /** 配置的时长（秒） */
  readonly duration: number;
  /** 累计活跃播放时长（秒；不含 delay） */
  readonly elapsed: number;
  /** 当前循环进度 0..1（easing 前） */
  readonly progress: number;
  /** 已完成的循环数 */
  readonly loopsDone: number;
}

/** 补间动画 API（`tween` 顶层导出与 `engine.tween` 同一对象） */
export interface TweenApi {
  /**
   * 数值/向量属性插值：目标可以是 Entity（position/rotation/scale 变换、
   * fontSize/sortOrder 等数字字段）、UI Widget 字段（anchoredPosition/size 等
   * {x,y} 对象）或任意带同名字段的普通对象；创建即开始播放。
   *
   * ```ts
   * tween.to(this.entity, { position: { x: 5 }, scale: { y: 2 } }, 1.5);
   * ```
   */
  to(target: object, props: Record<string, TweenValue>, duration: number): Tween;
  /** 反向插值：props 为起点，渐变回开始时的当前值（常用作入场动画） */
  from(target: object, props: Record<string, TweenValue>, duration: number): Tween;
  /** 数值插值（onUpdate 收插值结果） */
  value(from: number, to: number, duration: number): Tween;
  /** 0xRRGGBB 颜色插值（RGB 通道各自线性；onUpdate 收 0xRRGGBB） */
  color(from: number, to: number, duration: number): Tween;
  /** 实体本地位置补间（= to(entity, { position: to }, duration)） */
  position(entity: Entity, to: TweenValue, duration: number): Tween;
  /** 实体本地旋转补间（度制欧拉角） */
  rotation(entity: Entity, toDeg: TweenValue, duration: number): Tween;
  /** 实体本地缩放补间 */
  scale(entity: Entity, to: TweenValue, duration: number): Tween;
  /** 串行组：依次播放子 tween（空数组立即完成）；组级 delay/loop 可用 */
  sequence(tweens: Tween[]): Tween;
  /** 并行组：同时播放子 tween（空数组立即完成）；组级 delay/loop 可用 */
  parallel(tweens: Tween[]): Tween;
  /** 纯延时占位（sequence / then 链用） */
  delay(seconds: number): Tween;
  /** 立即回调占位：下一帧触发 cb（sequence / then 链用） */
  call(cb: () => void): Tween;
  /** 停止全部活动 tween（complete = true 先快进终点并触发 onComplete） */
  killAll(complete?: boolean): void;
  /** 暂停全部活动 tween */
  pauseAll(): void;
  /** 恢复全部暂停中的 tween */
  resumeAll(): void;
  /** 活动 tween 数（含暂停中的） */
  readonly activeCount: number;
  /** 全局时间缩放（0 = 冻结全部 tween；负数按 0） */
  timeScale: number;
}

/** 补间动画系统（与 engine.tween 同一对象） */
export const tween: TweenApi;

// ---------------------------------------------------------------------------
// 脚本通用系统：委托（多播事件）与对象池。两者均为纯脚本设施，与引擎接线无关，
// 在预览/发布产物中行为一致。
// ---------------------------------------------------------------------------

/**
 * 委托：多播事件容器（参考 C# 多播委托）。
 * 用于把"某件事发生"广播给多个订阅者——组件间解耦通信的标准设施：
 *
 * ```ts
 * import { Delegate, Component, engine } from "tve";
 *
 * export class GameEvents extends Component {
 *   static readonly onScore = new Delegate<(delta: number) => void>();
 * }
 * // 订阅方（任意组件）：
 * const token = GameEvents.onScore.add((delta) => engine.log("得分", delta));
 * GameEvents.onScore.remove(token);   // 或 remove(原函数)
 * // 发布方：
 * GameEvents.onScore.invoke(10);
 * ```
 *
 * 语义：同一函数重复订阅只登记一次；invoke 按订阅顺序逐个调用（快照迭代，
 * 回调内 add/remove 安全）；单个回调抛错被隔离上报，不影响其余回调。
 * 建议在组件 onDestroy 中 clear()，避免悬挂订阅。
 */
export class Delegate<T extends (...args: never[]) => unknown = () => void> {
  /** @internal 由脚本直接 new，无需参数 */
  constructor();
  /** 已订阅回调数量 */
  readonly count: number;
  /**
   * 订阅回调（同一函数重复订阅只登记一次）。
   * @returns 移除令牌（退订时传回 remove；成员函数建议用令牌退订）
   */
  add(handler: T): DelegateToken;
  /** 退订回调：传 add 返回的令牌或原函数均可。返回是否移除了一个订阅 */
  remove(tokenOrHandler: DelegateToken | T): boolean;
  /** 清空全部订阅（onDestroy 中调用可防悬挂订阅） */
  clear(): void;
  /** 广播：按订阅顺序逐个调用全部回调（参数透传给每个订阅者） */
  invoke(...args: Parameters<T>): void;
}

/** 委托移除令牌（不透明句柄；只能从 Delegate.add 获得） */
export interface DelegateToken {
  /** @internal 令牌序号 */
  readonly __delegateToken: number;
}

/**
 * 对象池：复用对象，避免频繁创建/销毁带来的卡顿与 GC 压力。
 * 典型用途：子弹、特效、飘字、临时列表等高频小对象：
 *
 * ```ts
 * import { Pool, Component, engine } from "tve";
 *
 * interface Bullet { active: boolean; x: number; y: number; }
 *
 * export default class Gun extends Component {
 *   private pool = new Pool<Bullet>(
 *     () => ({ active: false, x: 0, y: 0 }),        // 工厂：新建
 *     { reset: (b) => { b.active = false; }, initial: 10, max: 100 },
 *   );
 *
 *   fire() {
 *     const b = this.pool.get();                    // 复用空闲对象，池空才新建
 *     b.active = true;
 *     // ...使用后归还：
 *     this.pool.put(b);
 *   }
 * }
 * ```
 *
 * 语义：get 优先复用空闲对象（池空才调用工厂新建）；put 先调 reset 清理再入池
 * （空闲数达 max 上限则丢弃交给 GC）；池只回收自己发出的对象——外来对象或重复
 * 归还返回 false。reset 抛错被捕获忽略（告警上告）。
 */
export class Pool<T> {
  /** @internal factory = 对象工厂；options 全部可选 */
  constructor(factory: () => T, options?: {
    /** 归还时的清理回调（put 时调用；抛错被捕获忽略） */
    reset?: (item: T) => void;
    /** 预热数量（创建即备好空闲对象） */
    initial?: number;
    /** 空闲上限（超出后归还的对象被丢弃交给 GC） */
    max?: number;
  });
  /** 空闲对象数量 */
  readonly count: number;
  /** 累计创建的对象总数（评估池命中率用） */
  readonly totalCreated: number;
  /** 预热：提前创建 n 个空闲对象（受 max 上限约束） */
  prewarm(n: number): void;
  /** 取一个对象：优先复用空闲对象，池空则新建 */
  get(): T;
  /** 归还对象：先 reset 清理再入池；非本池对象/重复归还返回 false */
  put(item: T): boolean;
  /** 清空空闲列表（释放引用交给 GC；不影响已借出的对象） */
  clear(): void;
}

// ---------------------------------------------------------------------------
// 数据中心：跨组件共享的命名数据仓库，内置热/冷分解——热数据（活动工作集）
// 即时读写，闲置/超量的数据自动"降温"为冻结快照（冷区），再次访问自动"回温"。
// ---------------------------------------------------------------------------

/** 数据中心配置项（configure 增量合并） */
export interface DataCenterOptions {
  /** 热容量上限：热数据条数超过该值时，清扫按最久未访问（LRU）降冷（缺省 64） */
  hotLimit?: number;
  /** 冷却时长（毫秒）：热数据闲置超过该时长，清扫时降冷（缺省 30000） */
  coldTtl?: number;
  /** 惰性自动清扫开关（set/get/has 访问时按 sweepInterval 触发；缺省 true） */
  autoSweep?: boolean;
  /** 自动清扫最小间隔（毫秒；缺省 10000） */
  sweepInterval?: number;
}

/** 统计快照（观测热/冷分布与命中情况） */
export interface DataCenterStats {
  /** 热数据条数 */
  hot: number;
  /** 冷数据条数 */
  cold: number;
  /** 累计清扫次数 */
  sweeps: number;
  /** 累计回温次数（冷数据被访问后转热） */
  promotions: number;
  /** 累计命中次数 */
  hits: number;
  /** 累计未命中次数 */
  misses: number;
}

/**
 * 数据中心：跨组件共享的命名数据仓库，内置热/冷分解。
 *
 * ```ts
 * import { dataCenter, Component } from "tve";
 *
 * export default class Game extends Component {
 *   onStart() {
 *     dataCenter.set("score", 0);            // 写即热
 *   }
 *   onEnemyKilled() {
 *     const score = dataCenter.get<number>("score") ?? 0;
 *     dataCenter.set("score", score + 10);   // 其他组件可随时读取
 *   }
 *   onDestroy() {
 *     dataCenter.delete("score");            // 用完清理，避免悬挂数据
 *   }
 * }
 * ```
 *
 * 热/冷语义：
 * - 写入（set）即进入热区，即时生效；
 * - 长期未访问或超出热容量（hotLimit）的数据在清扫时**降冷**为冻结快照
 *   （深拷贝隔离——冷数据不受后续改动影响）；
 * - 读取冷数据自动**回温**为热数据并返回快照值；
 * - 清扫默认按 sweepInterval 惰性自动触发，也可手动 `sweep()`；
 * - 冷数据建议存纯数据（普通对象/数组/原始值）；含函数等不可克隆对象按
 *   结构化克隆 → JSON → 原引用逐级兜底。
 */
export class DataCenter {
  /** @internal 可 new 出隔离实例（不影响全局单例 dataCenter） */
  constructor(options?: DataCenterOptions);
  /** 调整容量/冷却策略（增量合并） */
  configure(options: DataCenterOptions): void;
  /** 写入数据（写即热；同名冷数据快照被覆盖） */
  set<T>(key: string, value: T): void;
  /**
   * 读取数据：热数据返回活动引用（改动实时生效）；冷数据自动回温后返回快照值；
   * 未命中返回 defaultValue。
   */
  get<T>(key: string, defaultValue?: T): T | undefined;
  /** 是否存在该键（热或冷） */
  has(key: string): boolean;
  /** 删除数据（热/冷一并移除）。返回是否存在 */
  delete(key: string): boolean;
  /** 全部键名（热 + 冷） */
  keys(): string[];
  /** 热数据键名（当前活动工作集） */
  hotKeys(): string[];
  /** 冷数据键名（已降冷的冻结快照） */
  coldKeys(): string[];
  /** 手动回温指定键。返回是否存在 */
  warm(key: string): boolean;
  /** 手动降冷指定键（值以冻结快照形式进入冷区）。返回是否降冷 */
  cool(key: string): boolean;
  /** 手动清扫（闲置 ≥ coldTtl 降冷 + 超出 hotLimit 按 LRU 降冷）。返回降冷条数 */
  sweep(): number;
  /** 统计快照 */
  stats(): DataCenterStats;
}

/** 全局数据中心单例（跨组件共享游戏数据；需要隔离时 new DataCenter()） */
export const dataCenter: DataCenter;

// ---------------------------------------------------------------------------
// 内置组件门面（getComponent / addComponent / 组件字段声明的对象）。
// 门面 = 组件设置 + 运行时后端的实时视图：属性写入即时生效（预览运行态，
// 不回写场景文件）；@internal 构造器由运行时创建，脚本不要 new。
// ---------------------------------------------------------------------------

/** 刚体组件门面：mode 为刚体形态；物理方法与 engine.physics 同名接口等价（已绑定本实体） */
export declare class RigidBody {
  /** @internal 由运行时构造，脚本不要直接 new */
  constructor();
  /** 宿主实体 */
  readonly entity: Entity;
  /** 组件引用 id（运行时创建的组件为生成 id） */
  readonly id: string;
  /** 刚体形态：static（隐式静态）/ kinematic（运动学）/ dynamic（动力学） */
  readonly mode: "static" | "kinematic" | "dynamic";
  /** 当前重力缩放 */
  readonly gravityScale: number;
  /** 碰撞体数量 */
  readonly colliderCount: number;
  /** 设置重力缩放（0 = 不受重力） */
  setGravityScale(scale: number): void;
  /** 直接设置线速度（m/s） */
  setLinearVelocity(x: number, y: number, z: number): void;
  /** 读取线速度 */
  getLinearVelocity(): Vec3 | null;
  /** 施加冲量（世界空间，N·s） */
  applyImpulse(x: number, y: number, z: number): void;
  /** 唤醒 */
  wakeUp(): void;
}

/** 兼容别名（旧版以接口形式提供刚体门面类型） */
export type RigidBodyFacade = RigidBody;

/** 碰撞体组件门面（只读信息；形状/表面材质在检查器编辑，运行时不可变） */
export declare class Collider {
  /** @internal 由运行时构造，脚本不要直接 new */
  constructor();
  /** 宿主实体 */
  readonly entity: Entity;
  /** 组件引用 id */
  readonly id: string;
  /** 场景中命中的碰撞形状（box/sphere/capsule/cylinder/convex） */
  readonly shape: string;
  /** 是否传感器（只产生触发不产生碰撞响应） */
  readonly isSensor: boolean;
  /** 摩擦系数 */
  readonly friction: number;
  /** 弹性系数 */
  readonly restitution: number;
  /** 物理世界中的碰撞体数量 */
  readonly count: number;
}

/** 灯光组件门面：设置写入即时同步到活动灯光对象（类型切换重建灯光） */
export declare class Light {
  /** @internal 由运行时构造，脚本不要直接 new */
  constructor();
  /** 宿主实体 */
  readonly entity: Entity;
  /** 组件引用 id */
  readonly id: string;
  /** 是否启用（禁用 = 灯光对象隐藏） */
  get enabled(): boolean;
  set enabled(value: boolean);
  /** 灯光类型：point/directional/spot/ambient（写入即重建灯光对象） */
  get kind(): "point" | "directional" | "spot" | "ambient";
  set kind(value: "point" | "directional" | "spot" | "ambient");
  /** 光色（0xRRGGBB） */
  get color(): number;
  set color(value: number);
  /** 强度 */
  get intensity(): number;
  set intensity(value: number);
  /** 渲染层级掩码（灯光 Culling Mask：只照亮掩码内层的对象；-1 = 全部层） */
  get cullingMask(): number;
  set cullingMask(value: number);
  /** 点光/聚光灯：照射距离（0 = 无限远） */
  get distance(): number;
  set distance(value: number);
  /** 点光/聚光灯：物理衰减指数 */
  get decay(): number;
  set decay(value: number);
  /** 聚光灯：光束半角（度） */
  get angle(): number;
  set angle(value: number);
  /** 聚光灯：边缘柔和度 0~1 */
  get penumbra(): number;
  set penumbra(value: number);
  /** 点光/平行光/聚光灯：投射阴影 */
  get castShadow(): boolean;
  set castShadow(value: boolean);
  /** 阴影浓度 0~1（1 = 纯黑阴影） */
  get shadowStrength(): number;
  set shadowStrength(value: number);
  /** 阴影深度偏移（压制自阴影麻点） */
  get shadowBias(): number;
  set shadowBias(value: number);
  /** 阴影法线偏移（≤0 = 自动按纹素相对化） */
  get shadowNormalBias(): number;
  set shadowNormalBias(value: number);
  /** 阴影近裁剪面（比这更近的物体不参与投影） */
  get shadowNear(): number;
  set shadowNear(value: number);
  /** 阴影软化半径（PCF 采样核，1 = 硬阴影；Soft 档 = 4） */
  get shadowRadius(): number;
  set shadowRadius(value: number);
  /** 阴影贴图分辨率（0 = 自动：平面 2048 / 点光 1024；512~4096 显式档位，写入重建灯光对象） */
  get shadowResolution(): number;
  set shadowResolution(value: number);
  /** Shadow 类型档位（"off" | "hard" | "soft"；读写投射开关 + 软化半径） */
  get shadowType(): "off" | "hard" | "soft";
  set shadowType(value: "off" | "hard" | "soft");
}

/** 音源组件门面：播放控制按组件 id 寻址；设置写入经运行时合并生效 */
export declare class AudioSource {
  /** @internal 由运行时构造，脚本不要直接 new */
  constructor();
  /** 宿主实体 */
  readonly entity: Entity;
  /** 组件引用 id */
  readonly id: string;
  /** 音频资产引用（写入即重载） */
  get source(): string;
  set source(value: string);
  /** 自动播放（上下文就绪/节点入图后起播） */
  get autoplay(): boolean;
  set autoplay(value: boolean);
  /** 循环播放 */
  get loop(): boolean;
  set loop(value: boolean);
  /** 音量 0..1 */
  get volume(): number;
  set volume(value: number);
  /** 播放倍速 0.1..4 */
  get speed(): number;
  set speed(value: number);
  /** 空间化："2d" 全局 / "3d" 位置音源 */
  get spatial(): "2d" | "3d";
  set spatial(value: "2d" | "3d");
  /** 是否正在播放 */
  readonly playing: boolean;
  /** 是否处于暂停态 */
  readonly paused: boolean;
  /** 缓冲是否就绪 */
  readonly ready: boolean;
  /** 播放（暂停态续播；停止/播完态从头播） */
  play(): void;
  /** 停止并回到起点 */
  stop(): void;
  /** 暂停（保留进度） */
  pause(): void;
  /** 从暂停处继续 */
  resume(): void;
  /** 运行时音量（0~1） */
  setVolume(volume: number): void;
}

/** 关键帧动画剪辑组件门面（.anim 资产绑定 + 播放控制/进度/倍速） */
export declare class AnimationClip {
  /** @internal 由运行时构造，脚本不要直接 new */
  constructor();
  /** 宿主实体 */
  readonly entity: Entity;
  /** 组件引用 id */
  readonly id: string;
  /** .anim 资产相对路径（写入即重载剪辑；空串解绑） */
  get clip(): string;
  set clip(value: string);
  /** 剪辑时长（秒；未加载为 0） */
  readonly duration: number;
  /** 播放进度（秒；写入即跳转采样） */
  get time(): number;
  set time(value: number);
  /** 播放速度倍率（>0） */
  get speed(): number;
  set speed(value: number);
  /** 循环播放 */
  get loop(): boolean;
  set loop(value: boolean);
  /** 自动播放（加载完成后起播） */
  get autoplay(): boolean;
  set autoplay(value: boolean);
  /** 是否正在推进 */
  readonly playing: boolean;
  /** 是否处于暂停态 */
  readonly paused: boolean;
  /** 从头播放 */
  play(): void;
  /** 暂停（保留进度） */
  pause(): void;
  /** 从暂停处继续 */
  resume(): void;
  /** 停止并回初始姿势 */
  stop(): void;
}

// —— 骨骼动画（模型内嵌动画）定义与图对象 ——

/** 模型动画循环模式 */
export type AnimLoopMode = "loop" | "once" | "pingpong";

/** 动画图状态定义（name 图内唯一；clip 须为模型内嵌剪辑名） */
export interface AnimStateDef {
  name: string;
  clip: string;
  /** 播放速度倍率（缺省 1） */
  speed?: number;
  /** 循环模式（缺省 loop） */
  loop?: AnimLoopMode;
}

/** 参数条件（布尔参数按 0/1 参与数值比较） */
export interface AnimConditionDef {
  param: string;
  op: ">" | "<" | ">=" | "<=" | "==" | "!=";
  value: number;
}

/** 动画图过渡定义：from → to，交叉淡化 duration 秒 */
export interface AnimTransitionDef {
  /** 过渡 id（缺省自动生成 t1/t2/…；图内唯一） */
  id?: string;
  from: string;
  to: string;
  /** 过渡时长（秒；缺省 0.25） */
  duration?: number;
  /** 归一化退出时间 0..1（>0 = 源状态播放到该进度才允许过渡；缺省 0） */
  exitTime?: number;
  /** 过渡条件（全部满足才过渡） */
  conditions?: AnimConditionDef[];
}

/** 动画图定义（SkeletalAnimation.ensureGraph / addComponent(SkeletalAnimation) 用；
 *  运行期 graph getter 返回同构的活对象，states/transitions/entry/params 可直接改写） */
export interface AnimGraphDef {
  /** 入口状态名（缺省首个状态） */
  entry?: string;
  states: AnimStateDef[];
  transitions?: AnimTransitionDef[];
  /** 参数表（数值或布尔；条件评估的输入） */
  params?: Record<string, number | boolean>;
}

// —— 蒙皮控制类型（对应 three 官网 animation/skinning 系列示例）——

/** 骨骼本地变换快照（rotation 为度制欧拉，与节点 transform 同度制） */
export interface BoneTransform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

/** 骨骼层级条目（parent 为骨骼名，根骨骼为 null） */
export interface BoneHierarchyEntry {
  name: string;
  parent: string | null;
  children: string[];
}

/** 形态键分组（某网格的全部形态键名） */
export interface MorphGroup {
  /** 网格名（未命名网格自动编号 mesh0/mesh1…） */
  mesh: string;
  /** 形态键名列表（权重按名读写） */
  targets: string[];
}

/** 蒙皮能力摘要 */
export interface SkinInfo {
  boneCount: number;
  boneNames: string[];
  /** 含形态键的网格数 */
  morphMeshes: number;
}

/** IK 链关节（effector → 根方向的逐级骨骼；rotationMin/Max 为度制欧拉数组） */
export interface IKLinkDef {
  /** 关节骨骼名 */
  bone: string;
  /** 旋转下限 [x,y,z]（度；缺省不限） */
  rotationMin?: number[];
  /** 旋转上限 [x,y,z]（度；缺省不限） */
  rotationMax?: number[];
  /** 是否启用该关节（缺省 true） */
  enabled?: boolean;
}

/** IK 链定义（CCD 求解；目标点由引擎创建并挂模型根下——局部空间） */
export interface IKDef {
  /** 可选名称（缺省同 id） */
  name?: string;
  /** 末端效应器骨骼名（必填） */
  effector: string;
  /** 关节链（从效应器的父级向根方向排列） */
  links?: IKLinkDef[];
  /** 每帧 CCD 迭代次数（缺省 1） */
  iteration?: number;
}

/** IK 链运行态条目 */
export interface IKEntry {
  id: string;
  name: string;
  effector: string;
  enabled: boolean;
}

/** 骨骼绑定选项（attachToBone 用） */
export interface BoneAttachOptions {
  /** 保持 attach 时刻的相对位姿（缺省 true；false = 对象原点对齐骨骼原点） */
  keepOffset?: boolean;
  /** 跟随骨骼旋转（缺省 true；false = 仅锚点位置跟随，姿态自主控制） */
  syncRotation?: boolean;
  /** 跟随骨骼缩放（缺省 false） */
  syncScale?: boolean;
}

/** 骨骼绑定运行态条目 */
export interface BoneAttachmentEntry {
  /** 目标节点 id */
  node: string;
  /** 骨骼名 / IK id / IK name */
  bone: string;
  syncRotation: boolean;
  syncScale: boolean;
  keepOffset: boolean;
}

/** 动画事件负载（finished/loop 回调参数） */
export interface AnimEventPayload {
  clip: string;
}

/**
 * 骨骼动画（模型内嵌动画）门面：单剪辑 anim / 动画图 animGraph 的运行期视图。
 * 仅模型网格节点（source=model）拥有绑定；图模式下 play(状态名) 切换状态，
 * setParam 写入图参数驱动条件过渡。
 */
export declare class SkeletalAnimation {
  /** @internal 由运行时构造，脚本不要直接 new */
  constructor();
  /** 宿主实体 */
  readonly entity: Entity;
  /** 模型内嵌剪辑名列表 */
  readonly clips: string[];
  /** 当前播放的剪辑名（图模式为当前状态绑定的剪辑；未播放 null） */
  readonly currentClip: string | null;
  /** 是否正在播放 */
  readonly playing: boolean;
  /** 当前剪辑名（缺省取首个；写入即切换播放，图模式下为目标状态名） */
  get clip(): string;
  set clip(value: string);
  /** 播放速度倍率（当前动作 + 单剪辑设置） */
  get speed(): number;
  set speed(value: number);
  /** 循环模式：loop/once/pingpong */
  get loop(): AnimLoopMode;
  set loop(value: AnimLoopMode);
  /** 自动播放（影响设置重放路径） */
  get autoplay(): boolean;
  set autoplay(value: boolean);
  /** 是否处于动画图模式 */
  readonly hasGraph: boolean;
  /** 动画图活对象（entry/states/transitions/params 可直接改写，下一帧评估生效；无图 null） */
  readonly graph: AnimGraphDef | null;
  /** 播放：clip 缺省取首个剪辑；图模式下参数为目标状态名（缺省回入口状态） */
  play(clipOrState?: string): void;
  /** 暂停（保留进度；图状态机暂停评估） */
  pause(): void;
  /** 从暂停处继续 */
  resume(): void;
  /** 停止并回初始姿势 */
  stop(): void;
  /** 图参数读取（无图/未声明返回 null） */
  getParam(name: string): number | boolean | null;
  /** 图参数写入（布尔/数值；条件评估每帧读取） */
  setParam(name: string, value: number | boolean): void;
  /** 创建/替换动画图（非法状态/过渡按引擎规则收敛剔除；成功返回 true） */
  ensureGraph(def: AnimGraphDef): boolean;
  /** 移除动画图（回单剪辑语义） */
  removeGraph(): void;
  /** 新增图状态（{name, clip, speed?, loop?}；重名拒绝，返回是否成功） */
  addState(state: AnimStateDef): boolean;
  /** 移除图状态（连带剔除涉及它的过渡） */
  removeState(name: string): boolean;
  /** 新增过渡（from/to 须为已有状态且不同；成功返回 true） */
  addTransition(transition: AnimTransitionDef): boolean;
  /** 移除过渡（按 id） */
  removeTransition(id: string): boolean;

  // —— 蒙皮完全控制（运行时控制不落盘；对应 three 官网 skinning 示例）——

  /** 蒙皮能力摘要（{boneCount, boneNames, morphMeshes}；未绑定模型 null） */
  readonly skinInfo: SkinInfo | null;

  /** 动作权重（确保动作在播；0 即静默层。与 play/stop 的 currentClip 语义独立） */
  setWeight(clip: string, w: number): boolean;
  /** 动作当前有效权重（淡入淡出进行中的实时值；未命中 null） */
  getWeight(clip: string): number | null;
  /** 权重 0→1 淡入（缺省 0.25 秒） */
  fadeIn(clip: string, dur?: number): boolean;
  /** 权重→0 淡出（动作本身不停止） */
  fadeOut(clip: string, dur?: number): boolean;
  /** 交叉淡化 from→to（warp=true 自动对齐两动作相位） */
  crossFade(from: string, to: string, dur?: number, warp?: boolean): boolean;
  /** 单动作播放速度（与 globalSpeed 相乘生效） */
  setActionSpeed(clip: string, scale: number): boolean;
  /** 单动作循环模式（"loop"/"once"/"pingpong"；once 定格末帧） */
  setActionLoop(clip: string, mode: AnimLoopMode): boolean;
  /** 停止单个动作（不影响其他混合层） */
  stopAction(clip: string): boolean;
  /** 一次性动作：定格末帧后自动淡回基础动作（表情/挥手等，缺省 0.25 秒过渡） */
  playOneShot(clip: string, fade?: number): boolean;
  /** 全局播放速度（mixer 速度，影响全部动作） */
  globalSpeed(scale: number): boolean;
  /** 订阅动作播完事件（LoopOnce 到达末帧；负载 {clip}），返回注销函数 */
  onFinished(cb: (e: AnimEventPayload) => void): () => void;
  /** 订阅动作循环事件（负载 {clip}），返回注销函数 */
  onLoop(cb: (e: AnimEventPayload) => void): () => void;

  /** 以加法混合叠加播放剪辑（权重独立于基础层；未转换剪辑惰性 makeClipAdditive） */
  playAdditive(clip: string, weight?: number): boolean;
  /** 停止加法层动作 */
  stopAdditive(clip: string): boolean;

  /** 骨骼名列表（无骨骼返回 []） */
  readonly bones: string[];
  /** 骨骼层级（[{name,parent,children}]） */
  readonly boneHierarchy: BoneHierarchyEntry[];
  /** 骨骼本地变换快照（未命中 null） */
  getBoneTransform(name: string): BoneTransform | null;
  /** 骨骼本地位移。注意：动作播放中 mixer 每帧覆写被驱动骨骼；手动写入适用于
   *  暂停/未被驱动的骨骼，或每帧覆写场景（IK/朝向） */
  setBonePosition(name: string, x: number, y: number, z: number): boolean;
  /** 骨骼本地旋转（度制欧拉） */
  setBoneRotation(name: string, x: number, y: number, z: number): boolean;
  /** 骨骼本地缩放 */
  setBoneScale(name: string, x: number, y: number, z: number): boolean;
  /** 复位单个骨骼到绑定姿势 */
  resetBone(name: string): boolean;
  /** 复位全部骨骼到绑定姿势 */
  resetPose(): boolean;
  /** 骨骼世界坐标（未命中 null） */
  getBoneWorldPosition(name: string): Vec3 | null;

  /** 形态键清单（[{mesh, targets}]） */
  readonly morphs: MorphGroup[];
  /** 形态键权重写入（0..1；mesh 传 "" 取首个含该目标的网格） */
  setMorphWeight(mesh: string, target: string, v: number): boolean;
  /** 形态键权重读取（未命中 null） */
  getMorphWeight(mesh: string, target: string): number | null;

  /** 注册 IK 链（目标点挂模型根下局部空间；成功返回 IK id，失败 null） */
  addIK(def: IKDef): string | null;
  /** 移除 IK（solver 不再更新） */
  removeIK(id: string): boolean;
  /** IK 启停 */
  setIKEnabled(id: string, v: boolean): boolean;
  /** 目标点位置（模型根局部空间） */
  setIKTargetPosition(id: string, x: number, y: number, z: number): boolean;
  /** 目标点位置读取（未命中 null） */
  getIKTargetPosition(id: string): Vec3 | null;
  /** IK 清单（[{id,name,effector,enabled}]） */
  readonly iks: IKEntry[];

  /** 把场景节点绑到骨骼/IK 目标上每帧跟随（target 为 Entity 或节点 id，须在模型
   *  子树之外；bone 传骨骼名、IK id 或 IK name；见 BoneAttachOptions） */
  attachToBone(target: Entity | string, bone: string, opts?: BoneAttachOptions): boolean;
  /** 解除节点绑定（target 为 Entity 或节点 id） */
  detach(target: Entity | string): boolean;
  /** 绑定清单（[{node, bone, syncRotation, syncScale, keepOffset}]） */
  readonly attachments: BoneAttachmentEntry[];
}

// —— addComponent 创建参数 ——

/** addComponent(Light) 创建参数（缺省项回默认） */
export interface LightAddOptions {
  kind?: "point" | "directional" | "spot" | "ambient";
  /** 光色（0xRRGGBB；lightColor 别名） */
  color?: number;
  lightColor?: number;
  intensity?: number;
  /** 渲染层级掩码（灯光 Culling Mask：只照亮掩码内层的对象；-1 = 全部层） */
  cullingMask?: number;
  distance?: number;
  decay?: number;
  /** 聚光灯光束半角（度） */
  angle?: number;
  penumbra?: number;
  castShadow?: boolean;
  /** 阴影浓度 0~1 */
  shadowStrength?: number;
  /** 阴影深度偏移 */
  shadowBias?: number;
  /** 阴影法线偏移（≤0 = 自动） */
  shadowNormalBias?: number;
  /** 阴影近裁剪面 */
  shadowNear?: number;
  /** 阴影软化半径（1 = 硬阴影，Soft 档 = 4） */
  shadowRadius?: number;
  /** 阴影贴图分辨率（0 = 自动：平面 2048 / 点光 1024；512~4096 显式档位） */
  shadowResolution?: number;
  /** Shadow 类型档位（优先于 castShadow/shadowRadius） */
  shadowType?: "off" | "hard" | "soft";
}

/** addComponent(AudioSource) 创建参数（缺省项回默认） */
export interface AudioSourceAddOptions {
  /** 音频资产引用（项目内相对路径） */
  source?: string;
  autoplay?: boolean;
  loop?: boolean;
  volume?: number;
  speed?: number;
  spatial?: "2d" | "3d";
  refDistance?: number;
  maxDistance?: number;
  rolloff?: number;
}

/** addComponent(AnimationClip) 创建参数（缺省项回默认） */
export interface AnimationClipAddOptions {
  /** .anim 资产相对路径（可后续经门面 clip 写入） */
  clip?: string;
  autoplay?: boolean;
  loop?: boolean;
  speed?: number;
}

/** addComponent(SkeletalAnimation) 创建参数（仅模型网格节点；缺省项回默认） */
export interface SkeletalAnimationAddOptions {
  /** 播放剪辑名 / 目标状态名 */
  clip?: string;
  autoplay?: boolean;
  speed?: number;
  loop?: AnimLoopMode;
  /** 动画图定义（传入即创建动画图模式） */
  graph?: AnimGraphDef;
}

// ---------------------------------------------------------------------------
// engine 入口
// ---------------------------------------------------------------------------

/** 帧时间信息 */
export interface TimeState {
  /** 距上一帧的秒数 */
  readonly delta: number;
  /** 运行期累计秒数 */
  readonly elapsed: number;
  /** 帧序号（从 1 开始） */
  readonly frame: number;
}

/** 指针状态（坐标 = 画布内 CSS 像素；pointerId 从按下到抬起恒定，多点触控区分各触点） */
export interface PointerState {
  readonly x: number;
  readonly y: number;
  readonly down: boolean;
  readonly pointerId: number;
}

/**
 * 键盘与指针输入。按键用 KeyboardEvent.code（如 "KeyW"、"Space"、"ArrowLeft"）。
 * 键盘支持任意多键同时按住（keys / isKeyDown 轮询 + onKeyDown/KeyUp 事件）；
 * 指针支持多点触控（pointers / getPointer 按 pointerId 区分各触点，
 * 鼠标也是其中一个触点，pointerId 通常恒定）。
 */
export interface InputApi {
  /** 按键当前是否按下 */
  isKeyDown(key: string): boolean;
  /** 当前按下的全部按键（KeyboardEvent.code 实时集合；勿直接修改） */
  readonly keys: ReadonlySet<string>;
  /** 订阅按键按下；返回取消订阅函数 */
  onKeyDown(handler: (key: string) => void): () => void;
  /** 订阅按键抬起；返回取消订阅函数 */
  onKeyUp(handler: (key: string) => void): () => void;
  /** 主指针状态（x/y 跟随最后活跃触点；down = 存在按下中的触点） */
  readonly pointer: PointerState;
  /** 按下中的全部触点（pointerId → 状态 实时映射；勿直接修改） */
  readonly pointers: ReadonlyMap<number, PointerState>;
  /** 按 pointerId 查触点（未按下返回 null） */
  getPointer(pointerId: number): PointerState | null;
  /** 订阅指针按下；返回取消订阅函数 */
  onPointerDown(handler: (pointer: PointerState) => void): () => void;
  /** 订阅指针抬起；返回取消订阅函数 */
  onPointerUp(handler: (pointer: PointerState) => void): () => void;
  /** 订阅指针取消（系统抢占：浏览器手势等；触点被强制移除，不会再来 onPointerUp）；返回取消订阅函数 */
  onPointerCancel(handler: (pointer: PointerState) => void): () => void;
  /** 订阅指针移动；返回取消订阅函数 */
  onPointerMove(handler: (pointer: PointerState) => void): () => void;
}

/** 场景查询 */
export interface SceneApi {
  /** 根实体（空场景为 null） */
  readonly root: Entity | null;
  /** 从根开始按名称/路径查找（语义同 Entity.find） */
  find(nameOrPath: string): Entity | null;
  /** 全部实体（快照数组） */
  findAll(): Entity[];
  /** 按标签查实体（返回第一个命中；无命中/空标签返回 null） */
  findByTag(tag: string): Entity | null;
  /** 按标签查实体（文档序全量；无命中返回空数组） */
  findAllByTag(tag: string): Entity[];
  /**
   * 全场景按类型查组件：token = 脚本类 /
   * 脚本源路径 / 脚本类名 / 内置组件门面类 / 类型键；返回文档序第一个命中
   * （未命中 null）。
   */
  findComponent(token: string | ComponentClass | (new (...args: never[]) => Component)): Component | RigidBody | Collider | Light | AudioSource | AnimationClip | SkeletalAnimation | null;
  /** 全场景按类型查组件（文档序全量；无命中返回空数组） */
  findComponents(token: string | ComponentClass | (new (...args: never[]) => Component)): Array<Component | RigidBody | Collider | Light | AudioSource | AnimationClip | SkeletalAnimation>;
}

/** 模型动画运行期控制（按实体寻址；仅模型网格节点有效） */
export interface AnimationApi {
  /** 播放（单剪辑模式 clip = 剪辑名缺省取首个；动画图模式 clip = 目标状态名） */
  play(entity: Entity, clip?: string): void;
  /** 停止并回到初始姿势 */
  stop(entity: Entity): void;
  /** 暂停（保留当前进度） */
  pause(entity: Entity): void;
  /** 从暂停处继续 */
  resume(entity: Entity): void;
}

/**
 * 音频运行期控制（按实体寻址；音源节点与挂音源组件的节点有效，
 * 实体上多个音源时寻址首个）
 */
export interface AudioApi {
  /** 播放（暂停态续播；停止/播完态从头播） */
  play(entity: Entity): void;
  /** 停止并回到起点 */
  stop(entity: Entity): void;
  /** 暂停（保留当前进度） */
  pause(entity: Entity): void;
  /** 从暂停处继续 */
  resume(entity: Entity): void;
  /** 运行时音量（0~1；不落盘） */
  setVolume(entity: Entity, volume: number): void;
}

/**
 * 粒子系统运行期控制（按实体寻址；仅粒子系统节点有效）。
 * 拿到 {@link ParticleSystemNode} 实体时也可直接调用其同名方法/属性。
 */
export interface ParticlesApi {
  /** 播放（暂停态续播；停止/播完态从头开始） */
  play(entity: Entity): void;
  /** 暂停（保留当前粒子） */
  pause(entity: Entity): void;
  /** 停止发射（存活粒子自然消亡） */
  stop(entity: Entity): void;
  /** 清空粒子并从头开始 */
  restart(entity: Entity): void;
  /** 立即清空全部粒子 */
  clear(entity: Entity): void;
  /** 运行态（非粒子节点返回 null） */
  stateOf(entity: Entity): ParticleState | null;
  /** 合并发射设置（子集；运行态生效，不回写场景文件） */
  setSettings(entity: Entity, patch: Partial<ParticleSettings>): void;
}

/** 物理运行期控制（按实体寻址；仅挂了刚体组件的节点有效） */
export interface PhysicsApi {
  /** 施加冲量（世界空间，N·s；动力学体） */
  applyImpulse(entity: Entity, x: number, y: number, z: number): void;
  /** 施加持续力（世界空间，N；动力学体，每帧调用生效） */
  applyForce(entity: Entity, x: number, y: number, z: number): void;
  /** 直接设置线速度（m/s） */
  setLinearVelocity(entity: Entity, x: number, y: number, z: number): void;
  /** 直接设置角速度（rad/s） */
  setAngularVelocity(entity: Entity, x: number, y: number, z: number): void;
  /** 读取线速度（未绑定/世界未就绪返回 null） */
  getLinearVelocity(entity: Entity): Vec3 | null;
  /** 节点物理体信息（未绑定刚体/碰撞体返回 null） */
  bodyInfo(entity: Entity): { mode: "static" | "kinematic" | "dynamic"; gravityScale: number; colliderCount: number } | null;
  /** 重力缩放（0 = 不受重力） */
  setGravityScale(entity: Entity, scale: number): void;
  /** 唤醒（修改参数后让睡眠中的体立即响应） */
  wakeUp(entity: Entity): void;
  /** 世界重力（影响全部动力学体） */
  setGravity(x: number, y: number, z: number): void;
  /** 射线投射（世界空间；返回按距离升序排列的命中列表；空数组 = 未命中） */
  castRay(options: {
    /** 射线起点（世界空间） */
    origin: Vec3;
    /** 射线方向（世界空间；无需归一化） */
    direction: Vec3;
    /** 最大距离（缺省 Infinity） */
    maxDistance?: number;
    /** 返回所有命中（缺省 false = 仅最近命中；当前仅返回最近命中） */
    allHits?: boolean;
    /** 排除的节点 id 列表（不参与命中） */
    excludeNodeIds?: string[];
  }): PhysicsRayHit[] | Promise<PhysicsRayHit[]>;
}

/** 物理射线命中结果（世界空间） */
export interface PhysicsRayHit {
  /** 命中刚体所属节点 id */
  nodeId: string;
  /** 命中点世界坐标 */
  point: Vec3;
  /** 命中面法线（世界空间，归一化） */
  normal: Vec3;
  /** 沿射线从起点到命中点的世界距离 */
  distance: number;
}

/** UI 画布屏幕度量（屏幕像素 ↔ UI 单位换算用；随窗口尺寸/缩放模式变化，建议每帧读取） */
export interface UIScreenMetrics {
  /** 渲染画布 CSS 尺寸（屏幕像素；与 engine.input.pointer 同一空间） */
  width: number;
  height: number;
  /** 屏幕矩形在 UI 单位下的尺寸（由缩放模式与窗口比例决定） */
  rootWidth: number;
  rootHeight: number;
  /** 每单位像素数（= width/rootWidth、height/rootHeight） */
  pxPerUnitX: number;
  pxPerUnitY: number;
  /** 画布缩放模式 */
  scaleMode: UIScaleMode;
  /** 设计尺寸（设计像素，100px = 1 UI 单位） */
  designWidth: number;
  designHeight: number;
}

/** UI 矩形（画布局部空间：原点 = 画布中心，y 向上；单位 = UI 单位） */
export interface UIRect {
  /** 中心（画布局部） */
  cx: number;
  cy: number;
  /** 宽高（UI 单位） */
  w: number;
  h: number;
}

/** 二维坐标（画布局部空间：原点 = 画布中心，y 向上；单位 = UI 单位） */
export interface UIPoint {
  x: number;
  y: number;
}

/** UI 运行期控制（画布叠加序读写 + 按钮点击订阅 + 布局/坐标查询；按实体寻址） */
export interface UIApi {
  /** 合并 Widget/画布设置（子集；运行态生效，不回写场景文件） */
  set(entity: Entity, patch: Record<string, unknown>): void;
  /** 读取 Widget/画布当前设置快照（非 UI 节点返回 null） */
  get(entity: Entity): Record<string, unknown> | null;
  /** 订阅按钮点击（仅 uiButtonNode 且 interactable；返回解绑函数） */
  onClick(entity: Entity, cb: () => void): () => void;
  /** 解除按钮点击订阅 */
  offClick(entity: Entity, cb: () => void): void;
  /**
   * UI 节点的解析矩形（画布局部空间）：锚点/拉伸/布局容器解析后的实际渲染矩形。
   * 沿途经过的布局容器（横/竖/网格排列）子节点返回的是布局槽位矩形。
   * 非 UI 节点、不在画布子树内或首帧布局解析未完成时返回 null。
   */
  rectOf(entity: Entity): UIRect | null;
  /**
   * 实体所在 UI 画布（沿父链向上）的屏幕度量。
   * 屏幕像素 → UI 单位：ui = (px - width/2) / pxPerUnitX（y 轴取反）；
   * 非 UI 节点返回 null。
   */
  metricsOf(entity: Entity): UIScreenMetrics | null;
  /**
   * 屏幕像素坐标 → 画布局部 UI 坐标（x/y 与 engine.input.pointer 同一空间；
   * 结果原点 = 画布中心，y 向上，可直接与 rectOf 结果做包含/距离判定）。
   * entity 用于定位所在画布；非 UI 节点返回 null。
   */
  screenToUi(entity: Entity, x: number, y: number): UIPoint | null;
}

/** 引擎入口（时间 / 输入 / 场景 / 动画 / 音频 / 粒子 / 物理 / UI / 逻辑 / 补间 / 日志） */
export interface EngineApi {
  readonly time: TimeState;
  readonly input: InputApi;
  readonly scene: SceneApi;
  readonly animation: AnimationApi;
  readonly audio: AudioApi;
  readonly particles: ParticlesApi;
  readonly physics: PhysicsApi;
  readonly ui: UIApi;
  /** 逻辑运行器（状态机/行为树）控制，详见 {@link LogicApi} */
  readonly logic: LogicApi;
  /** 补间动画（与顶层导出 tween 同一对象，详见 {@link TweenApi}） */
  readonly tween: TweenApi;
  /** 输出到编辑器控制台（预览）/ 浏览器控制台（发布产物） */
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 引擎全局入口 */
export const engine: EngineApi;

/** 向量数学库（纯函数，详见 {@link MathApi}） */
export const math: MathApi;

/** SDK 版本（与编辑器/播放器同版发布） */
export const VERSION: string;
