// ---------------------------------------------------------------------------
// 节点组件契约层：组件引用的公共接口 + 每种组件的类型接口 + 描述符接口。
//
// 编辑器侧组件保持纯数据（可辨识联合的 plain object）：Vue 响应式、撤销快照
// （node.patch 的 before/after JSON）、prefab 对象展开、序列化字节兼容都依赖
// 这一点；实例化与生命周期由播放器（engine/**/*.mjs）执行。
// 每种组件的创建/解析/克隆/写出/重置行为收敛到各自模块的描述符（实现
// ComponentDescriptor 接口，见同目录各 *Component.ts），由 registry.ts 查表派发。
// ---------------------------------------------------------------------------

import type { JsonRecord } from "../types";
import type { LightComponentKind } from "../../lighting/types";

/** 组件类型键（与序列化的 type 字段、component-registry 元数据一致） */
export type ComponentType =
  | "script"
  | "rigidBody"
  | "collider"
  | "light"
  | "audioSource"
  | "animationClip";

/** 组件引用公共字段 */
export interface INodeComponent {
  /** 组件实例 id（同节点内唯一） */
  id: string;
  /** 组件类型 */
  type: ComponentType;
  /** 是否启用（禁用的组件不参与运行） */
  enabled: boolean;
}

/**
 * 节点上的脚本组件引用（组件模式）。
 * 编辑器只持有数据（检查器增删改、随节点序列化）；实例化与生命周期由
 * 播放器脚本宿主（engine/core/scripts.mjs）在预览/发布产物中执行。
 */
export interface ScriptComponentRef extends INodeComponent {
  type: "script";
  /** 脚本源路径（项目内相对路径，如 "src/spin.ts"） */
  script: string;
  /** 执行顺序（小者先跑；同序按挂载顺序。0 = 缺省，序列化时省略保持旧文件字节兼容） */
  executionOrder: number;
  /** 属性值（检查器按脚本 static props 声明渲染编辑） */
  props: JsonRecord;
}

/**
 * 刚体组件引用：声明节点的运动学形态（static/kinematic/dynamic）。
 * 数据随节点序列化；模拟由物理系统在预览/播放时驱动（编辑态只同步数据）。
 */
export interface RigidBodyComponentRef extends INodeComponent {
  type: "rigidBody";
  rigidBody: import("../../physics/types").RigidBodySettings;
}

/**
 * 碰撞体组件引用：声明节点的碰撞形状与表面材质。
 * 同节点可挂多个碰撞体（复合形状）；无刚体只有碰撞体 = 隐式静态碰撞体。
 */
export interface ColliderComponentRef extends INodeComponent {
  type: "collider";
  collider: import("../../physics/types").ColliderSettings;
}

/**
 * 灯光组件引用：给任意节点附加一盏灯（组件模式；与灯光节点类层级并存）。
 * 编辑器由 SceneSynchronizer 在节点对象下同步真实 three 灯光 + 图标；
 * 播放器由 nodes.mjs 按组件数据重建灯光（与灯光节点同一光照语义）。
 */
export interface LightComponentRef extends INodeComponent {
  type: "light";
  light: import("../../lighting/types").LightComponentSettings;
}

/**
 * 音源组件引用：给任意节点附加一个声音发射器（复用 AudioNode 的音源设置）。
 * 编辑器由 AudioSystem 以组件 id 绑定（播放/暂停等运行时控制按组件 id 寻址）；
 * 播放器由 nodes.mjs 收集、audio.mjs 绑定（节点 id 命中首个音源，兼容 SDK 寻址）。
 */
export interface AudioSourceComponentRef extends INodeComponent {
  type: "audioSource";
  audio: import("../../audio/types").AudioSourceSettings;
}

/** 关键帧动画剪辑绑定（指向 .anim 资产 + 播放设置） */
export interface AnimClipBinding {
  /** .anim 资产相对路径（空 = 未绑定） */
  clip: string;
  autoplay: boolean;
  loop: boolean;
  /** 播放速度倍率 */
  speed: number;
}

/**
 * 关键帧动画剪辑组件引用：给任意节点附加一段自制关键帧动画
 * （.anim 资产，变换通道关键帧；与模型自带剪辑的 anim/animGraph 并存）。
 * 编辑器由动画编辑窗口制作剪辑；播放器每帧采样并应用到节点对象变换。
 */
export interface AnimationClipComponentRef extends INodeComponent {
  type: "animationClip";
  clip: AnimClipBinding;
}

/** 节点组件引用（可辨识联合，按 type 收敛） */
export type NodeComponentRef =
  | ScriptComponentRef
  | RigidBodyComponentRef
  | ColliderComponentRef
  | LightComponentRef
  | AudioSourceComponentRef
  | AnimationClipComponentRef;

export function isScriptComponent(c: NodeComponentRef): c is ScriptComponentRef {
  return c.type === "script";
}
export function isRigidBodyComponent(c: NodeComponentRef): c is RigidBodyComponentRef {
  return c.type === "rigidBody";
}
export function isColliderComponent(c: NodeComponentRef): c is ColliderComponentRef {
  return c.type === "collider";
}
export function isLightComponent(c: NodeComponentRef): c is LightComponentRef {
  return c.type === "light";
}
export function isAudioSourceComponent(c: NodeComponentRef): c is AudioSourceComponentRef {
  return c.type === "audioSource";
}
export function isAnimationClipComponent(c: NodeComponentRef): c is AnimationClipComponentRef {
  return c.type === "animationClip";
}

/** 创建默认组件引用时的可选项（light 指定灯光类型；animationClip 预绑定剪辑） */
export interface ComponentCreateOptions {
  /** light 组件的灯光类型 */
  lightKind?: LightComponentKind;
  /** animationClip 组件的 .anim 资产相对路径 */
  clip?: string;
}

/**
 * 组件描述符：一种组件类型全部行为的单一接口。
 * 解析/克隆/写出的序列化字节兼容约定（如脚本 executionOrder=0 删键）由各
 * 描述符自行落地；registry.ts 只做查表派发，新增内置组件不再改公共链路。
 */
export interface ComponentDescriptor<C extends INodeComponent = INodeComponent> {
  /** 组件类型键（与 ref 的 type 字面量一致） */
  readonly type: C["type"];
  /**
   * JSON → 组件引用。公共字段 id/enabled 由调用方收敛后经 base 传入；
   * 返回 null 表示条目非法（解析时整条剔除，如脚本组件缺 script 路径）。
   */
  parse(raw: JsonRecord, base: { id: string; enabled: boolean }): C | null;
  /** 创建默认组件引用（检查器「添加组件」入口；id 新生成、enabled = true） */
  createDefault(opts?: ComponentCreateOptions): C;
  /** 实例克隆（节点 clone；id 重新生成避免共享，payload 深拷贝） */
  cloneForInstance(c: C): C;
  /** 序列化拷贝（toJSON；id 保留，各类型写出约定在此落地） */
  cloneForWrite(c: C): C;
  /** 设置重置为默认值（检查器「重置」；原地改写，保留 id/enabled 与脚本路径/执行顺序） */
  resetSettings(c: C): void;
}
