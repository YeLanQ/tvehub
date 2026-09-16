// ---------------------------------------------------------------------------
// 物理后端抽象（引擎无关词汇表）：
// - IPhysicsWorld / IPhysicsBody 是三个后端适配器（rapier/jolt/ammo）共同实现
//   的最小接口；PhysicsSystem 只面向该接口编程，后端切换零改动；
// - 所有位姿均为世界空间（three 场景坐标系，米制）；四元数与 three 约定一致；
// - 适配器内部负责与各引擎原生对象互转，不泄漏任何引擎类型到框架层。
// ---------------------------------------------------------------------------

import type { Vec3 } from "../../prototype/types";
import type { ColliderShape, PhysicsBackendId, RigidBodyMode } from "../types";

/** 四元数（three 约定：x,y,z,w） */
export interface PhysicsQuat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** 单个碰撞形状描述（已换算为世界单位的半尺寸/半径） */
export interface ColliderShapeDesc {
  shape: ColliderShape;
  /** box 半尺寸 */
  halfExtents: Vec3;
  /** sphere 半径；capsule/cylinder 半径 */
  radius: number;
  /** capsule/cylinder 柱段半高（不含半球） */
  halfHeight: number;
  /** convex：局部空间顶点采样（平面数组 xyz…；box 兜底当为空） */
  points: number[];
  /**
   * heightfield：高度网格（行主序 samples×samples，局部空间；已烘焙 Y 缩放）。
   * XZ 铺在 [-sizeX/2, sizeX/2] × [-sizeZ/2, sizeZ/2]（见 terrainSizeX/Z），
   * 采样间距 = sizeX/(samples-1) / sizeZ/(samples-1)。
   */
  heights: Float32Array | null;
  /** heightfield：每轴采样数（2 的幂；heights 为 null 时无意义） */
  samples: number;
  /** heightfield：XZ 全边长（局部空间，已烘焙 XZ 缩放） */
  terrainSizeX: number;
  terrainSizeZ: number;
  /** heightfield：高度最小/最大值（引擎中线对齐与 Ammo 高度范围用） */
  minHeight: number;
  maxHeight: number;
  /** 相对刚体原点的偏移 */
  offset: Vec3;
  friction: number;
  restitution: number;
  isSensor: boolean;
}

/** 刚体创建描述（世界空间初始位姿 + 形态参数 + 碰撞形状列表） */
export interface PhysicsBodyDesc {
  nodeId: string;
  mode: RigidBodyMode;
  position: Vec3;
  quaternion: PhysicsQuat;
  colliders: ColliderShapeDesc[];
  /** 质量（kg，dynamic 生效；仅动态体） */
  mass: number;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;
  ccd: boolean;
  /** 锁定旋转（碰撞不改变姿态，防撞倒） */
  lockRotation: boolean;
  /** 直立不倒（只保留水平旋转；lockRotation 优先） */
  upright: boolean;
}

/** 刚体位姿快照（世界空间） */
export interface PhysicsTransform {
  position: Vec3;
  quaternion: PhysicsQuat;
}

/** 物理刚体句柄（适配器实现；PhysicsSystem 经它驱体单个节点） */
export interface IPhysicsBody {
  readonly nodeId: string;
  /** 切换运动学形态（static/kinematic/dynamic；尽可能原地切换） */
  setMode(mode: RigidBodyMode): void;
  /** 运动学体下一帧目标位姿（kinematic 有效；驱动节点推开动力学体） */
  setKinematicTarget(position: Vec3, quaternion: PhysicsQuat): void;
  /** 传送位姿（static/kinematic 有效；编辑态跟随节点变换） */
  setTransform(position: Vec3, quaternion: PhysicsQuat): void;
  /** 回读位姿（dynamic/kinematic；模拟位移后的世界位姿） */
  readTransform(): PhysicsTransform | null;
  setMass(mass: number): void;
  setDamping(linear: number, angular: number): void;
  setGravityScale(scale: number): void;
  setCcd(enabled: boolean): void;
  applyImpulse(impulse: Vec3): void;
  applyForce(force: Vec3): void;
  setLinearVelocity(v: Vec3): void;
  setAngularVelocity(v: Vec3): void;
  getLinearVelocity(): Vec3 | null;
  wakeUp(): void;
}

/** 射线投射单个命中结果（世界空间） */
export interface PhysicsRayHit {
  /** 命中刚体所属节点 id */
  nodeId: string;
  /** 命中点世界坐标 */
  point: Vec3;
  /** 命中面法线（世界空间；归一化） */
  normal: Vec3;
  /** 沿射线从起点到命中点的世界距离 */
  distance: number;
}

/** 射线查询参数 */
export interface PhysicsRayCastOptions {
  /** 射线起点（世界空间） */
  origin: Vec3;
  /** 射线方向（世界空间；无需归一化，内部按 |direction| 截断 maxDistance） */
  direction: Vec3;
  /** 最大距离（默认 Infinity） */
  maxDistance?: number;
  /** 返回所有命中（默认 false = 仅最近命中）；当前三后端均仅返回最近命中 */
  allHits?: boolean;
  /** 排除的节点 id 列表（不参与命中） */
  excludeNodeIds?: string[];
}

/** 物理世界设置 */
export interface PhysicsWorldSettings {
  gravity: Vec3;
  /**
   * 引擎脚本/WASM 资源根目录（ammo 离线构建所在目录；末尾不带斜杠）。
   * 编辑器与播放器的静态资源布局不同，由接入方注入；缺省用编辑器路径。
   */
  engineBaseUrl?: string;
}

/** 物理世界句柄（适配器实现） */
export interface IPhysicsWorld {
  readonly backend: PhysicsBackendId;
  setGravity(g: Vec3): void;
  /** 创建刚体（含全部碰撞形状）；非法描述返回 null */
  createBody(desc: PhysicsBodyDesc): IPhysicsBody | null;
  destroyBody(body: IPhysicsBody): void;
  /** 推进一步（dt 由系统按固定步长切片后传入） */
  step(dt: number): void;
  /** 射线投射（世界空间；返回按距离升序排列的命中列表） */
  castRay(options: PhysicsRayCastOptions): PhysicsRayHit[];
  dispose(): void;
}
