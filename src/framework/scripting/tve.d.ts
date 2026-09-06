// ---------------------------------------------------------------------------
// tve —— 引擎脚本 SDK 类型契约（模块说明符 "tve"）。
//
// 用户脚本以 `import { Component, engine } from "tve"` 访问引擎能力。
// 本文件是脚本类型的唯一事实源：编辑器（Monaco 智能提示 / 诊断）直接加载本文件，
// 运行时实现在 public/web-preview/libs/tve.mjs（播放器侧；两者保持镜像同步）。
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

/** 组件属性类型（检查器按此渲染编辑控件） */
export type PropType = "number" | "string" | "boolean" | "color" | "vec3";

/** 单个组件属性的定义 */
export interface PropDef {
  /** 值类型（color = "#rrggbb" 字符串；vec3 = Vec3 对象） */
  type: PropType;
  /** 默认值 */
  default: number | string | boolean | Vec3;
  /** 检查器显示名（缺省用属性名） */
  label?: string;
  /** number 专用：最小值 / 最大值 / 步进 */
  min?: number;
  max?: number;
  step?: number;
}

/** 组件属性表（脚本类以 `static props = { ... }` 声明） */
export interface PropsSchema {
  [key: string]: PropDef;
}

/** 组件属性值集合（泛型可收窄：`Component<{ speed: number }>`） */
export type ComponentProps = Record<string, unknown>;

/**
 * 脚本组件基类。用户脚本默认导出一个 Component 子类：
 *
 * ```ts
 * import { Component, engine } from "tve";
 *
 * export default class Spin extends Component {
 *   static props = {
 *     speed: { type: "number", default: 90, label: "速度", min: 0 },
 *   } ;
 *
 *   onStart() {
 *     engine.log("挂载于", this.entity.name);
 *   }
 *
 *   onUpdate(delta: number) {
 *     this.entity.rotate(0, (this.props.speed as number) * delta, 0);
 *   }
 * }
 * ```
 */
export class Component<P extends ComponentProps = ComponentProps> {
  /**
   * 属性定义表：子类以 `static props = {...}` 声明后，检查器自动渲染
   * 对应类型的编辑控件，未在节点上配置的属性取 default。
   */
  static props?: PropsSchema;

  /**
   * @internal 由运行时构造（挂载到节点时创建实例），脚本不要直接 new。
   */
  constructor(entity: Entity, props: P);

  /** 宿主实体（挂载所在节点） */
  readonly entity: Entity;

  /** 属性值（已合并默认值；只读视图，运行期不要改写） */
  readonly props: Readonly<P>;

  /** 生命周期：全部脚本实例创建后调用一次 */
  onStart?(): void;

  /** 生命周期：每帧调用（delta = 距上一帧的秒数） */
  onUpdate?(delta: number): void;

  /** 生命周期：实例销毁时调用（静态场景运行期保留，预留接口） */
  onDestroy?(): void;
}

/** 场景实体（节点在脚本运行期的句柄；变换与编辑器同一套语义，旋转为度制欧拉角） */
export class Entity {
  /** @internal 由运行时构造 */
  constructor();

  /** 节点 id（与场景文件中的节点 id 一致） */
  readonly id: string;

  /** 名称（可写，即时生效） */
  get name(): string;
  set name(value: string);

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

/** 引擎入口（时间 / 输入 / 场景 / 动画 / 日志） */
export interface EngineApi {
  readonly time: TimeState;
  readonly input: InputApi;
  readonly scene: SceneApi;
  readonly animation: AnimationApi;
  /** 输出到编辑器控制台（预览）/ 浏览器控制台（发布产物） */
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 引擎全局入口 */
export const engine: EngineApi;

/** SDK 版本（与编辑器/播放器同版发布） */
export const VERSION: string;
