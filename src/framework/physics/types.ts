// ---------------------------------------------------------------------------
// 物理系统数据类型（framework 层，不依赖 app/api 与 three）。
//
// 刚体组件（RigidBody）+ 碰撞体组件（Collider）以组件引用挂在任意节点上：
// - 刚体声明运动学形态：static（静态，不参与模拟位移）/ kinematic（运动学，
//   由节点变换/动画驱动并推开动力学体）/ dynamic（动力学，由模拟驱动节点）；
// - 碰撞体声明形状与表面材质（摩擦/弹性/传感器）；无刚体只有碰撞体的节点
//   视为隐式静态碰撞体（常规静态碰撞体语义）；
// - 读取时经 parse* 统一收敛（缺失/越界字段回退默认），保证旧场景兼容。
// ---------------------------------------------------------------------------

import type { Vec3 } from "../prototype/types";

/** 物理后端（工厂模式：每种后端一个适配器，惰性加载引擎） */
export type PhysicsBackendId = "ammo" | "jolt" | "rapier";

/** 默认物理后端（场景设置缺失/未知时回退） */
export const DEFAULT_PHYSICS_BACKEND: PhysicsBackendId = "rapier";

/** 是否合法的后端 id */
export function isPhysicsBackendId(v: unknown): v is PhysicsBackendId {
  return v === "ammo" || v === "jolt" || v === "rapier";
}

/** 刚体形态：静态 | 运动学 | 动力学 */
export type RigidBodyMode = "static" | "kinematic" | "dynamic";

/** 刚体组件设置（node.components[type=rigidBody].rigidBody 的形状） */
export interface RigidBodySettings {
  /** 运动学形态 */
  mode: RigidBodyMode;
  /** 质量（kg，dynamic 有效；>0） */
  mass: number;
  /** 线性阻尼 */
  linearDamping: number;
  /** 角阻尼 */
  angularDamping: number;
  /** 重力缩放（0 = 不受重力） */
  gravityScale: number;
  /** 连续碰撞检测（高速物体防穿透） */
  ccd: boolean;
  /** 锁定旋转（碰撞不改变姿态，防撞倒） */
  lockRotation: boolean;
  /** 直立不倒（只保留水平旋转：碰撞不翻倒，脚本仍可水平转向） */
  upright: boolean;
}

export const DEFAULT_RIGID_BODY_SETTINGS: RigidBodySettings = {
  mode: "dynamic",
  mass: 1,
  linearDamping: 0.05,
  angularDamping: 0.05,
  gravityScale: 1,
  ccd: false,
  lockRotation: false,
  upright: false,
};

/** 碰撞形状（尺寸可从节点渲染包围盒自动推导，或显式指定） */
export type ColliderShape = "box" | "sphere" | "capsule" | "cylinder" | "convex";

/** 碰撞体组件设置（node.components[type=collider].collider 的形状） */
export interface ColliderSettings {
  /** 形状 */
  shape: ColliderShape;
  /** 尺寸来源：true = 按节点渲染包围盒自动推导；false = 用 size 显式指定 */
  autoSize: boolean;
  /** 显式尺寸（全尺寸；box=xyz 边长，sphere 直径取 x，capsule/cylinder 直径取 x、柱高取 y） */
  size: Vec3;
  /** 相对节点原点的局部偏移 */
  offset: Vec3;
  /** 摩擦系数（0 = 无摩擦） */
  friction: number;
  /** 弹性系数（0 = 不反弹） */
  restitution: number;
  /** 传感器：只产生触发不产生碰撞响应 */
  isSensor: boolean;
}

export const DEFAULT_COLLIDER_SETTINGS: ColliderSettings = {
  shape: "box",
  autoSize: true,
  size: { x: 1, y: 1, z: 1 },
  offset: { x: 0, y: 0, z: 0 },
  friction: 0.6,
  restitution: 0.1,
  isSensor: false,
};

