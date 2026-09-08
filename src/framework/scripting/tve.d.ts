// ---------------------------------------------------------------------------
// tve —— 引擎脚本 SDK 类型契约（模块说明符 "tve"）。
//
// 用户脚本以 `import { Component, property, nodeType, engine } from "tve"`
// 访问引擎能力。本文件是脚本类型的唯一事实源：编辑器（Monaco 智能提示 /
// 诊断）直接加载本文件，运行时实现在 public/web-preview/libs/tve.mjs
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
 */
export function property(options?: {
  /**
   * 值类型。基本类型：number/string/boolean/color/vec3（缺省按字段初值推断）；
   * 或节点类型类：把该属性声明为场景节点引用（检查器选择场景节点，
   * 运行期字段为该节点的 Entity）。
   */
  type?: PropType | NodeClass;
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
 */
export class Component<P extends ComponentProps = ComponentProps> {
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

  /** 生命周期：全部脚本实例创建后、首个 onUpdate 前调用一次（初始化玩法逻辑） */
  onStart?(): void;

  /**
   * 生命周期：实例创建后调用（全部实例的 onEnable 先于全部 onStart，
   * 对齐 Unity 批次顺序）；此时可安全引用其他实体与组件。
   */
  onEnable?(): void;

  /** 生命周期：每帧调用（delta = 距上一帧的秒数） */
  onUpdate?(delta: number): void;

  /**
   * 生命周期：页面卸载/预览停机时调用一次（先于 onDestroy），用于释放
   * 定时器/事件订阅等外部资源。
   */
  onDisable?(): void;

  /** 生命周期：实例销毁时调用（页面卸载/预览停机时先于本回调触发 onDisable） */
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

  /** 取本实体上挂载的首个指定类型脚本组件（无则 null） */
  getComponent<T extends Component>(componentClass: new (...args: never[]) => T): T | null;
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

/** SDK 版本（与编辑器/播放器同版发布） */
export const VERSION: string;
