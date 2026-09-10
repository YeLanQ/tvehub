// ---------------------------------------------------------------------------
// tve —— 引擎脚本 SDK 类型契约（模块说明符 "tve"）。
//
// 用户脚本以 `import { Component, property, nodeType, engine } from "tve"`
// 访问引擎能力。本文件是脚本类型的唯一事实源：编辑器（Monaco 智能提示 /
// 诊断）直接加载本文件，运行时实现在 public/engine/core/tve.mjs
// （播放器侧；两者保持镜像同步）。
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
  | "audioNode";

/** 节点类型 token 类的构造器形状（@property 的 type 选项可用） */
export type NodeClass =
  | typeof Transform
  | typeof MeshNode
  | typeof LightNode
  | typeof CameraNode
  | typeof SkyboxNode;

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
export type ScriptNodeKind = "node" | "meshNode" | "cameraNode" | "lightNode" | "skyboxNode";

// ---------------------------------------------------------------------------
// 装饰器（参考 Cocos Creator @property / @ccclass 的声明式写法）
// ---------------------------------------------------------------------------

/**
 * 属性装饰器：把成员字段声明为脚本组件的可编辑属性（检查器自动按字段类型
 * 渲染控件；字段初值即默认值；运行期直接以 `this.字段名` 读写）。
 *
 * 类型由字段初值推断：number / boolean / string；颜色字符串（#rrggbb 等）与
 * {x,y,z} 向量对象需显式传 type 或声明对应类型。
 *
 * **场景节点引用**：type 传节点类型类（Transform / MeshNode / LightNode /
 * CameraNode / SkyboxNode，或用小写别名 meshNode 等）即声明"引用一个场景节点"。
 * 检查器按类型过滤列出可选的场景节点，选择结果在运行期解析为该节点的 Entity
 * （未选择为 null）：
 *
 * ```ts
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
 * 节点类型装饰器（类装饰器，可选）：声明脚本类同时作为一种可创建的节点类型，
 * 出现在层级面板「添加节点 > 脚本节点」；创建时生成 kind 对应的基础节点并自动
 * 挂上本脚本组件（类似 Unity 中以脚本定义 GameObject 行为）。
 *
 * ```ts
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
 * 组件生命周期回调契约（Component 基类的钩子接口；全部可选，按需实现）。
 * 调度方为播放器脚本宿主（engine/core/scripts.mjs）：
 * 全部实例化后先统一 onEnable 再统一 onStart（对齐 Unity 批次顺序）；
 * 每帧先分派物理碰撞回调再调 onUpdate；停机时逐实例 onDisable → onDestroy。
 */
export interface ComponentLifecycle {
  /**
   * 生命周期：实例创建后调用（全部实例的 onEnable 先于全部 onStart，
   * 对齐 Unity 批次顺序）；此时可安全引用其他实体与组件。
   */
  onEnable?(): void;

  /** 生命周期：全部脚本实例创建后、首个 onUpdate 前调用一次（初始化玩法逻辑） */
  onStart?(): void;