function str(v: unknown, fb: string): string {
  return typeof v === "string" ? v : fb;
}
function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}
function bool(v: unknown, fb: boolean): boolean {
  return typeof v === "boolean" ? v : fb;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function parseVec3(v: unknown, fb: Vec3): Vec3 {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    x: num(o.x, fb.x),
    y: num(o.y, fb.y),
    z: num(o.z, fb.z),
  };
}

/** 任意来源 → 收敛的刚体设置（缺失/非法字段回退默认） */
export function parseRigidBodySettings(v: unknown): RigidBodySettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const mode = str(o.mode, DEFAULT_RIGID_BODY_SETTINGS.mode);
  return {
    mode:
      mode === "static" || mode === "kinematic" || mode === "dynamic"
        ? mode
        : DEFAULT_RIGID_BODY_SETTINGS.mode,
    mass: clamp(num(o.mass, DEFAULT_RIGID_BODY_SETTINGS.mass), 0.001, 1e6),
    linearDamping: Math.max(0, num(o.linearDamping, DEFAULT_RIGID_BODY_SETTINGS.linearDamping)),
    angularDamping: Math.max(0, num(o.angularDamping, DEFAULT_RIGID_BODY_SETTINGS.angularDamping)),
    gravityScale: Math.max(0, num(o.gravityScale, DEFAULT_RIGID_BODY_SETTINGS.gravityScale)),
    ccd: bool(o.ccd, DEFAULT_RIGID_BODY_SETTINGS.ccd),
    lockRotation: bool(o.lockRotation, DEFAULT_RIGID_BODY_SETTINGS.lockRotation),
    upright: bool(o.upright, DEFAULT_RIGID_BODY_SETTINGS.upright),
  };
}

/** 任意来源 → 收敛的碰撞体设置 */
export function parseColliderSettings(v: unknown): ColliderSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const shape = str(o.shape, DEFAULT_COLLIDER_SETTINGS.shape);
  return {
    shape: (
      ["box", "sphere", "capsule", "cylinder", "convex"] as const
    ).includes(shape as ColliderShape)
      ? (shape as ColliderShape)
      : DEFAULT_COLLIDER_SETTINGS.shape,
    autoSize: bool(o.autoSize, DEFAULT_COLLIDER_SETTINGS.autoSize),
    size: parseVec3(o.size, DEFAULT_COLLIDER_SETTINGS.size),
    offset: parseVec3(o.offset, DEFAULT_COLLIDER_SETTINGS.offset),
    friction: clamp(num(o.friction, DEFAULT_COLLIDER_SETTINGS.friction), 0, 4),
    restitution: clamp(num(o.restitution, DEFAULT_COLLIDER_SETTINGS.restitution), 0, 1),
    isSensor: bool(o.isSensor, DEFAULT_COLLIDER_SETTINGS.isSensor),
  };
}

/** 深拷贝刚体设置（节点克隆/编辑工作副本） */
export function cloneRigidBodySettings(s: RigidBodySettings): RigidBodySettings {
  return { ...s };
}

/** 深拷贝碰撞体设置 */
export function cloneColliderSettings(s: ColliderSettings): ColliderSettings {
  return {
    ...s,
    size: { ...s.size },
    offset: { ...s.offset },
  };
}

/** 运行时状态快照（检查器/弹层展示用） */
export interface PhysicsRuntimeState {
  /** 当前生效后端（世界就绪后非空） */
  backend: PhysicsBackendId | null;
  /** 物理世界是否就绪（引擎异步初始化完成） */
  worldReady: boolean;
  /** 世界正在异步初始化 */
  worldLoading: boolean;
  /** 模拟进行中 */
  simulating: boolean;
  /** 模拟已暂停 */
  paused: boolean;
  /** 绑定是否就绪（刚体/碰撞体已建入物理世界） */
  ready: boolean;
  /** 失败原因（后端加载失败/非法数据时非空） */
  error: string | null;
}