  /** 生命周期：每帧调用（delta = 距上一帧的秒数） */
  onUpdate?(delta: number): void;

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
 * import { Component, property, engine } from "tve";
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
 * 生命周期：onStart 挂载后调用一次；onUpdate 每帧调用（delta = 秒）。
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
 * 没有则动态创建并立即进入生命周期（对齐 Unity RequireComponent）：
 *
 * ```ts
 * import type CameraFollow from "./CameraFollow";   // type-only：编译期擦除
 *
 * export default class Enemy extends Component {
 *   follow!: CameraFollow;   // 自动绑定/创建本实体上的 CameraFollow 组件
 *   hp!: HPBar;
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

  /** 生命周期：实例创建后调用（全部实例的 onEnable 先于全部 onStart，对齐 Unity 批次顺序） */
  onEnable?(): void;

  /** 生命周期：全部脚本实例创建后、首个 onUpdate 前调用一次（初始化玩法逻辑） */
  onStart?(): void;

  /** 生命周期：每帧调用（delta = 距上一帧的秒数） */
  onUpdate?(delta: number): void;

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

  /** 节点标签（GameObject Tag 语义；检查器 Node 卡设置，空串 = 无标签） */
  readonly tag: string;

  /** 可见性（可写，即时生效；含子级继承） */
  get visible(): boolean;
  set visible(value: boolean);

  /** 本地位置（读取返回快照副本；写入接受部分字段） */
  get position(): Vec3;
  set position(value: Vec3);

  /** 本地旋转（度制欧拉角 XYZ；读取返回快照副本；写入接受部分字段） */
  get rotation(): Vec3;
  set rotation(value: Vec3);

  /** 本地缩放（读取返回快照副本；写入接受部分字段） */
  get scale(): Vec3;
  set scale(value: Vec3);

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
   *   （"src/hp.ts" / "HPBar"）——对齐 Unity 按类型名查找：所有脚本类在加载后
   *   全局可见，脚本之间互相引用组件无需 import（严格模式下用
   *   `import type` 只引入类型即可获得智能提示）。
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

/** 灯光节点（编辑器 lightNode / pointLightNode / directionalLightNode / ambientLightNode / spotLightNode） */
export class LightNode extends Entity {}

/** 相机节点（编辑器 cameraNode） */
export class CameraNode extends Entity {}

/** 天空盒节点（编辑器 skyboxNode） */
export class SkyboxNode extends Entity {}

export {
  Transform as transform,
  MeshNode as meshNode,
  LightNode as lightNode,
  CameraNode as cameraNode,
  SkyboxNode as skyboxNode,
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
}

// ---------------------------------------------------------------------------
// 脚本通用系统：委托（多播事件）与对象池。两者均为纯脚本设施，与引擎接线无关，
// 在预览/发布产物中行为一致。
// ---------------------------------------------------------------------------

/**
 * 委托：多播事件容器（参考 C# Delegate / UnityEvent）。
 * 用于把"某件事发生"广播给多个订阅者——组件间解耦通信的标准设施：
 *
 * ```ts
 * import { Delegate, Component } from "tve";
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
  /** 平行光/聚光灯：投射阴影 */
  get castShadow(): boolean;
  set castShadow(value: boolean);
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
}

// —— addComponent 创建参数 ——

/** addComponent(Light) 创建参数（缺省项回默认） */
export interface LightAddOptions {
  kind?: "point" | "directional" | "spot" | "ambient";
  /** 光色（0xRRGGBB；lightColor 别名） */
  color?: number;
  lightColor?: number;
  intensity?: number;
  distance?: number;
  decay?: number;
  /** 聚光灯光束半角（度） */
  angle?: number;
  penumbra?: number;
  castShadow?: boolean;
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

/** 指针状态（坐标 = 画布内 CSS 像素） */
export interface PointerState {
  readonly x: number;
  readonly y: number;
  readonly down: boolean;
}

/** 键盘与指针输入。按键用 KeyboardEvent.code（如 "KeyW"、"Space"、"ArrowLeft"） */
export interface InputApi {
  /** 按键当前是否按下 */
  isKeyDown(key: string): boolean;
  /** 订阅按键按下；返回取消订阅函数 */
  onKeyDown(handler: (key: string) => void): () => void;
  /** 订阅按键抬起；返回取消订阅函数 */
  onKeyUp(handler: (key: string) => void): () => void;
  /** 指针当前状态 */
  readonly pointer: PointerState;
  /** 订阅指针按下；返回取消订阅函数 */
  onPointerDown(handler: (pointer: PointerState) => void): () => void;
  /** 订阅指针抬起；返回取消订阅函数 */
  onPointerUp(handler: (pointer: PointerState) => void): () => void;
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
   * 全场景按类型查组件（Unity FindObjectOfType 语义）：token = 脚本类 /
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
}

/** 引擎入口（时间 / 输入 / 场景 / 动画 / 音频 / 物理 / 日志） */
export interface EngineApi {
  readonly time: TimeState;
  readonly input: InputApi;
  readonly scene: SceneApi;
  readonly animation: AnimationApi;
  readonly audio: AudioApi;
  readonly physics: PhysicsApi;
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
