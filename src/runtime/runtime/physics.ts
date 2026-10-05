// ---------------------------------------------------------------------------
// 播放器物理运行时（独立于编辑器）：驱动挂了 刚体/碰撞体 组件的节点。
// 与编辑器 framework/physics 同一套数据语义（组件字段/签名差异/固定步长/
// static|kinematic|dynamic 三形态），实现为免打包的原生 ESM：
// - 引擎（WASM）按物理配置的 backend 惰性加载（项目 config.json 的 physics 字段，
//   旧产物回退场景 settings.physics），物理引擎构建位于
//   ./physics-engines/（rapier.mjs / jolt.mjs / ammo/ammo.wasm.js，随导出发布）；
// - physicsEnabled === true 时自动开始模拟；
//   未启用时返回安全空转 API（脚本调用不报错）；
// - 脚本经 engine.physics（tve.mjs 转发 host.physics，按节点 id 寻址）驱动
//   冲量/力/速度/重力缩放；
// - 碰撞事件：各后端收集「接触开始/结束」节点对（rapier EventQueue /
//   jolt ContactListenerJS / ammo 流形差分），脚本宿主经 drainCollisions()
//   排空并分发为组件的 onCollisionEnter/onCollisionExit。
// ---------------------------------------------------------------------------

import * as THREE from "../core/three.module.min.js";
import { postLog } from "../core/log";
import type { NodeJson } from "./node-json";
import type { SceneNodeEntry } from "./nodes";

// ---------------------------------------------------------------------------
// 类型（JSON 宽松视图 + 组件收敛 + 后端控制面 + Worker 协议）
// ---------------------------------------------------------------------------

/** JSON 来源的宽松对象（索引签名放行未知键） */
type UnknownRec = Record<string, unknown>;

/** 物理三维向量（纯数据；跨后端/Worker 边界传输） */
interface PhysVec3 {
  x: number;
  y: number;
  z: number;
}

/** 物理四元数（纯数据） */
interface PhysQuat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** 刚体设置（parseRigidBody 收敛结果） */
interface RigidBodySettings {
  mode: "static" | "kinematic" | "dynamic";
  mass: number;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;
  ccd: boolean;
  lockRotation: boolean;
  upright: boolean;
}

/** 碰撞体设置（parseCollider 收敛结果） */
interface ColliderSettings {
  shape: "box" | "sphere" | "capsule" | "cylinder" | "convex" | "heightfield";
  autoSize: boolean;
  size: PhysVec3;
  offset: PhysVec3;
  friction: number;
  restitution: number;
  isSensor: boolean;
  /** heightfield 采样档（0 = 自动对齐地形网格密度） */
  resolution: number;
}

/** 地形烘焙高度网格（heightfield 碰撞消费；SceneTerrainEntry.data 由 createTerrain 产出） */
interface TerrainGridData {
  heights: Float32Array;
  gridSize: number;
  size: number;
}

/** 碰撞形状描述（colliderDescFor 产物；各后端 buildShape 消费） */
interface ColliderDesc {
  shape: ColliderSettings["shape"];
  halfExtents: PhysVec3;
  radius: number;
  halfHeight: number;
  /** convex 采样点分量数组（x,y,z 扁平；世界缩放已烘入） */
  points: number[];
  /** heightfield 高度采样（行主序 [z][x]）；非 heightfield 为 null */
  heights: Float32Array | null;
  samples: number;
  terrainSizeX: number;
  terrainSizeZ: number;
  minHeight: number;
  maxHeight: number;
  offset: PhysVec3;
  friction: number;
  restitution: number;
  isSensor: boolean;
}

/** 建体描述（world.createBody 消费） */
interface BodyDesc {
  nodeId: string;
  mode: "static" | "kinematic" | "dynamic";
  position: PhysVec3;
  quaternion: PhysQuat;
  colliders: ColliderDesc[];
  mass: number;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;
  ccd: boolean;
  lockRotation: boolean;
  upright: boolean;
}

/** 刚体句柄（world.createBody 返回；api 经节点 id 寻址调用） */
interface BodyHandle {
  nodeId: string;
  setMode(mode: "static" | "kinematic" | "dynamic"): void;
  setKinematicTarget(p: PhysVec3, q: PhysQuat): void;
  setTransform(p: PhysVec3, q: PhysQuat): void;
  readTransform(): { position: PhysVec3; quaternion: PhysQuat } | null;
  setMass(mass: number): void;
  setDamping(l: number, a: number): void;
  setGravityScale(s: number): void;
  setCcd(on: boolean): void;
  applyImpulse(v: PhysVec3): void;
  applyForce(v: PhysVec3): void;
  setLinearVelocity(v: PhysVec3): void;
  setAngularVelocity(v: PhysVec3): void;
  getLinearVelocity(): PhysVec3 | null;
  wakeUp(): void;
  /** 后端原生体（后端内部销毁/索引用；跨句柄边界为 unknown） */
  raw: unknown;
}

/** 碰撞事件（节点 id 对 + 开始/结束） */
interface CollisionEvent {
  a: string;
  b: string;
  started: boolean;
}

/** 射线投射命中 */
interface RayHit {
  nodeId: string;
  point: PhysVec3;
  normal: PhysVec3;
  distance: number;
}

/** 射线投射选项 */
interface RaycastOptions {
  origin: PhysVec3;
  direction: PhysVec3;
  maxDistance?: number;
  excludeNodeIds?: string[];
}

/** 后端世界（loadXxx().createWorld 产物；三后端同构控制面） */
interface PhysicsWorld {
  setGravity(g: PhysVec3): void;
  createBody(desc: BodyDesc): BodyHandle | null;
  destroyBody(b: BodyHandle): void;
  step(dt: number): void;
  takeCollisionEvents(): CollisionEvent[];
  castRay(options: RaycastOptions): RayHit[];
  dispose(): void;
}

/** 后端加载器（动态 import 的 wasm 胶水工厂） */
type PhysicsBackendLoader = () => Promise<{ createWorld(gravity: PhysVec3): PhysicsWorld }>;
type PhysicsBackendId = "rapier" | "jolt" | "ammo";

/** 节点物理体信息（bodyInfo 返回；getComponent("rigidBody") 门面数据源） */
interface BodyInfo {
  mode: string;
  gravityScale: number;
  colliderCount: number;
}

/** 运动学目标位姿（setKinematicTarget 缓存；step 时消费） */
interface KinematicTarget {
  p: PhysVec3;
  q: PhysQuat;
}

/** 物理控制面（未启用/未就绪时安全空转；worker 模式同接口 + dispose） */
interface PhysicsApi {
  /** 运行线程标识（调试面板/回退告警消费） */
  workerMode: boolean;
  /** 每帧推进（渲染循环调用） */
  update(dt: number): void;
  setGravity(x: number, y: number, z: number): void;
  applyImpulse(nodeId: string, x: number, y: number, z: number): void;
  applyForce(nodeId: string, x: number, y: number, z: number): void;
  setLinearVelocity(nodeId: string, x: number, y: number, z: number): void;
  setAngularVelocity(nodeId: string, x: number, y: number, z: number): void;
  getLinearVelocity(nodeId: string): PhysVec3 | null;
  bodyInfo(nodeId: string): BodyInfo | null;
  setGravityScale(nodeId: string, scale: number): void;
  wakeUp(nodeId: string): void;
  /** 射线投射（worker 模式异步；主线程同步） */
  castRay(options: RaycastOptions): RayHit[] | Promise<RayHit[]>;
  /** 碰撞事件排空（脚本宿主每帧调用） */
  drainCollisions(): CollisionEvent[];
  /** 仅 worker 代理提供（终止线程） */
  dispose?(): void;
}

/** scene.settings.physics JSON（backend/gravity/physicsEnabled） */
interface ScenePhysicsSettingsJson {
  backend?: unknown;
  physicsEnabled?: unknown;
  gravity?: { x?: unknown; y?: unknown; z?: unknown };
  [key: string]: unknown;
}

/** 物理绑定节点输入（player 传 SceneNodeEntry；worker 代理节点多带 nodeId 字段） */
type PhysNodeInput = SceneNodeEntry & { nodeId?: string };

/** 地形条目输入（player 传 SceneTerrainEntry；worker 只传高度场纯数据） */
interface TerrainInput {
  json?: { id?: unknown; [key: string]: unknown } | null;
  data?: unknown;
}

/** createPhysics 入参 */
interface CreatePhysicsOptions {
  /** buildSceneTree 的全节点注册表 */
  nodes: ReadonlyArray<PhysNodeInput>;
  /** buildSceneTree 的地形节点收集（heightfield 碰撞读取烘焙高度网格） */
  terrains?: ReadonlyArray<TerrainInput>;
  /** scene.settings.physics */
  settings?: ScenePhysicsSettingsJson | Record<string, unknown> | null;
}

/** 节点物理绑定（组件解析产物 + 后端体句柄 + 动力学插值位姿缓存） */
interface PhysicsBinding {
  nodeId: string | undefined;
  obj: THREE.Object3D;
  rb: RigidBodySettings | null;
  colliders: { id: unknown; settings: ColliderSettings }[];
  /** 节点对应的烘焙高度网格（heightfield 消费；无地形为 null） */
  terrain: unknown;
  body: BodyHandle | null;
  /** 动力学体帧间插值缓存（与 hasPose 同帧赋值） */
  prevPos?: THREE.Vector3;
  prevQuat?: THREE.Quaternion;
  currPos?: THREE.Vector3;
  currQuat?: THREE.Quaternion;
  hasPose?: boolean;
}

/** 固定模拟步长（秒）与每帧最大子步数（与编辑器一致） */
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 4;

// ---------------------------------------------------------------------------
// 设置收敛（与 framework/physics/types.ts 同规则）
// ---------------------------------------------------------------------------

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function parseRigidBody(v: unknown): RigidBodySettings {
  const o = (v && typeof v === "object" ? v : {}) as UnknownRec; // 组件 JSON 宽松对象，逐字段收敛
  const mode = typeof o.mode === "string" ? o.mode : "dynamic";
  return {
    mode: mode === "static" || mode === "kinematic" || mode === "dynamic" ? mode : "dynamic",
    mass: clamp(num(o.mass, 1), 0.001, 1e6),
    linearDamping: Math.max(0, num(o.linearDamping, 0.05)),
    angularDamping: Math.max(0, num(o.angularDamping, 0.05)),
    gravityScale: Math.max(0, num(o.gravityScale, 1)),
    ccd: o.ccd === true,
    lockRotation: o.lockRotation === true,
    upright: o.upright === true,
  };
}

/** 高度场碰撞分辨率合法档位（2 的幂：Jolt HeightFieldShape 要求；与编辑器同集合）。
 *  512：大地图下 256 档采样间距粗于网格会削峰填谷（与编辑器 types.ts 同步改）。 */
const HF_RESOLUTIONS = [64, 128, 256, 512];
const HF_DEFAULT_RESOLUTION = 0; // 0 = 自动（对齐地形网格密度）

function snapHeightfieldResolution(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : HF_DEFAULT_RESOLUTION;
  if (n <= 0) return 0;
  let best: number = HF_RESOLUTIONS[0];
  for (const r of HF_RESOLUTIONS) {
    if (Math.abs(r - n) < Math.abs(best - n)) best = r;
  }
  return best;
}

/** 自动档解析：采样数 ≥ 地形网格单元格数的最小可用档（与编辑器同规则） */
function resolveHeightfieldSamples(resolution: number, gridN: number): number {
  if (resolution > 0) return resolution;
  const want = Math.max(2, Math.min(HF_RESOLUTIONS[HF_RESOLUTIONS.length - 1], gridN - 1));
  for (const r of HF_RESOLUTIONS) {
    if (r >= want) return r;
  }
  return HF_RESOLUTIONS[HF_RESOLUTIONS.length - 1];
}

function parseCollider(v: unknown): ColliderSettings {
  const o = (v && typeof v === "object" ? v : {}) as UnknownRec; // 组件 JSON 宽松对象，逐字段收敛
  const shape = typeof o.shape === "string" ? o.shape : "box";
  const sz = (o.size && typeof o.size === "object" ? o.size : {}) as UnknownRec;
  const off = (o.offset && typeof o.offset === "object" ? o.offset : {}) as UnknownRec;
  return {
    // 与 ["box","sphere","capsule","cylinder","convex","heightfield"].includes(shape) 同语义（类型面收窄）
    shape: shape === "box" || shape === "sphere" || shape === "capsule" || shape === "cylinder" || shape === "convex" || shape === "heightfield" ? shape : "box",
    autoSize: o.autoSize !== false,
    size: { x: num(sz.x, 1), y: num(sz.y, 1), z: num(sz.z, 1) },
    offset: { x: num(off.x, 0), y: num(off.y, 0), z: num(off.z, 0) },
    friction: clamp(num(o.friction, 0.6), 0, 4),
    restitution: clamp(num(o.restitution, 0.1), 0, 1),
    isSensor: o.isSensor === true,
    resolution: snapHeightfieldResolution(o.resolution),
  };
}

// ---------------------------------------------------------------------------
// 碰撞形状推导（对象局部包围盒 + 世界缩放烘入尺寸；与编辑器同规则）
// ---------------------------------------------------------------------------

function computeLocalBounds(obj: THREE.Object3D): { center: PhysVec3; half: PhysVec3; points: number[] } | null {
  obj.updateWorldMatrix(true, true);
  const box = new THREE.Box3().makeEmpty();
  const objInv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const childMat = new THREE.Matrix4();
  let firstMesh: THREE.Mesh | null = null;
  let sampleAttr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null = null;
  obj.traverse((child) => {
    // 类型库只在 Mesh 声明 isMesh 标志（结构断言；非网格子对象保持原样跳过）
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    childMat.copy(mesh.matrixWorld).premultiply(objInv);
    const geo = mesh.geometry;
    geo.computeBoundingBox();
    if (geo.boundingBox) box.union(geo.boundingBox.clone().applyMatrix4(childMat));
    if (!firstMesh) {
      firstMesh = mesh;
      sampleAttr = geo.getAttribute("position") ?? null;
    }
  });
  if (box.isEmpty()) return null;
  const center = {
    x: (box.min.x + box.max.x) / 2,
    y: (box.min.y + box.max.y) / 2,
    z: (box.min.z + box.max.z) / 2,
  };
  const half = {
    x: Math.max(0.05, (box.max.x - box.min.x) / 2),
    y: Math.max(0.05, (box.max.y - box.min.y) / 2),
    z: Math.max(0.05, (box.max.z - box.min.z) / 2),
  };
  const points: number[] = [];
  // traverse 回调内的赋值不参与外层控制流分析 → 显式收窄（getAttribute 产物）
  const attr = sampleAttr as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null;
  if (attr) {
    const count = attr.count;
    const step = Math.max(1, Math.floor(count / 64));
    const v = new THREE.Vector3();
    for (let i = 0; i < count && points.length < 64 * 3; i += step) {
      v.fromBufferAttribute(attr, i).applyMatrix4(childMat);
      points.push(v.x, v.y, v.z);
    }
  }
  return { center, half, points };
}

/**
 * 高度网格下采样（碰撞 LOD；与编辑器 colliderShape.ts 同规则）：最近邻取点，
 * 输出每个采样都是源网格的真实烘焙高度。src 行主序 [iz*srcN + ix]。
 */
function downsampleHeightfield(src: Float32Array, srcN: number, samples: number, scaleY: number): Float32Array {
  const out = new Float32Array(samples * samples);
  const last = srcN - 1;
  for (let iz = 0; iz < samples; iz++) {
    const sz = Math.round((iz * last) / (samples - 1));
    for (let ix = 0; ix < samples; ix++) {
      const sx = Math.round((ix * last) / (samples - 1));
      out[iz * samples + ix] = src[sz * srcN + sx] * scaleY;
    }
  }
  return out;
}

/** 非地形节点选高度场形状的告警去重 */
let hfFallbackWarned = false;

/**
 * 碰撞形状推导（对象局部包围盒 + 世界缩放烘入尺寸；与编辑器同规则）。
 * terrainGrid：该节点的烘焙地形网格（{ heights, gridSize, size }，来自
 * buildSceneTree 的 terrains 收集），heightfield 形状需要；无数据回退盒形。
 */
function colliderDescFor(col: ColliderSettings, obj: THREE.Object3D, terrainGrid: TerrainGridData | null): ColliderDesc {
  const s = col;
  const ws = obj.getWorldScale(new THREE.Vector3());
  const sx = Math.abs(ws.x) || 1;
  const sy = Math.abs(ws.y) || 1;
  const sz = Math.abs(ws.z) || 1;
  if (s.shape === "heightfield") {
    const desc: ColliderDesc = {
      shape: "heightfield",
      halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
      radius: 0.5,
      halfHeight: 0.5,
      points: [],
      heights: null,
      samples: 0,
      terrainSizeX: 0,
      terrainSizeZ: 0,
      minHeight: 0,
      maxHeight: 0,
      offset: { x: s.offset.x, y: s.offset.y, z: s.offset.z },
      friction: s.friction,
      restitution: s.restitution,
      isSensor: s.isSensor,
    };
    if (!terrainGrid || !(terrainGrid.heights instanceof Float32Array) || terrainGrid.gridSize < 2) {
      if (!hfFallbackWarned) {
        hfFallbackWarned = true;
        postLog("warn", "[物理] heightfield 碰撞体找不到地形高度数据（仅 terrainNode 可用），已回退单位盒");
      }
      return desc;
    }
    const samples = resolveHeightfieldSamples(snapHeightfieldResolution(s.resolution), terrainGrid.gridSize);
    const heights = downsampleHeightfield(terrainGrid.heights, terrainGrid.gridSize, samples, sy);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];
      if (h < min) min = h;
      if (h > max) max = h;
    }
    desc.heights = heights;
    desc.samples = samples;
    desc.terrainSizeX = Math.max(0.001, terrainGrid.size * sx);
    desc.terrainSizeZ = Math.max(0.001, terrainGrid.size * sz);
    desc.minHeight = min;
    desc.maxHeight = max;
    return desc;
  }
  let half: PhysVec3 = { x: 0.5, y: 0.5, z: 0.5 };
  let center: PhysVec3 = { x: 0, y: 0, z: 0 };
  let points: number[] = [];
  if (s.autoSize) {
    const b = computeLocalBounds(obj);
    if (b) {
      half = b.half;
      center = b.center;
      points = b.points;
    }
  } else {
    half = { x: Math.max(0.05, s.size.x / 2), y: Math.max(0.05, s.size.y / 2), z: Math.max(0.05, s.size.z / 2) };
    if (s.shape === "convex") {
      const b = computeLocalBounds(obj);
      if (b) points = b.points;
    }
  }
  const uniform = (sx + sy + sz) / 3;
  const desc: ColliderDesc = {
    shape: s.shape,
    halfExtents: { x: Math.max(0.001, half.x * sx), y: Math.max(0.001, half.y * sy), z: Math.max(0.001, half.z * sz) },
    radius: Math.max(0.001, Math.max(half.x * sx, half.z * sz, s.shape === "sphere" ? half.y * sy : 0.001)),
    halfHeight: 0.5,
    points: [],
    heights: null,
    samples: 0,
    terrainSizeX: 0,
    terrainSizeZ: 0,
    minHeight: 0,
    maxHeight: 0,
    offset: {
      x: s.offset.x + (s.autoSize ? center.x : 0),
      y: s.offset.y + (s.autoSize ? center.y : 0),
      z: s.offset.z + (s.autoSize ? center.z : 0),
    },
    friction: s.friction,
    restitution: s.restitution,
    isSensor: s.isSensor,
  };
  switch (s.shape) {
    case "sphere":
      desc.radius = Math.max(0.001, uniform * Math.max(half.x, half.y, half.z));
      break;
    case "capsule":
      desc.radius = Math.max(0.001, Math.max(half.x * sx, half.z * sz));
      desc.halfHeight = Math.max(0.001, half.y * sy);
      break;
    case "cylinder":
      desc.radius = Math.max(0.001, Math.max(half.x * sx, half.z * sz));
      desc.halfHeight = Math.max(0.001, half.y * sy);
      break;
    case "convex": {
      if (points.length) {
        const scaled: number[] = new Array(points.length);
        for (let i = 0; i + 2 < points.length; i += 3) {
          scaled[i] = points[i] * sx;
          scaled[i + 1] = points[i + 1] * sy;
          scaled[i + 2] = points[i + 2] * sz;
        }
        desc.points = scaled;
      }
      break;
    }
    default:
      break;
  }
  return desc;
}

// ---------------------------------------------------------------------------
// 后端适配器（工厂模式：rapier | jolt | ammo，与编辑器适配器同构）
// ---------------------------------------------------------------------------

// —— rapier wasm 胶水最小消费面（真实类型由动态 import 的 rapier.mjs 提供，
//    结构接口只声明本文件用到的成员）——

/** rapier 碰撞体描述构造器（链式配置） */
interface RapierColliderDesc {
  setTranslation(x: number, y: number, z: number): RapierColliderDesc;
  setFriction(f: number): RapierColliderDesc;
  setRestitution(r: number): RapierColliderDesc;
  setSensor(s: boolean): RapierColliderDesc;
  setActiveEvents(e: number): RapierColliderDesc;
}

/** rapier 刚体描述构造器（链式配置） */
interface RapierBodyDesc {
  setTranslation(x: number, y: number, z: number): RapierBodyDesc;
  setRotation(q: PhysQuat): RapierBodyDesc;
  setLinearDamping(d: number): RapierBodyDesc;
  setAngularDamping(d: number): RapierBodyDesc;
  setGravityScale(s: number): RapierBodyDesc;
  setCcdEnabled(b: boolean): RapierBodyDesc;
}

interface RapierBody {
  lockRotations(lock: boolean, wakeUp: boolean): void;
  restrictRotations(x: boolean, y: boolean, z: boolean, wakeUp: boolean): void;
  setBodyType(type: number, wakeUp: boolean): void;
  setNextKinematicTranslation(p: PhysVec3): void;
  setNextKinematicRotation(q: PhysQuat): void;
  setTranslation(p: PhysVec3, wakeUp: boolean): void;
  setRotation(q: PhysQuat, wakeUp: boolean): void;
  isValid(): boolean;
  translation(): PhysVec3;
  rotation(): PhysQuat;
  numColliders(): number;
  collider(i: number): RapierCollider | null;
  setLinearDamping(d: number): void;
  setAngularDamping(d: number): void;
  setGravityScale(s: number): void;
  wakeUp(): void;
  enableCcd(on: boolean): void;
  applyImpulse(v: PhysVec3, wakeUp: boolean): void;
  addForce(v: PhysVec3, wakeUp: boolean): void;
  setLinvel(v: PhysVec3, wakeUp: boolean): void;
  setAngvel(v: PhysVec3, wakeUp: boolean): void;
  linvel(): PhysVec3;
}

interface RapierCollider {
  /** 碰撞体句柄（碰撞事件 → 节点 id 映射键） */
  handle: number;
  setMass(m: number): void;
}

interface RapierEventQueue {
  drainCollisionEvents(handler: (h1: number, h2: number, started: boolean) => void): void;
}

interface RapierRay {
  pointAt(t: number): PhysVec3;
}

interface RapierRayHit {
  collider: RapierCollider;
  timeOfImpact: number;
  normal: PhysVec3;
}

interface RapierWorld {
  gravity: PhysVec3;
  timestep: number;
  createRigidBody(desc: RapierBodyDesc): RapierBody;
  removeRigidBody(b: RapierBody): void;
  createCollider(desc: RapierColliderDesc, body: RapierBody): RapierCollider;
  step(eventQueue: RapierEventQueue): void;
  /** 末位谓词过滤（本文件只传谓词，其余过滤参数透传 undefined） */
  castRayAndGetNormal(
    ray: RapierRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: undefined,
    filterGroups?: undefined,
    filterExcludeCollider?: undefined,
    filterExcludeRigidBody?: undefined,
    filterPredicate?: (collider: RapierCollider) => boolean,
  ): RapierRayHit | null;
  free(): void;
}

/** rapier wasm 胶水（./physics-engines/rapier.mjs default 导出）最小消费面 */
interface RapierAPI {
  init(): Promise<void>;
  World: new (gravity: { x: number; y: number; z: number }) => RapierWorld;
  EventQueue: new (autoDrain: boolean) => RapierEventQueue;
  ColliderDesc: {
    ball(radius: number): RapierColliderDesc;
    capsule(halfHeight: number, radius: number): RapierColliderDesc;
    cylinder(halfHeight: number, radius: number): RapierColliderDesc;
    /** 返回 null = 凸包构建失败（点数不足/退化） */
    convexHull(points: Float32Array): RapierColliderDesc | null;
    cuboid(hx: number, hy: number, hz: number): RapierColliderDesc;
    heightfield(nrows: number, ncols: number, heights: Float32Array, scale: PhysVec3): RapierColliderDesc;
  };
  RigidBodyDesc: {
    fixed(): RapierBodyDesc;
    kinematicPositionBased(): RapierBodyDesc;
    dynamic(): RapierBodyDesc;
  };
  RigidBodyType: { Fixed: number; KinematicPositionBased: number; Dynamic: number };
  ActiveEvents: { COLLISION_EVENTS: number };
  Ray: new (origin: PhysVec3, dir: PhysVec3) => RapierRay;
}

async function loadRapier(): Promise<{ createWorld(gravity: PhysVec3): PhysicsWorld }> {
  // 字面量说明符：单页构建经 build.rs 重写为 import map 裸说明符（勿改成运行时拼 URL）
  // @ts-expect-error wasm 胶水为 src/runtime/extra 下的无类型 .mjs（构建期并入产物）
  const mod = await import("./physics-engines/rapier.mjs");
  const R = mod.default as RapierAPI; // 胶水 default 导出 = rapier 初始化器
  await R.init();
  return {
    createWorld(gravity: PhysVec3): PhysicsWorld {
      const world = new R.World({ x: gravity.x, y: gravity.y, z: gravity.z });
      const bodies = new Set<RapierBody>();
      // 碰撞事件收集（rapier EventQueue；句柄 → 节点 id 在 createBody 登记）
      const eventQueue = new R.EventQueue(true);
      const colliderNodes = new Map<number, string>();
      const pendingCollisions: CollisionEvent[] = [];
      // broadphase 是否已随 step 建树（建体后从未 step 时射线查询树为空）
      let steppedOnce = false;
      const shapeOf = (col: ColliderDesc): RapierColliderDesc => {
        switch (col.shape) {
          case "sphere":
            return R.ColliderDesc.ball(col.radius);
          case "capsule":
            return R.ColliderDesc.capsule(col.halfHeight, col.radius);
          case "cylinder":
            return R.ColliderDesc.cylinder(col.halfHeight, col.radius);
          case "convex": {
            if (col.points.length >= 12) {
              const hull = R.ColliderDesc.convexHull(new Float32Array(col.points));
              if (hull) return hull;
            }
            return R.ColliderDesc.cuboid(0.5, 0.5, 0.5);
          }
          case "heightfield": {
            // Rapier（parry）高度场：列主序矩阵，索引 = row + col*S，row ↔ 引擎
            // z、col ↔ 引擎 x；y = height × scale.y 绝对值，XZ 以原点为中心。
            // desc.heights 是行主序 [z][x]（x 为快索引）→ 目标索引 row=z/col=x
            // 恰好转置传入（与编辑器 rapierBackend 同规则）。
            const n = col.samples;
            if (!col.heights || n < 2 || col.heights.length < n * n) {
              return R.ColliderDesc.cuboid(0.5, 0.5, 0.5);
            }
            const cm = new Float32Array(n * n);
            for (let iz = 0; iz < n; iz++) {
              for (let ix = 0; ix < n; ix++) {
                cm[iz + ix * n] = col.heights[iz * n + ix];
              }
            }
            return R.ColliderDesc.heightfield(n - 1, n - 1, cm, {
              x: Math.max(0.001, col.terrainSizeX),
              y: 1,
              z: Math.max(0.001, col.terrainSizeZ),
            });
          }
          default:
            return R.ColliderDesc.cuboid(col.halfExtents.x, col.halfExtents.y, col.halfExtents.z);
        }
      };
      return {
        setGravity(g: PhysVec3): void {
          world.gravity = { x: g.x, y: g.y, z: g.z };
        },
        createBody(desc: BodyDesc): BodyHandle {
          const bd =
            desc.mode === "static"
              ? R.RigidBodyDesc.fixed()
              : desc.mode === "kinematic"
                ? R.RigidBodyDesc.kinematicPositionBased()
                : R.RigidBodyDesc.dynamic();
          bd
            .setTranslation(desc.position.x, desc.position.y, desc.position.z)
            .setRotation(desc.quaternion)
            .setLinearDamping(desc.linearDamping)
            .setAngularDamping(desc.angularDamping)
            .setGravityScale(desc.gravityScale)
            .setCcdEnabled(desc.ccd);
          const body = world.createRigidBody(bd);
          if (desc.lockRotation) body.lockRotations(true, true);
          else if (desc.upright) body.restrictRotations(false, true, false, true);
          for (const col of desc.colliders) {
            const cd = shapeOf(col)
              .setTranslation(col.offset.x, col.offset.y, col.offset.z)
              .setFriction(col.friction)
              .setRestitution(col.restitution)
              .setSensor(col.isSensor)
              // rapier 须显式订阅碰撞事件，否则 EventQueue 不产生该碰撞体的事件
              .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
            const collider = world.createCollider(cd, body);
            // 碰撞事件：collider 句柄 → 节点 id（脚本 onCollisionEnter/Exit 寻址）
            colliderNodes.set(collider.handle, desc.nodeId);
          }
          bodies.add(body);
          return {
            nodeId: desc.nodeId,
            setMode(mode: "static" | "kinematic" | "dynamic"): void {
              body.setBodyType(
                mode === "static"
                  ? R.RigidBodyType.Fixed
                  : mode === "kinematic"
                    ? R.RigidBodyType.KinematicPositionBased
                    : R.RigidBodyType.Dynamic,
                true,
              );
            },
            setKinematicTarget(p: PhysVec3, q: PhysQuat): void {
              body.setNextKinematicTranslation(p);
              body.setNextKinematicRotation(q);
            },
            setTransform(p: PhysVec3, q: PhysQuat): void {
              body.setTranslation(p, true);
              body.setRotation(q, true);
            },
            readTransform(): { position: PhysVec3; quaternion: PhysQuat } | null {
              if (!body.isValid()) return null;
              const t = body.translation();
              const r = body.rotation();
              return { position: t, quaternion: r };
            },
            setMass(mass: number): void {
              const count = Math.max(1, body.numColliders());
              for (let i = 0; i < count; i++) body.collider(i)?.setMass(Math.max(0.001, mass) / count);
            },
            setDamping(l: number, a: number): void {
              body.setLinearDamping(l);
              body.setAngularDamping(a);
            },
            setGravityScale(s: number): void {
              body.setGravityScale(s);
              // 缩放 0 的静止体会被睡眠：改系数后必须显式唤醒
              //（setGravityScale 的 wake 标志实测唤不醒已睡眠体）
              body.wakeUp();
            },
            setCcd(on: boolean): void {
              body.enableCcd(on);
            },
            applyImpulse(v: PhysVec3): void {
              body.applyImpulse(v, true);
            },
            applyForce(v: PhysVec3): void {
              body.addForce(v, true);
            },
            setLinearVelocity(v: PhysVec3): void {
              body.setLinvel(v, true);
            },
            setAngularVelocity(v: PhysVec3): void {
              body.setAngvel(v, true);
            },
            getLinearVelocity(): PhysVec3 | null {
              return body.isValid() ? body.linvel() : null;
            },
            wakeUp(): void {
              body.wakeUp();
            },
            raw: body,
          };
        },
        destroyBody(b: BodyHandle): void {
          const raw = b.raw as RapierBody; // createBody 登记进 bodies 的原生刚体
          if (!bodies.has(raw)) return;
          bodies.delete(raw);
          world.removeRigidBody(raw);
        },
        step(dt: number): void {
          world.timestep = Math.max(0.0001, dt);
          world.step(eventQueue);
          steppedOnce = true;
          // 碰撞开始/结束事件 → 节点 id 对（同一批次内按 a|b|started 去重，
          // 复合形状多对碰撞体同帧只报一次）
          const seen = new Set<string>();
          eventQueue.drainCollisionEvents((h1: number, h2: number, started: boolean): void => {
            const a = colliderNodes.get(h1);
            const b = colliderNodes.get(h2);
            if (a === undefined || b === undefined) return;
            const key = `${a}|${b}|${started ? 1 : 0}`;
            if (seen.has(key)) return;
            seen.add(key);
            pendingCollisions.push({ a, b, started: started === true });
          });
        },
        takeCollisionEvents(): CollisionEvent[] {
          return pendingCollisions.splice(0);
        },
        castRay(options: RaycastOptions): RayHit[] {
          const dir = options.direction;
          const dirLen = Math.hypot(dir.x, dir.y, dir.z);
          if (dirLen < 1e-9) return [];
          if (!steppedOnce) {
            // broadphase 未随 step 建树时射线永远打空：以零步长预热一帧
            // （不推进模拟、不产生位移；事件照常入队，首个真实 step 前的接触语义不变）
            const prev = world.timestep;
            world.timestep = 0;
            world.step(eventQueue);
            world.timestep = prev;
            steppedOnce = true;
          }
          const maxToi = (options.maxDistance ?? Infinity) / dirLen;
          if (maxToi <= 0) return [];
          const exclude = new Set(options.excludeNodeIds ?? []);
          const ray = new R.Ray(
            { x: options.origin.x, y: options.origin.y, z: options.origin.z },
            { x: dir.x, y: dir.y, z: dir.z },
          );
          const filterPredicate = (collider: RapierCollider): boolean => {
            const nodeId = colliderNodes.get(collider.handle);
            return nodeId !== undefined && !exclude.has(nodeId);
          };
          const hit = world.castRayAndGetNormal(ray, maxToi, true, undefined, undefined, undefined, undefined, filterPredicate);
          if (!hit) return [];
          const nodeId = colliderNodes.get(hit.collider.handle);
          if (!nodeId) return [];
          const point = ray.pointAt(hit.timeOfImpact);
          return [{
            nodeId,
            point: { x: point.x, y: point.y, z: point.z },
            normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
            distance: hit.timeOfImpact * dirLen,
          }];
        },
        dispose(): void {
          world.free();
        },
      };
    },
  };
}

// —— jolt wasm 胶水最小消费面（真实类型由动态 import 的 jolt.mjs 提供，
//    结构接口只声明本文件用到的成员；emscripten 枚举常量按 number 消费）——

interface JoltVec3 {
  Set(x: number, y: number, z: number): void;
  GetX(): number;
  GetY(): number;
  GetZ(): number;
}

interface JoltQuat {
  GetX(): number;
  GetY(): number;
  GetZ(): number;
  GetW(): number;
}

interface JoltBodyID {
  GetIndex(): number;
}

/** wasm 侧不透明形状对象 */
type JoltShape = unknown;

interface JoltShapeResult {
  IsValid(): boolean;
  Get(): JoltShape;
}

interface JoltArrayFloat {
  reserve(n: number): void;
  push_back(v: number): void;
}

interface JoltMotionProperties {
  SetInverseMass(m: number): void;
  SetLinearDamping(d: number): void;
  SetAngularDamping(d: number): void;
  SetGravityFactor(f: number): void;
}

interface JoltTransformedShape {
  CastRay(ray: JoltRRayCast, result: JoltRayCastResult): void;
  GetWorldSpaceSurfaceNormal(subShapeID: unknown, point: JoltVec3): JoltVec3;
}

interface JoltBody {
  GetID(): JoltBodyID;
  GetPosition(): JoltVec3;
  GetRotation(): JoltQuat;
  SetFriction(f: number): void;
  SetRestitution(r: number): void;
  GetMotionProperties(): JoltMotionProperties | null;
  SetIsSensor(b: boolean): void;
  AddImpulse(v: JoltVec3): void;
  AddForce(v: JoltVec3): void;
  SetLinearVelocity(v: JoltVec3): void;
  SetAngularVelocity(v: JoltVec3): void;
  GetLinearVelocity(): JoltVec3;
  GetTransformedShape(): JoltTransformedShape;
}

interface JoltBodyInterface {
  CreateBody(settings: JoltBodyCreationSettings): JoltBody | null;
  AddBody(id: JoltBodyID, activation: number): void;
  RemoveBody(id: JoltBodyID): void;
  DestroyBody(id: JoltBodyID): void;
  SetMotionType(id: JoltBodyID, motionType: number, activation: number): void;
  SetPosition(id: JoltBodyID, p: JoltVec3, activation: number): void;
  SetRotation(id: JoltBodyID, q: JoltQuat, activation: number): void;
  SetMotionQuality(id: JoltBodyID, quality: number): void;
  ActivateBody(id: JoltBodyID): void;
  MoveKinematic(id: JoltBodyID, p: JoltVec3, q: JoltQuat, dt: number): void;
}

interface JoltPhysicsSystem {
  GetBodyInterface(): JoltBodyInterface;
  SetGravity(v: JoltVec3): void;
  SetContactListener(listener: JoltContactListener): void;
}

interface JoltJoltInterface {
  GetPhysicsSystem(): JoltPhysicsSystem;
  Step(dt: number, substeps: number): void;
}

interface JoltSettings {
  mMaxWorkerThreads: number;
  mObjectLayerPairFilter: unknown;
  mBroadPhaseLayerInterface: unknown;
  mObjectVsBroadPhaseLayerFilter: unknown;
}

interface JoltContactSettings {
  mCombinedRestitution: number;
}

interface JoltSubShapeIDPair {
  GetBody1ID(): JoltBodyID;
  GetBody2ID(): JoltBodyID;
}

/** 接触回调入参（本 wasm 构建传裸指针或 JSImplementation 对象 → bodyIdOf 收敛） */
type JoltContactArg = unknown;

interface JoltContactListener {
  OnContactValidate: () => number;
  OnContactAdded: (b1: JoltContactArg, b2: JoltContactArg) => void;
  OnContactPersisted: (b1: JoltContactArg, b2: JoltContactArg, manifold: JoltContactArg, settings: JoltContactArg) => void;
  OnContactRemoved: (pair: JoltContactArg) => void;
}

interface JoltRRayCast {
  mOrigin: JoltVec3;
  mDirection: JoltVec3;
  GetPointOnRay(fraction: number): JoltVec3;
}

interface JoltRayCastResult {
  mFraction: number;
  mSubShapeID2: unknown;
}

interface JoltBodyCreationSettings {
  mAllowedDOFs: number;
}

/** jolt wasm 胶水（./physics-engines/jolt.mjs default 工厂产物）最小消费面 */
interface JoltAPI {
  JoltSettings: new () => JoltSettings;
  ObjectLayerPairFilterTable: new (numLayers: number) => { EnableCollision(a: number, b: number): void };
  BroadPhaseLayerInterfaceTable: new (numObjectLayers: number, numBpLayers: number) => {
    MapObjectToBroadPhaseLayer(layer: number, bpLayer: unknown): void;
  };
  BroadPhaseLayer: new (index: number) => unknown;
  ObjectVsBroadPhaseLayerFilterTable: new (bpInterface: unknown, numBpLayers: number, objectFilter: unknown, numLayers: number) => unknown;
  JoltInterface: new (settings: JoltSettings) => JoltJoltInterface;
  Vec3: new (x: number, y: number, z: number) => JoltVec3;
  RVec3: new (x: number, y: number, z: number) => JoltVec3;
  Quat: new (x: number, y: number, z: number, w: number) => JoltQuat;
  ContactListenerJS: new () => JoltContactListener;
  /** wrapPointer 类标记（Body/ContactSettings/SubShapeIDPair 仅作还原目标） */
  Body: unknown;
  ContactSettings: unknown;
  SubShapeIDPair: unknown;
  wrapPointer(ptr: number, klass: unknown): unknown;
  SphereShape: new (radius: number) => JoltShape;
  CapsuleShape: new (halfHeight: number, radius: number) => JoltShape;
  CylinderShape: new (halfHeight: number, radius: number, tolerance: number) => JoltShape;
  BoxShape: new (halfExtent: JoltVec3, tolerance: number) => JoltShape;
  ConvexHullShapeSettings: new () => { mPoints: { push_back(v: JoltVec3): void }; Create(): JoltShapeResult };
  HeightFieldShapeSettings: new () => {
    mSampleCount: number;
    mBitsPerSample: number;
    mMinHeightValue: number;
    mMaxHeightValue: number;
    mHeightSamples: JoltArrayFloat;
    mOffset: JoltVec3;
    mScale: JoltVec3;
    Create(): JoltShapeResult;
  };
  MutableCompoundShapeSettings: new () => {
    AddShapeShape(position: JoltVec3, rotation: JoltQuat, shape: JoltShape, userData: number): void;
    Create(): JoltShapeResult;
  };
  BodyCreationSettings: new (shape: JoltShape, position: JoltVec3, rotation: JoltQuat, motionType: number, objectLayer: number) => JoltBodyCreationSettings;
  ArrayFloat: new () => JoltArrayFloat;
  RRayCast: new () => JoltRRayCast;
  RayCastResult: new () => JoltRayCastResult;
  EMotionType_Static: number;
  EMotionType_Kinematic: number;
  EMotionType_Dynamic: number;
  EActivation_Activate: number;
  EActivation_DontActivate: number;
  EMotionQuality_LinearCast: number;
  EMotionQuality_Discrete: number;
  EAllowedDOFs_TranslationX: number;
  EAllowedDOFs_TranslationY: number;
  EAllowedDOFs_TranslationZ: number;
  EAllowedDOFs_RotationY: number;
  destroy(o: unknown): void;
}

/** jolt 句柄（BodyHandle + step 时取用的运动学目标缓存） */
type JoltHandle = BodyHandle & { takeKinematicTarget(): KinematicTarget | null };

async function loadJolt(): Promise<{ createWorld(gravity: PhysVec3): PhysicsWorld }> {
  // 字面量说明符：单页构建经 build.rs 重写为 import map 裸说明符（勿改成运行时拼 URL）
  // @ts-expect-error wasm 胶水为 src/runtime/extra 下的无类型 .mjs（构建期并入产物）
  const mod = await import("./physics-engines/jolt.mjs");
  const Jolt = (await mod.default()) as JoltAPI; // 胶水 default 导出 = jolt 初始化工厂
  const LAYER_MOVING = 0;
  const LAYER_NON_MOVING = 1;
  return {
    createWorld(gravity: PhysVec3): PhysicsWorld {
      const settings = new Jolt.JoltSettings();
      settings.mMaxWorkerThreads = 1;
      const objectFilter = new Jolt.ObjectLayerPairFilterTable(2);
      objectFilter.EnableCollision(LAYER_MOVING, LAYER_NON_MOVING);
      objectFilter.EnableCollision(LAYER_MOVING, LAYER_MOVING);
      const bpInterface = new Jolt.BroadPhaseLayerInterfaceTable(2, 2);
      bpInterface.MapObjectToBroadPhaseLayer(LAYER_MOVING, new Jolt.BroadPhaseLayer(0));
      bpInterface.MapObjectToBroadPhaseLayer(LAYER_NON_MOVING, new Jolt.BroadPhaseLayer(1));
      settings.mObjectLayerPairFilter = objectFilter;
      settings.mBroadPhaseLayerInterface = bpInterface;
      settings.mObjectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(
        bpInterface,
        2,
        objectFilter,
        2,
      );
      const interface3d = new Jolt.JoltInterface(settings);
      const system = interface3d.GetPhysicsSystem();
      const bi = system.GetBodyInterface();
      const gravityScratch = new Jolt.Vec3(gravity.x, gravity.y, gravity.z);
      system.SetGravity(gravityScratch);
      const bodies = new Map<JoltBody, { shapes: unknown[]; handle: JoltHandle }>();
      // 碰撞事件（ContactListenerJS）：BodyID 索引 → 节点 id 在 createBody 登记
      const nodeByBodyIndex = new Map<number, string>();
      const pendingCollisions: CollisionEvent[] = [];
      const pushCollision = (id1: JoltBodyID, id2: JoltBodyID, started: boolean): void => {
        const a = nodeByBodyIndex.get(id1.GetIndex());
        const b = nodeByBodyIndex.get(id2.GetIndex());
        if (a === undefined || b === undefined) return;
        pendingCollisions.push({ a, b, started });
      };
      try {
        // emscripten JSImplementation 要求实现 ContactListenerJS 全部虚函数，
        // 缺任一属性在接触处理时即抛错（wasm 侧 hasOwnProperty 检查）。
        // 回调入参（本 wasm 构建传裸指针）：Added/Persisted = (Body 指针,
        // Body 指针, Manifold, Settings)；Removed = 一个 SubShapeIDPair 对象。
        // Body 指针经 wrapPointer 还原后取 GetID().GetIndex() 映射节点。
        // 持续接触不弹：脚本逐帧把速度压向碰撞体时，存续的接触不能逐帧按
        // 弹性反弹——Added（首次撞击）保留弹性系数，Persisted（持续接触）清零
        const zeroRestitutionOf = (settings: JoltContactArg): void => {
          if (settings && typeof settings === "object") (settings as JoltContactSettings).mCombinedRestitution = 0;
          else if (typeof settings === "number" && settings) {
            (Jolt.wrapPointer(settings, Jolt.ContactSettings) as JoltContactSettings).mCombinedRestitution = 0;
          }
        };
        const bodyIdOf = (b: JoltContactArg): JoltBodyID => {
          if (b && typeof b === "object") {
            return typeof (b as { GetID?: unknown }).GetID === "function"
              ? (b as JoltBody).GetID()
              : (b as JoltBodyID); // 已还原的 BodyID 对象原样透传
          }
          if (typeof b === "number" && b) {
            return (Jolt.wrapPointer(b, Jolt.Body) as JoltBody).GetID();
          }
          return b as JoltBodyID; // 非预期入参透传（map miss → 事件丢弃，与原行为一致）
        };
        const listener = new Jolt.ContactListenerJS();
        listener.OnContactValidate = (): number => 1; // 1 = AcceptAllContactsForContact
        listener.OnContactAdded = (b1: JoltContactArg, b2: JoltContactArg): void => pushCollision(bodyIdOf(b1), bodyIdOf(b2), true);
        listener.OnContactPersisted = (_b1: JoltContactArg, _b2: JoltContactArg, _manifold: JoltContactArg, settings: JoltContactArg): void => zeroRestitutionOf(settings);
        listener.OnContactRemoved = (pair: JoltContactArg): void => {
          if (pair && typeof pair === "object") {
            const p = pair as JoltSubShapeIDPair; // JSImplementation 对象（已含 GetBody1ID/GetBody2ID）
            pushCollision(p.GetBody1ID(), p.GetBody2ID(), false);
          } else if (typeof pair === "number" && pair) {
            const p = Jolt.wrapPointer(pair, Jolt.SubShapeIDPair) as JoltSubShapeIDPair;
            pushCollision(p.GetBody1ID(), p.GetBody2ID(), false);
          }
        };
        system.SetContactListener(listener);
      } catch (e) {
        // e?.message ?? e：非 Error 抛出值原样透传（断言仅放行属性读取，运行时同原式）
        const msg = (e as { message?: unknown } | null | undefined)?.message ?? e;
        postLog("warn", `[物理] jolt 碰撞事件不可用: ${String(msg)}`);
      }
      const buildShape = (col: ColliderDesc, out: unknown[]): JoltShape | null => {
        let s: JoltShape | null;
        switch (col.shape) {
          case "sphere":
            s = new Jolt.SphereShape(Math.max(0.001, col.radius));
            break;
          case "capsule":
            s = new Jolt.CapsuleShape(Math.max(0.001, col.halfHeight), Math.max(0.001, col.radius));
            break;
          case "cylinder":
            s = new Jolt.CylinderShape(Math.max(0.001, col.halfHeight), Math.max(0.001, col.radius), 0.03);
            break;
          case "convex": {
            if (col.points.length >= 12) {
              try {
                const hs = new Jolt.ConvexHullShapeSettings();
                for (let i = 0; i + 2 < col.points.length; i += 3) {
                  hs.mPoints.push_back(new Jolt.Vec3(col.points[i], col.points[i + 1], col.points[i + 2]));
                }
                const result = hs.Create();
                if (result.IsValid()) s = result.Get();
              } catch {
                s = null;
              }
            }
            if (!s) s = new Jolt.BoxShape(new Jolt.Vec3(0.5, 0.5, 0.5), 0.03);
            break;
          }
          case "heightfield": {
            // Jolt 高度场：采样行主序 X-then-Z（与 desc.heights 布局一致），首采样
            // 位置 = mOffset，步长 = mScale；高度在 [min,max] 按 mBitsPerSample 量化
            // （此版本要求 [1,16]，取 16 位）。每轴采样数须为 2 的幂（resolution 已保证）。
            const n = col.samples;
            if (!col.heights || n < 2 || col.heights.length < n * n) {
              s = new Jolt.BoxShape(new Jolt.Vec3(0.5, 0.5, 0.5), 0.03);
              break;
            }
            try {
              const hs = new Jolt.HeightFieldShapeSettings();
              hs.mSampleCount = n; // 每轴采样数（须 2 的幂；样本总数 = n²）
              hs.mBitsPerSample = 16;
              hs.mMinHeightValue = col.minHeight;
              hs.mMaxHeightValue = col.maxHeight;
              const samples = new Jolt.ArrayFloat();
              samples.reserve(n * n);
              for (let i = 0; i < n * n; i++) samples.push_back(col.heights[i]);
              hs.mHeightSamples = samples;
              hs.mOffset = new Jolt.Vec3(-col.terrainSizeX / 2, 0, -col.terrainSizeZ / 2);
              hs.mScale = new Jolt.Vec3(col.terrainSizeX / (n - 1), 1, col.terrainSizeZ / (n - 1));
              const result = hs.Create();
              s = result.IsValid() ? result.Get() : null;
            } catch {
              s = null;
            }
            if (!s) s = new Jolt.BoxShape(new Jolt.Vec3(0.5, 0.5, 0.5), 0.03);
            break;
          }
          default:
            s = new Jolt.BoxShape(
              new Jolt.Vec3(col.halfExtents.x, col.halfExtents.y, col.halfExtents.z),
              0.03,
            );
        }
        out.push(s);
        return s;
      };
      return {
        setGravity(g: PhysVec3): void {
          gravityScratch.Set(g.x, g.y, g.z);
          system.SetGravity(gravityScratch);
        },
        createBody(desc: BodyDesc): JoltHandle | null {
          const shapes: unknown[] = [];
          // 复合形状经 Settings 构建（MutableCompoundShape 无公开构造），
          // AddShapeShape 直接吃 Shape 子体（偏移即子体位移）
          const compoundSettings = new Jolt.MutableCompoundShapeSettings();
          shapes.push(compoundSettings);
          for (const col of desc.colliders) {
            compoundSettings.AddShapeShape(
              new Jolt.Vec3(col.offset.x, col.offset.y, col.offset.z),
              new Jolt.Quat(0, 0, 0, 1),
              buildShape(col, shapes),
              0,
            );
          }
          const compound = compoundSettings.Create().Get();
          const layer = desc.mode === "static" ? LAYER_NON_MOVING : LAYER_MOVING;
          const motionType =
            desc.mode === "static"
              ? Jolt.EMotionType_Static
              : desc.mode === "kinematic"
                ? Jolt.EMotionType_Kinematic
                : Jolt.EMotionType_Dynamic;
          const creation = new Jolt.BodyCreationSettings(
            compound,
            new Jolt.RVec3(desc.position.x, desc.position.y, desc.position.z),
            new Jolt.Quat(desc.quaternion.x, desc.quaternion.y, desc.quaternion.z, desc.quaternion.w),
            motionType,
            layer,
          );
          if (desc.lockRotation) {
            // 锁定旋转 = 只允许平移自由度（X|Y|Z）
            creation.mAllowedDOFs =
              Jolt.EAllowedDOFs_TranslationX |
              Jolt.EAllowedDOFs_TranslationY |
              Jolt.EAllowedDOFs_TranslationZ;
          } else if (desc.upright) {
            // 直立不倒 = 平移 + 仅 Y 轴旋转（碰撞不产生俯仰/翻滚）
            creation.mAllowedDOFs =
              Jolt.EAllowedDOFs_TranslationX |
              Jolt.EAllowedDOFs_TranslationY |
              Jolt.EAllowedDOFs_TranslationZ |
              Jolt.EAllowedDOFs_RotationY;
          }
          const body = bi.CreateBody(creation);
          if (!body) return null;
          bi.AddBody(body.GetID(), Jolt.EActivation_Activate);
          nodeByBodyIndex.set(body.GetID().GetIndex(), desc.nodeId);
          body.SetFriction(desc.colliders[0]?.friction ?? 0.6);
          body.SetRestitution(desc.colliders[0]?.restitution ?? 0.1);
          const mp = body.GetMotionProperties();
          if (mp) {
            mp.SetInverseMass(1 / Math.max(0.001, desc.mass));
            mp.SetLinearDamping(desc.linearDamping);
            mp.SetAngularDamping(desc.angularDamping);
            mp.SetGravityFactor(desc.gravityScale);
          }
          if (desc.ccd) bi.SetMotionQuality(body.GetID(), Jolt.EMotionQuality_LinearCast);
          if (desc.colliders.length === 1 && desc.colliders[0].isSensor) body.SetIsSensor(true);
          let kinTarget: KinematicTarget | null = null;
          const handle: JoltHandle = {
            nodeId: desc.nodeId,
            setMode(mode: "static" | "kinematic" | "dynamic"): void {
              bi.SetMotionType(
                body.GetID(),
                mode === "static"
                  ? Jolt.EMotionType_Static
                  : mode === "kinematic"
                    ? Jolt.EMotionType_Kinematic
                    : Jolt.EMotionType_Dynamic,
                Jolt.EActivation_Activate,
              );
            },
            setKinematicTarget(p: PhysVec3, q: PhysQuat): void {
              kinTarget = { p, q };
            },
            setTransform(p: PhysVec3, q: PhysQuat): void {
              bi.SetPosition(body.GetID(), new Jolt.RVec3(p.x, p.y, p.z), Jolt.EActivation_DontActivate);
              bi.SetRotation(body.GetID(), new Jolt.Quat(q.x, q.y, q.z, q.w), Jolt.EActivation_DontActivate);
            },
            readTransform(): { position: PhysVec3; quaternion: PhysQuat } {
              const p = body.GetPosition();
              const q = body.GetRotation();
              return { position: { x: p.GetX(), y: p.GetY(), z: p.GetZ() }, quaternion: { x: q.GetX(), y: q.GetY(), z: q.GetZ(), w: q.GetW() } };
            },
            setMass(mass: number): void {
              mp?.SetInverseMass(1 / Math.max(0.001, mass));
            },
            setDamping(l: number, a: number): void {
              mp?.SetLinearDamping(l);
              mp?.SetAngularDamping(a);
            },
            setGravityScale(s: number): void {
              mp?.SetGravityFactor(s);
              // 缩放 0 的静止体会被休眠：改系数后必须显式激活
              bi.ActivateBody(body.GetID());
            },
            setCcd(on: boolean): void {
              bi.SetMotionQuality(body.GetID(), on ? Jolt.EMotionQuality_LinearCast : Jolt.EMotionQuality_Discrete);
            },
            applyImpulse(v: PhysVec3): void {
              bi.ActivateBody(body.GetID()); // 休眠体先唤醒（与 rapier wakeUp=true 同语义）
              body.AddImpulse(new Jolt.Vec3(v.x, v.y, v.z));
            },
            applyForce(v: PhysVec3): void {
              bi.ActivateBody(body.GetID());
              body.AddForce(new Jolt.Vec3(v.x, v.y, v.z));
            },
            setLinearVelocity(v: PhysVec3): void {
              bi.ActivateBody(body.GetID());
              body.SetLinearVelocity(new Jolt.Vec3(v.x, v.y, v.z));
            },
            setAngularVelocity(v: PhysVec3): void {
              bi.ActivateBody(body.GetID());
              body.SetAngularVelocity(new Jolt.Vec3(v.x, v.y, v.z));
            },
            getLinearVelocity(): PhysVec3 {
              const v = body.GetLinearVelocity();
              return { x: v.GetX(), y: v.GetY(), z: v.GetZ() };
            },
            wakeUp(): void {
              bi.ActivateBody(body.GetID());
            },
            raw: body,
            takeKinematicTarget(): KinematicTarget | null {
              const t = kinTarget;
              kinTarget = null;
              return t;
            },
          };
          bodies.set(body, { shapes, handle });
          return handle;
        },
        destroyBody(b: BodyHandle): void {
          const raw = b.raw as JoltBody; // createBody 登记进 bodies 的原生刚体
          const entry = bodies.get(raw);
          if (!entry) return;
          bodies.delete(raw);
          bi.RemoveBody(raw.GetID());
          bi.DestroyBody(raw.GetID());
          for (const s of entry.shapes) {
            try {
              Jolt.destroy(s);
            } catch {
              /* 忽略 */
            }
          }
        },
        step(dt: number): void {
          for (const { handle } of bodies.values()) {
            const t = handle.takeKinematicTarget();
            if (!t) continue;
            bi.MoveKinematic(
              (handle.raw as JoltBody).GetID(), // createBody 登记的原生刚体（raw 恒为 JoltBody）
              new Jolt.RVec3(t.p.x, t.p.y, t.p.z),
              new Jolt.Quat(t.q.x, t.q.y, t.q.z, t.q.w),
              dt,
            );
          }
          interface3d.Step(dt, 1);
        },
        takeCollisionEvents(): CollisionEvent[] {
          return pendingCollisions.splice(0);
        },
        castRay(options: RaycastOptions): RayHit[] {
          const dir = options.direction;
          const dirLen = Math.hypot(dir.x, dir.y, dir.z);
          if (dirLen < 1e-9) return [];
          const maxDistance = options.maxDistance ?? Infinity;
          const exclude = new Set(options.excludeNodeIds ?? []);
          const rayLen = Number.isFinite(maxDistance) ? maxDistance : 1e9;
          // Jolt 射线是有向线段：方向须带长度，命中分数 mFraction ∈ [0,1) 相对线段长
          const ray = new Jolt.RRayCast();
          ray.mOrigin = new Jolt.RVec3(options.origin.x, options.origin.y, options.origin.z);
          ray.mDirection = new Jolt.Vec3(dir.x / dirLen * rayLen, dir.y / dirLen * rayLen, dir.z / dirLen * rayLen);
          const result = new Jolt.RayCastResult();
          // result 为 in/out（初值 fraction = 1）：CastRay 只在更近时覆写，
          // 逐体投完后 result 即最近命中，bestNodeId/bestBody 记录归属
          let bestNodeId: string | null = null;
          let bestBody: JoltBody | null = null;
          for (const [body, entry] of bodies) {
            if (exclude.has(entry.handle.nodeId)) continue;
            const ts = body.GetTransformedShape();
            const prevFraction = result.mFraction;
            try { ts.CastRay(ray, result); } catch { continue; }
            if (result.mFraction < prevFraction) {
              bestNodeId = entry.handle.nodeId;
              bestBody = body;
            }
          }
          if (!bestNodeId || result.mFraction >= 1) {
            Jolt.destroy(ray);
            Jolt.destroy(result);
            return [];
          }
          const point = ray.GetPointOnRay(result.mFraction);
          let normal: PhysVec3 = { x: 0, y: 0, z: 0 };
          try {
            const hitBody = bestBody as JoltBody; // bestNodeId 与 bestBody 同帧赋值，前者非空即后者非空
            const n = hitBody.GetTransformedShape().GetWorldSpaceSurfaceNormal(result.mSubShapeID2, point);
            normal = { x: n.GetX(), y: n.GetY(), z: n.GetZ() };
            Jolt.destroy(n);
          } catch {}
          const hit: RayHit[] = [{
            nodeId: bestNodeId,
            point: { x: point.GetX(), y: point.GetY(), z: point.GetZ() },
            normal,
            distance: result.mFraction * rayLen,
          }];
          Jolt.destroy(point);
          Jolt.destroy(ray);
          Jolt.destroy(result);
          return hit;
        },
        dispose() {
          try {
            Jolt.destroy(gravityScratch);
            Jolt.destroy(interface3d);
          } catch {
            /* 忽略 */
          }
        },
      };
    },
  };
}

// —— ammo wasm 胶水最小消费面（真实类型由动态 import 的 ammo-esm.mjs 提供，
//    embind 对象经结构接口声明本文件用到的成员；getter 为方法调用形式）——

interface AmmoVec3 {
  x(): number;
  y(): number;
  z(): number;
}

interface AmmoQuat {
  x(): number;
  y(): number;
  z(): number;
  w(): number;
}

interface AmmoTransform {
  setIdentity(): void;
  setOrigin(v: AmmoVec3): void;
  setRotation(q: AmmoQuat): void;
  getOrigin(): AmmoVec3;
  getRotation(): AmmoQuat;
}

interface AmmoMotionState {
  setWorldTransform(t: AmmoTransform): void;
  getWorldTransform(t: AmmoTransform): void;
}

interface AmmoCollisionObject {
  getRestitution(): number;
  setRestitution(v: number): void;
}

interface AmmoBody extends AmmoCollisionObject {
  setGravity(v: AmmoVec3): void;
  setCollisionFlags(flags: number): void;
  getCollisionFlags(): number;
  setActivationState(state: number): void;
  activate(activate: boolean): void;
  setFriction(f: number): void;
  setDamping(l: number, a: number): void;
  setAngularFactor(v: AmmoVec3): void;
  setAngularVelocity(v: AmmoVec3): void;
  setCcdMotionThreshold(v: number): void;
  setCcdSweptSphereRadius(v: number): void;
  setMassProps(mass: number, inertia: AmmoVec3): void;
  getMotionState(): AmmoMotionState;
  applyCentralImpulse(v: AmmoVec3): void;
  applyCentralForce(v: AmmoVec3): void;
  setLinearVelocity(v: AmmoVec3): void;
  getLinearVelocity(): AmmoVec3;
  calculateLocalInertia(mass: number, inertia: AmmoVec3): void;
}

interface AmmoCompoundShape {
  addChildShape(transform: AmmoTransform, shape: unknown): void;
  calculateLocalInertia(mass: number, inertia: AmmoVec3): void;
}

interface AmmoConvexHullShape {
  addPoint(v: AmmoVec3, recalcLocalAabb: boolean): void;
  recalcLocalAabb(): void;
}

interface AmmoHeightfieldShape {
  setLocalScaling(v: AmmoVec3): void;
}

interface AmmoManifold {
  getNumContacts(): number;
  getBody0(): AmmoCollisionObject;
  getBody1(): AmmoCollisionObject;
}

interface AmmoDispatcher {
  getNumManifolds(): number;
  getManifoldByIndexInternal(i: number): AmmoManifold;
}

interface AmmoWorld {
  setGravity(v: AmmoVec3): void;
  addRigidBody(b: AmmoBody): void;
  removeRigidBody(b: AmmoBody): void;
  stepSimulation(dt: number, substeps: number, fixedSubstep: number): void;
  getDispatcher(): AmmoDispatcher;
  rayTest(from: AmmoVec3, to: AmmoVec3, callback: AmmoAllHitsCallback): void;
}

interface AmmoAllHitsCallback {
  hasHit(): boolean;
  get_m_collisionObjects(): { size(): number; at(i: number): AmmoCollisionObject };
  get_m_hitPointWorld(): { at(i: number): AmmoVec3 };
  get_m_hitNormalWorld(): { at(i: number): AmmoVec3 };
}

/** ammo wasm 胶水（./physics-engines/ammo/ammo-esm.mjs initAmmo 产物）最小消费面 */
interface AmmoAPI {
  btDefaultCollisionConfiguration: new () => unknown;
  btCollisionDispatcher: new (cfg: unknown) => AmmoDispatcher;
  btDbvtBroadphase: new () => unknown;
  btSequentialImpulseConstraintSolver: new () => unknown;
  btDiscreteDynamicsWorld: new (dispatcher: AmmoDispatcher, broadphase: unknown, solver: unknown, cfg: unknown) => AmmoWorld;
  btVector3: new (x: number, y: number, z: number) => AmmoVec3;
  btQuaternion: new (x: number, y: number, z: number, w: number) => AmmoQuat;
  btTransform: new () => AmmoTransform;
  btDefaultMotionState: new (start: AmmoTransform) => AmmoMotionState;
  btRigidBodyConstructionInfo: new (mass: number, motionState: AmmoMotionState, shape: AmmoCompoundShape, inertia: AmmoVec3) => unknown;
  btRigidBody: new (info: unknown) => AmmoBody;
  btCompoundShape: new () => AmmoCompoundShape;
  btSphereShape: new (radius: number) => unknown;
  btCapsuleShape: new (radius: number, height: number) => unknown;
  btCylinderShape: new (halfExtents: AmmoVec3) => unknown;
  btConvexHullShape: new () => AmmoConvexHullShape;
  btBoxShape: new (halfExtents: AmmoVec3) => unknown;
  btHeightfieldTerrainShape: new (
    width: number,
    length: number,
    dataPtr: number,
    scale: number,
    minHeight: number,
    maxHeight: number,
    upAxis: number,
    dataType: number,
    flipQuadEdges: boolean,
  ) => AmmoHeightfieldShape;
  PHY_FLOAT: number;
  AllHitsRayResultCallback: new (from: AmmoVec3, to: AmmoVec3) => AmmoAllHitsCallback;
  getPointer(o: unknown): number;
  destroy(o: unknown): void;
  /** 高度场裸缓冲分配（embind destroy 不托管，须随世界 dispose 释放） */
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  HEAPF32: Float32Array;
}

async function loadAmmo(): Promise<{ createWorld(gravity: PhysVec3): PhysicsWorld }> {
  // ESM 初始化器内联 wasmBinary（无外部 .wasm 文件依赖，单页内联可用）；
  // 字面量说明符：单页构建经 build.rs 重写为 import map 裸说明符
  // @ts-expect-error wasm 胶水为 src/runtime/extra 下的无类型 .mjs（构建期并入产物）
  const { initAmmo } = await import("./physics-engines/ammo/ammo-esm.mjs");
  const Ammo = (await initAmmo()) as AmmoAPI; // initAmmo 返回 embind 模块命名空间
  return {
    createWorld(gravity: PhysVec3): PhysicsWorld {
      const cfg = new Ammo.btDefaultCollisionConfiguration();
      const dispatcher = new Ammo.btCollisionDispatcher(cfg);
      const broadphase = new Ammo.btDbvtBroadphase();
      const solver = new Ammo.btSequentialImpulseConstraintSolver();
      const world = new Ammo.btDiscreteDynamicsWorld(dispatcher, broadphase, solver, cfg);
      world.setGravity(new Ammo.btVector3(gravity.x, gravity.y, gravity.z));
      // 逐体重力（重力缩放）：Bullet 的 world.setGravity 会重置所有非静态体的
      // 逐体重力，缩放体登记在册、世界重力变化后统一重铺
      const gravityVec = { x: gravity.x, y: gravity.y, z: gravity.z };
      const gravityTracked: { body: AmmoBody; scale: number }[] = [];
      const applyBodyGravity = (e: { body: AmmoBody; scale: number }): void =>
        e.body.setGravity(
          new Ammo.btVector3(gravityVec.x * e.scale, gravityVec.y * e.scale, gravityVec.z * e.scale),
        );
      const seenManifolds = new Set<number>();
      // 持续接触中被临时清零弹性的碰撞对象（ptr → { obj, value }），接触结束后恢复
      const zeroedRestitution = new Map<number, { obj: AmmoCollisionObject; value: number }>();
      const bodies: BodyHandle[] = [];
      const CF_KINEMATIC_OBJECT = 2;
      const CF_NO_CONTACT_RESPONSE = 4;
      const DISABLE_DEACTIVATION = 4;
      // 高度场 _malloc 缓冲指针（embind destroy 不托管裸指针；随世界 dispose 释放）
      const heightfieldBuffers = new Set<number>();
      const buildShape = (col: ColliderDesc, out: unknown[]): unknown => {
        let s: unknown;
        switch (col.shape) {
          case "sphere":
            s = new Ammo.btSphereShape(Math.max(0.001, col.radius));
            break;
          case "capsule":
            s = new Ammo.btCapsuleShape(Math.max(0.001, col.radius), Math.max(0.002, col.halfHeight * 2));
            break;
          case "cylinder":
            s = new Ammo.btCylinderShape(
              new Ammo.btVector3(Math.max(0.001, col.radius), Math.max(0.001, col.halfHeight), Math.max(0.001, col.radius)),
            );
            break;
          case "convex": {
            if (col.points.length >= 12) {
              const hull = new Ammo.btConvexHullShape();
              for (let i = 0; i + 2 < col.points.length; i += 3) {
                hull.addPoint(new Ammo.btVector3(col.points[i], col.points[i + 1], col.points[i + 2]), false);
              }
              hull.recalcLocalAabb();
              s = hull;
            } else {
              s = new Ammo.btBoxShape(new Ammo.btVector3(0.5, 0.5, 0.5));
            }
            break;
          }
          case "heightfield": {
            // Bullet 高度场：单位采样间距、以高度中线为局部原点 → setLocalScaling
            // 拉伸 XZ 到 terrainSize、包一层 compound 子变换 y=+mid 抬回绝对高度
            // 语义（与编辑器同规则）。缓冲行主序 [z*n + x]，须持久有效（不拷贝）。
            const n = col.samples;
            if (!col.heights || n < 2 || col.heights.length < n * n) {
              s = new Ammo.btBoxShape(new Ammo.btVector3(0.5, 0.5, 0.5));
              break;
            }
            const ptr = Ammo._malloc(n * n * 4);
            if (!ptr) {
              s = new Ammo.btBoxShape(new Ammo.btVector3(0.5, 0.5, 0.5));
              break;
            }
            heightfieldBuffers.add(ptr);
            const heap = Ammo.HEAPF32;
            const base = ptr >> 2;
            for (let i = 0; i < n * n; i++) heap[base + i] = col.heights[i];
            const mid = (col.minHeight + col.maxHeight) / 2;
            const hf = new Ammo.btHeightfieldTerrainShape(
              n, n, ptr, 1, col.minHeight, col.maxHeight,
              1 /* upAxis=Y */, Ammo.PHY_FLOAT, false /* flipQuadEdges */,
            );
            out.push(hf);
            hf.setLocalScaling(new Ammo.btVector3(
              Math.max(0.001, col.terrainSizeX) / (n - 1),
              1,
              Math.max(0.001, col.terrainSizeZ) / (n - 1),
            ));
            const wrapper = new Ammo.btCompoundShape();
            out.push(wrapper);
            const t = new Ammo.btTransform();
            t.setIdentity();
            t.setOrigin(new Ammo.btVector3(0, mid, 0));
            out.push(t);
            wrapper.addChildShape(t, hf);
            s = wrapper;
            break;
          }
          default:
            s = new Ammo.btBoxShape(
              new Ammo.btVector3(col.halfExtents.x, col.halfExtents.y, col.halfExtents.z),
            );
        }
        out.push(s);
        return s;
      };
      // 碰撞事件（流形差分）：刚体指针 → 节点 id 在 createBody 登记；
      // 每步把「当前接触对」与「上一步接触对」diff 出 enter/exit
      const pointerToNode = new Map<number, string>();
      let prevPairs = new Set<string>();
      const pendingCollisions: CollisionEvent[] = [];
      const nodeOfPointer = (p: number): string | undefined => {
        const n = pointerToNode.get(p);
        return n === undefined ? undefined : n;
      };
      return {
        setGravity(g: PhysVec3): void {
          gravityVec.x = g.x;
          gravityVec.y = g.y;
          gravityVec.z = g.z;
          world.setGravity(new Ammo.btVector3(g.x, g.y, g.z));
          // Bullet 的 setGravity 已重置全部非静态体逐体重力：登记的缩放体重铺
          for (const e of gravityTracked) applyBodyGravity(e);
        },
        createBody(desc: BodyDesc): BodyHandle {
          const shapes: unknown[] = [];
          const compound = new Ammo.btCompoundShape();
          shapes.push(compound);
          for (const col of desc.colliders) {
            const child = buildShape(col, shapes);
            const t = new Ammo.btTransform();
            t.setIdentity();
            t.setOrigin(new Ammo.btVector3(col.offset.x, col.offset.y, col.offset.z));
            compound.addChildShape(t, child);
          }
          const start = new Ammo.btTransform();
          start.setIdentity();
          start.setOrigin(new Ammo.btVector3(desc.position.x, desc.position.y, desc.position.z));
          start.setRotation(
            new Ammo.btQuaternion(desc.quaternion.x, desc.quaternion.y, desc.quaternion.z, desc.quaternion.w),
          );
          const motionState = new Ammo.btDefaultMotionState(start);
          const mass = desc.mode === "dynamic" ? Math.max(0.001, desc.mass) : 0;
          const inertia = new Ammo.btVector3(0, 0, 0);
          if (mass > 0) compound.calculateLocalInertia(mass, inertia);
          const body = new Ammo.btRigidBody(
            new Ammo.btRigidBodyConstructionInfo(mass, motionState, compound, inertia),
          );
          if (desc.mode === "kinematic") {
            body.setCollisionFlags(body.getCollisionFlags() | CF_KINEMATIC_OBJECT);
            body.setActivationState(DISABLE_DEACTIVATION);
          }
          // 动力学体登记逐体重力（缩放 ≠ 1 时显式覆盖；= 1 跟随世界重力）。
          // 注意覆盖必须在下方 world.addRigidBody 之后——addRigidBody 会把
          // 体重力重置为世界重力，先覆盖会被冲掉
          let gravRecord: { body: AmmoBody; scale: number } | null = null;
          if (desc.mode === "dynamic") {
            gravRecord = { body, scale: desc.gravityScale };
            gravityTracked.push(gravRecord);
          }
          if (desc.colliders.some((c) => c.isSensor)) {
            body.setCollisionFlags(body.getCollisionFlags() | CF_NO_CONTACT_RESPONSE);
          }
          body.setFriction(desc.colliders[0]?.friction ?? 0.6);
          body.setRestitution(desc.colliders[0]?.restitution ?? 0.1);
          body.setDamping(desc.linearDamping, desc.angularDamping);
          if (desc.lockRotation) {
            // 锁定旋转：角因子归零并清空当前角速度（碰撞不改变姿态，防撞倒）
            body.setAngularFactor(new Ammo.btVector3(0, 0, 0));
            body.setAngularVelocity(new Ammo.btVector3(0, 0, 0));
          } else if (desc.upright) {
            // 直立不倒：仅保留 Y 轴旋转（碰撞不产生俯仰/翻滚，脚本可水平转向）
            body.setAngularFactor(new Ammo.btVector3(0, 1, 0));
          }
          if (desc.ccd) {
            body.setCcdMotionThreshold(0.01);
            body.setCcdSweptSphereRadius(0.02);
          }
          world.addRigidBody(body);
          // 逐体重力覆盖（缩放 ≠ 1）：见上方登记处注释
          if (gravRecord && gravRecord.scale !== 1) applyBodyGravity(gravRecord);
          pointerToNode.set(Ammo.getPointer(body), desc.nodeId);
          const handle: BodyHandle = {
            nodeId: desc.nodeId,
            setMode(mode: "static" | "kinematic" | "dynamic"): void {
              if (mode === "dynamic") {
                body.setCollisionFlags(body.getCollisionFlags() & ~CF_KINEMATIC_OBJECT);
                body.activate(true);
              } else {
                if (mode === "kinematic") {
                  body.setCollisionFlags(body.getCollisionFlags() | CF_KINEMATIC_OBJECT);
                  body.setActivationState(DISABLE_DEACTIVATION);
                } else {
                  body.setCollisionFlags(body.getCollisionFlags() & ~CF_KINEMATIC_OBJECT);
                }
              }
            },
            setKinematicTarget(p: PhysVec3, q: PhysQuat): void {
              const t = new Ammo.btTransform();
              t.setIdentity();
              t.setOrigin(new Ammo.btVector3(p.x, p.y, p.z));
              t.setRotation(new Ammo.btQuaternion(q.x, q.y, q.z, q.w));
              body.getMotionState().setWorldTransform(t);
              body.activate(true);
            },
            setTransform(p: PhysVec3, q: PhysQuat): void {
              const t = new Ammo.btTransform();
              t.setIdentity();
              t.setOrigin(new Ammo.btVector3(p.x, p.y, p.z));
              t.setRotation(new Ammo.btQuaternion(q.x, q.y, q.z, q.w));
              body.getMotionState().setWorldTransform(t);
            },
            readTransform(): { position: PhysVec3; quaternion: PhysQuat } {
              const t = new Ammo.btTransform();
              body.getMotionState().getWorldTransform(t);
              const p = t.getOrigin();
              const q = t.getRotation();
              const out = {
                position: { x: p.x(), y: p.y(), z: p.z() },
                quaternion: { x: q.x(), y: q.y(), z: q.z(), w: q.w() },
              };
              return out;
            },
            setMass(m: number): void {
              const inertia = new Ammo.btVector3(0, 0, 0);
              compound.calculateLocalInertia(Math.max(0.001, m), inertia);
              body.setMassProps(Math.max(0.001, m), inertia);
              body.activate(true);
            },
            setDamping(l: number, a: number): void {
              body.setDamping(l, a);
            },
            setGravityScale(s: number): void {
              // ammo 无逐体系数：显式覆盖逐体重力 = 世界重力 × 缩放
              if (!gravRecord) return;
              gravRecord.scale = Math.max(0, s);
              applyBodyGravity(gravRecord);
              body.activate(true);
            },
            setCcd(on: boolean): void {
              if (on) {
                body.setCcdMotionThreshold(0.01);
                body.setCcdSweptSphereRadius(0.02);
              } else {
                body.setCcdMotionThreshold(0);
                body.setCcdSweptSphereRadius(0);
              }
            },
            applyImpulse(v) {
              body.applyCentralImpulse(new Ammo.btVector3(v.x, v.y, v.z));
              body.activate(true);
            },
            applyForce(v: PhysVec3): void {
              body.applyCentralForce(new Ammo.btVector3(v.x, v.y, v.z));
              body.activate(true);
            },
            setLinearVelocity(v: PhysVec3): void {
              body.setLinearVelocity(new Ammo.btVector3(v.x, v.y, v.z));
              body.activate(true);
            },
            setAngularVelocity(v: PhysVec3): void {
              body.setAngularVelocity(new Ammo.btVector3(v.x, v.y, v.z));
              body.activate(true);
            },
            getLinearVelocity(): PhysVec3 {
              const v = body.getLinearVelocity();
              return { x: v.x(), y: v.y(), z: v.z() };
            },
            wakeUp(): void {
              body.activate(true);
            },
            raw: body,
          };
          bodies.push(handle);
          return handle;
        },
        destroyBody(b: BodyHandle): void {
          const i = bodies.indexOf(b);
          if (i >= 0) bodies.splice(i, 1);
          world.removeRigidBody(b.raw as AmmoBody); // createBody 产出的原生刚体
        },
        step(dt: number): void {
          world.stepSimulation(Math.max(0.0001, dt), 1, Math.max(0.0001, dt));
          // 持续接触不弹：存活超过一步的接触流形取消弹性——速度持续压向碰撞体
          // 时不再逐帧反弹（新流形保留弹性，首次撞击仍会弹起）
          const dispatcher = world.getDispatcher();
          const count = dispatcher.getNumManifolds();
          const current = new Set<number>();
          const activeBodies = new Set<number>();
          for (let i = 0; i < count; i++) {
            const manifold = dispatcher.getManifoldByIndexInternal(i);
            if (manifold.getNumContacts() <= 0) continue;
            const key = Ammo.getPointer(manifold);
            current.add(key);
            if (seenManifolds.has(key)) {
              // 持续接触：双方弹性临时置零（速度持续压向碰撞体时不再逐帧反弹）；
              // 原值记录在 zeroedRestitution，接触结束后恢复
              for (const b of [manifold.getBody0(), manifold.getBody1()]) {
                const ptr = Ammo.getPointer(b);
                activeBodies.add(ptr);
                if (!zeroedRestitution.has(ptr)) {
                  zeroedRestitution.set(ptr, { obj: b, value: b.getRestitution() });
                  b.setRestitution(0);
                }
              }
            }
          }
          seenManifolds.clear();
          for (const key of current) seenManifolds.add(key);
          // 接触结束：恢复被清零弹性的碰撞对象原值
          for (const [ptr, rec] of [...zeroedRestitution]) {
            if (!activeBodies.has(ptr)) {
              rec.obj.setRestitution(rec.value);
              zeroedRestitution.delete(ptr);
            }
          }
          // 流形差分：接触对出现 = enter，消失 = exit
          const num = dispatcher.getNumManifolds();
          const cur = new Set<string>();
          for (let i = 0; i < num; i++) {
            const m = dispatcher.getManifoldByIndexInternal(i);
            if (m.getNumContacts() <= 0) continue;
            const p0 = Ammo.getPointer(m.getBody0());
            const p1 = Ammo.getPointer(m.getBody1());
            if (p0 === p1) continue;
            const key = p0 < p1 ? `${p0}|${p1}` : `${p1}|${p0}`;
            cur.add(key);
            if (!prevPairs.has(key)) {
              const a = nodeOfPointer(p0);
              const b = nodeOfPointer(p1);
              if (a !== undefined && b !== undefined) pendingCollisions.push({ a, b, started: true });
            }
          }
          for (const key of prevPairs) {
            if (cur.has(key)) continue;
            const [p0, p1] = key.split("|").map(Number);
            const a = nodeOfPointer(p0);
            const b = nodeOfPointer(p1);
            if (a !== undefined && b !== undefined) pendingCollisions.push({ a, b, started: false });
          }
          prevPairs = cur;
        },
        takeCollisionEvents(): CollisionEvent[] {
          return pendingCollisions.splice(0);
        },
        castRay(options: RaycastOptions): RayHit[] {
          const dir = options.direction;
          const dirLen = Math.hypot(dir.x, dir.y, dir.z);
          if (dirLen < 1e-9) return [];
          const maxDistance = options.maxDistance ?? Infinity;
          const exclude = new Set(options.excludeNodeIds ?? []);
          const o = options.origin;
          const rayLen = Number.isFinite(maxDistance) ? maxDistance : 1e9;
          const from = new Ammo.btVector3(o.x, o.y, o.z);
          const to = new Ammo.btVector3(
            o.x + dir.x / dirLen * rayLen,
            o.y + dir.y / dirLen * rayLen,
            o.z + dir.z / dirLen * rayLen,
          );
          // AllHits 回调收集全部命中：ClosestRayResultCallback 遇到最近命中被排除
          // （excludeNodeIds）时无法穿透继续找，这里线性取最近的未排除命中
          const cb = new Ammo.AllHitsRayResultCallback(from, to);
          world.rayTest(from, to, cb);
          let best: RayHit | null = null;
          if (cb.hasHit()) {
            const objs = cb.get_m_collisionObjects();
            const points = cb.get_m_hitPointWorld();
            const normals = cb.get_m_hitNormalWorld();
            const count = objs.size();
            for (let i = 0; i < count; i++) {
              const nodeId = pointerToNode.get(Ammo.getPointer(objs.at(i)));
              if (nodeId === undefined || exclude.has(nodeId)) continue;
              const p = points.at(i);
              const distance = Math.hypot(p.x() - o.x, p.y() - o.y, p.z() - o.z);
              if (!best || distance < best.distance) {
                const n = normals.at(i);
                best = {
                  nodeId,
                  point: { x: p.x(), y: p.y(), z: p.z() },
                  normal: { x: n.x(), y: n.y(), z: n.z() },
                  distance,
                };
              }
            }
          }
          try { Ammo.destroy(from); Ammo.destroy(to); Ammo.destroy(cb); } catch {}
          return best ? [best] : [];
        },
        dispose(): void {
          for (const b of [...bodies]) world.removeRigidBody(b.raw as AmmoBody); // createBody 产出的原生刚体
          bodies.length = 0;
          // 高度场裸缓冲（embind destroy 不托管 _malloc 指针）：随世界销毁统一释放
          for (const ptr of heightfieldBuffers) {
            try {
              Ammo._free(ptr);
            } catch {
              /* 重复释放忽略 */
            }
          }
          heightfieldBuffers.clear();
        },
      };
    },
  };
}

/** 后端加载器表（工厂注册；新增后端在此追加） */
const BACKEND_LOADERS: Record<PhysicsBackendId, PhysicsBackendLoader> = {
  rapier: loadRapier,
  jolt: loadJolt,
  ammo: loadAmmo,
};

/** backend 字段收敛（未知/缺省回退 rapier；与 ["ammo","jolt","rapier"].includes 同语义） */
function backendIdOf(v: unknown): PhysicsBackendId {
  return v === "ammo" || v === "jolt" || v === "rapier" ? v : "rapier";
}

// ---------------------------------------------------------------------------
// 物理系统（创建入口）
// ---------------------------------------------------------------------------

/**
 * 创建播放器物理运行时。
 * @param {object} opts
 * @param {Array<{json: object, obj: object}>} opts.nodes buildSceneTree 的全节点注册表
 * @param {Array<{json: object, obj: object, data: object, settings: object}>} [opts.terrains]
 *        buildSceneTree 的地形节点收集（烘焙高度网格缓存；heightfield 碰撞体读取）
 * @param {object} [opts.settings] scene.settings.physics（backend/gravity/physicsEnabled）
 * @returns {Promise<object>} { update(dt), setGravity, applyImpulse, … } 物理控制 API
 */
export async function createPhysics({ nodes, terrains, settings }: CreatePhysicsOptions = {} as CreatePhysicsOptions): Promise<PhysicsApi> {
  // 缺省 {} 仅维持原解构形态（运行时 nodes 必传；断言仅类型面放行占位缺省）
  const cfg = (settings && typeof settings === "object" ? settings : {}) as ScenePhysicsSettingsJson; // 已过 object 守卫，断言收窄 gravity/backend 字段
  const gravity = {
    x: num(cfg.gravity?.x, 0),
    y: num(cfg.gravity?.y, -9.81),
    z: num(cfg.gravity?.z, 0),
  };
  const enabled = cfg.physicsEnabled === true;
  const backendId = backendIdOf(cfg.backend);

  /** 脚本宿主/调试用的运行控制面（未启用/未就绪时安全空转；方法集与真实
   *  后端接线完全一致——脚本经 getComponent("rigidBody")/engine.physics 访问
   *  任一方法都不应抛错，否则脚本宿主会把整个脚本实例停用） */
  const api: PhysicsApi = {
    /** 运行线程标识（调试面板/回退告警消费：false = 主线程模拟） */
    workerMode: false,
    /** 每帧推进（渲染循环调用） */
    update() {},
    setGravity() {},
    applyImpulse() {},
    applyForce() {},
    setLinearVelocity() {},
    setAngularVelocity() {},
    getLinearVelocity() {
      return null;
    },
    /** 物理体信息（物理未启用时恒为 null → getComponent("rigidBody") 返回 null） */
    bodyInfo() {
      return null;
    },
    setGravityScale() {},
    wakeUp() {},
    /** 射线投射（返回命中列表；未启用/未就绪时返回空数组） */
    castRay() {
      return [];
    },
    /** 碰撞事件排空（脚本宿主每帧调用；元素 {a, b, started} 为节点 id 对） */
    drainCollisions() {
      return [];
    },
  };

  // 绑定收集（文档序：先父后子）；地形烘焙网格按节点 id 建索引（heightfield 读取）
  const terrainById = new Map<string | undefined, unknown>();
  for (const t of Array.isArray(terrains) ? terrains : []) {
    const id = t && typeof t.json?.id === "string" ? t.json.id : "";
    if (id && t.data) terrainById.set(id, t.data);
  }
  const bindings: PhysicsBinding[] = [];
  for (const { json, obj } of nodes) {
    const comps = Array.isArray(json.components) ? json.components : [];
    const rbComp = comps.find((c) => c && c.type === "rigidBody" && c.enabled !== false);
    const colliders = comps
      .filter((c) => c && c.type === "collider" && c.enabled !== false)
      .map((c) => ({ id: c.id, settings: parseCollider(c.collider) }));
    if (!rbComp && colliders.length === 0) continue;
    bindings.push({
      nodeId: json.id,
      obj,
      rb: rbComp ? parseRigidBody(rbComp.rigidBody) : null,
      colliders,
      terrain: terrainById.get(json.id) ?? null,
      body: null,
    });
  }
  if (!bindings.length || !enabled) return api;

  const loader = BACKEND_LOADERS[backendId] ?? BACKEND_LOADERS.rapier;
  let world: PhysicsWorld;
  try {
    const backend = await loader();
    world = backend.createWorld(gravity);
  } catch (e) {
    // e?.message ?? e：非 Error 抛出值原样透传（断言仅放行属性读取，运行时同原式）
    const msg = (e as { message?: unknown } | null | undefined)?.message ?? e;
    postLog("error", `物理引擎(${backendId})加载失败: ${String(msg)}`);
    return api;
  }

  // 建体（以当前世界位姿为初值）
  const tmpPos = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const snapshots = new Map<string | undefined, { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }>();
  for (const b of bindings) {
    const obj = b.obj;
    obj.updateWorldMatrix(true, false);
    obj.getWorldPosition(tmpPos);
    obj.getWorldQuaternion(tmpQuat);
    snapshots.set(b.nodeId, {
      position: obj.position.clone(),
      quaternion: obj.quaternion.clone(),
      scale: obj.scale.clone(),
    });
    const rb: RigidBodySettings = b.rb ?? { mode: "static", mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 1, ccd: false, lockRotation: false, upright: false };
    b.body = world.createBody({
      // 绑定节点 json.id 类型面收窄（物理体句柄以节点 id 寻址）
      nodeId: b.nodeId as string,
      mode: rb.mode,
      position: { x: tmpPos.x, y: tmpPos.y, z: tmpPos.z },
      quaternion: { x: tmpQuat.x, y: tmpQuat.y, z: tmpQuat.z, w: tmpQuat.w },
      // SceneTerrainEntry.data 声明为 unknown → 断言收窄（createTerrain 产出的高度网格）
      colliders: b.colliders.map((c) => colliderDescFor(c.settings, obj, b.terrain as TerrainGridData | null)),
      mass: rb.mass,
      linearDamping: rb.linearDamping,
      angularDamping: rb.angularDamping,
      gravityScale: rb.gravityScale,
      ccd: rb.ccd,
      lockRotation: rb.lockRotation,
      upright: rb.upright,
    });
    // 动力学体：上一帧/当前帧物理位姿（世界空间）快照，供帧间插值回写
    if (rb.mode === "dynamic") {
      b.prevPos = new THREE.Vector3();
      b.prevQuat = new THREE.Quaternion();
      b.currPos = new THREE.Vector3();
      b.currQuat = new THREE.Quaternion();
      b.hasPose = false;
    }
  }
  postLog("info", `[物理] ${backendId} 世界就绪（${bindings.length} 体，重力 ${gravity.y}）`);

  let paused = false;
  let accumulator = 0;
  const tmpMat = new THREE.Matrix4();
  const parentQuat = new THREE.Quaternion();
  const writePos = new THREE.Vector3();
  const writeQuat = new THREE.Quaternion();

  api.update = (dt) => {
    if (paused) return;
    // 1) 运动学体跟随节点对象世界位姿（动画先行）
    for (const b of bindings) {
      if (!b.body || !b.rb || b.rb.mode !== "kinematic") continue;
      b.obj.updateWorldMatrix(true, false);
      b.obj.getWorldPosition(tmpPos);
      b.obj.getWorldQuaternion(tmpQuat);
      b.body.setKinematicTarget({ x: tmpPos.x, y: tmpPos.y, z: tmpPos.z }, { x: tmpQuat.x, y: tmpQuat.y, z: tmpQuat.z, w: tmpQuat.w });
    }
    // 2) 固定步长推进
    accumulator += Math.min(dt, FIXED_DT * MAX_SUBSTEPS);
    let stepped = false;
    while (accumulator >= FIXED_DT) {
      world.step(FIXED_DT);
      accumulator -= FIXED_DT;
      stepped = true;
    }
    // 3) 动力学体回写对象局部变换（带帧间插值）：
    //    物理按固定步长推进，渲染帧率与之不同步——若仅在发生步进的帧写回，
    //    位置会以「跳一帧、追两帧」的方式到达，视觉上呈锯齿抖动。这里每帧
    //    对 prev/curr 两次物理位姿按 accumulator/FIXED_DT 插值后写回，运动在
    //    任意帧率下都平滑；非步进帧 prev=curr，插值结果保持不变。
    const alpha = Math.max(0, Math.min(1, accumulator / FIXED_DT));
    // 父级世界矩阵的逆变换按父级缓存：同一父级下多个动态体（常见：同一容器内
    // 的一批刚体）只做一次 updateWorldMatrix + 求逆；帧内共享父级的世界矩阵不会
    // 变（回写只改子级局部变换），与逐体重算结果一致
    let lastParent: THREE.Object3D | null = null;
    for (const b of bindings) {
      if (!b.body || !b.rb || b.rb.mode !== "dynamic") continue;
      if (stepped) {
        const t = b.body.readTransform();
        if (t) {
          // hasPose 蕴含四个位姿向量已同帧初始化 → 非空断言
          const prevPos = b.prevPos as THREE.Vector3;
          const prevQuat = b.prevQuat as THREE.Quaternion;
          const currPos = b.currPos as THREE.Vector3;
          const currQuat = b.currQuat as THREE.Quaternion;
          if (!b.hasPose) {
            // 首次读到位姿：prev = curr，插值恒定（不外推）
            currPos.set(t.position.x, t.position.y, t.position.z);
            currQuat.set(t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w);
            prevPos.copy(currPos);
            prevQuat.copy(currQuat);
            b.hasPose = true;
          } else {
            prevPos.copy(currPos);
            prevQuat.copy(currQuat);
            currPos.set(t.position.x, t.position.y, t.position.z);
            currQuat.set(t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w);
          }
        }
      }
      if (!b.hasPose) continue;
      const prevPos = b.prevPos as THREE.Vector3; // hasPose=true 蕴含已初始化
      const prevQuat = b.prevQuat as THREE.Quaternion;
      const currPos = b.currPos as THREE.Vector3;
      const currQuat = b.currQuat as THREE.Quaternion;
      writePos.lerpVectors(prevPos, currPos, alpha);
      writeQuat.copy(prevQuat).slerp(currQuat, alpha);
      const parent = b.obj.parent;
      if (parent !== lastParent) {
        lastParent = parent;
        if (parent) {
          parent.updateWorldMatrix(true, false);
          tmpMat.copy(parent.matrixWorld).invert();
          parentQuat.setFromRotationMatrix(parent.matrixWorld).invert();
        }
      }
      if (parent) {
        writePos.applyMatrix4(tmpMat);
        writeQuat.premultiply(parentQuat);
      }
      b.obj.position.copy(writePos);
      b.obj.quaternion.copy(writeQuat);
    }
  };

  api.setGravity = (x, y, z) => world.setGravity({ x, y, z });
  api.drainCollisions = () => world.takeCollisionEvents();
  api.castRay = (options) => world.castRay(options);

  const bodyOf = (nodeId: string): BodyHandle | null => bindings.find((b) => b.nodeId === nodeId)?.body ?? null;
  api.applyImpulse = (nodeId, x, y, z) => bodyOf(nodeId)?.applyImpulse({ x, y, z });
  api.applyForce = (nodeId, x, y, z) => bodyOf(nodeId)?.applyForce({ x, y, z });
  api.setLinearVelocity = (nodeId, x, y, z) => bodyOf(nodeId)?.setLinearVelocity({ x, y, z });
  api.setAngularVelocity = (nodeId, x, y, z) => bodyOf(nodeId)?.setAngularVelocity({ x, y, z });
  api.getLinearVelocity = (nodeId) => bodyOf(nodeId)?.getLinearVelocity() ?? null;
  // 节点物理体信息（脚本 SDK getComponent("rigidBody") 门面数据源）：未绑定返回 null
  api.bodyInfo = (nodeId) => {
    const b = bindings.find((x) => x.nodeId === nodeId);
    if (!b) return null;
    return {
      // 无刚体仅有碰撞体 = 隐式静态
      mode: b.rb ? b.rb.mode : "static",
      gravityScale: b.rb ? b.rb.gravityScale : 1,
      colliderCount: b.colliders.length,
    };
  };
  api.setGravityScale = (nodeId, scale) => bodyOf(nodeId)?.setGravityScale(scale);
  api.wakeUp = (nodeId) => bodyOf(nodeId)?.wakeUp();

  return api;
}
// ---------------------------------------------------------------------------
// Worker 代理模式：物理模拟在独立线程运行，主线程经 postMessage 同步变换。
// 双缓冲策略——update() 应用上一帧 Worker 返回的动力学体变换，同时发送当前帧
// 全节点变换给 Worker；Worker 并行步进，结果在下一帧 update() 时取用。
// 单页导出（Blob URL import.meta.url）无法解析 Worker 模块路径，回退主线程。
// ---------------------------------------------------------------------------

/** Worker 传输的序列化物理节点（对齐 physics-worker.ts SerializedPhysNode） */
interface SerializedPhysNode {
  nodeId: string | undefined;
  json: NodeJson | Record<string, unknown>;
  position: number[];
  quaternion: number[];
  scale: number[];
  parentId: string | null;
  isMesh: boolean;
  vertices: Float32Array | null;
}

/** Worker init 应答（ready 携带动态体清单与 bodyInfo 缓存） */
interface WorkerReadyMsg {
  type: "ready";
  dynamicIds: string[];
  bodyInfos: Record<string, BodyInfo>;
}

/** Worker → 主线程消息（对齐 physics-worker.ts PhysicsWorkerOut） */
type WorkerOutMsg =
  | WorkerReadyMsg
  | { type: "recycleInput"; buffer: ArrayBuffer }
  | { type: "stepped"; transforms: Float32Array; velocities?: Float32Array; collisions?: CollisionEvent[] }
  | { type: "result"; method: string; value: unknown }
  | { type: "raycastResult"; id: number; hits?: RayHit[] }
  | { type: "error" };

/** 序列化节点为 Worker 可传输的纯数据（obj → position/quaternion/scale/parent/geometry） */
function serializeNodes(nodes: ReadonlyArray<PhysNodeInput>): SerializedPhysNode[] {
  const idSet = new Set<string | undefined>(nodes.map((n) => n.json?.id));
  return nodes.map((n): SerializedPhysNode => {
    const obj = n.obj;
    const parentId = obj.parent && idSet.has(obj.parent.userData?.__tveNodeId) ? obj.parent.userData.__tveNodeId : null;
    // 类型库只在 Mesh 声明 isMesh 标志（结构断言）
    const isMesh = !!(obj as { isMesh?: boolean }).isMesh;
    let vertices: Float32Array | null = null;
    if (isMesh && (obj as THREE.Mesh).geometry?.attributes?.position) {
      // position 属性分量恒为浮点数组（断言收窄 TypedArray 联合）
      vertices = (obj as THREE.Mesh).geometry.attributes.position.array.slice() as Float32Array;
    }
    return {
      nodeId: n.json.id,
      json: n.json,
      position: [obj.position.x, obj.position.y, obj.position.z],
      quaternion: [obj.quaternion.x, obj.quaternion.y, obj.quaternion.z, obj.quaternion.w],
      scale: [obj.scale.x, obj.scale.y, obj.scale.z],
      parentId,
      isMesh,
      vertices,
    };
  });
}

/**
 * 创建物理 Worker 代理（与 createPhysics 同接口）。
 * 在多文件导出模式下使用 Worker 线程；单页模式回退到 createPhysics。
 */
export async function createPhysicsWorker(opts: CreatePhysicsOptions & { workerUrl?: string }): Promise<PhysicsApi> {
  const { nodes, terrains, settings, workerUrl } = opts || {};
  const enabled = settings?.physicsEnabled === true;
  if (!enabled || !workerUrl) return createPhysics(opts);

  // 标记节点 Object3D 的 nodeId（供 serializeNodes 查找 parent）
  for (const { json, obj } of nodes) {
    if (obj && json?.id) obj.userData = { ...obj.userData, __tveNodeId: json.id };
  }

  const serialized = serializeNodes(nodes);
  // terrains 含 Three.js 对象（obj/data.geometry），不可结构化克隆，
  // 只提取 createPhysics 需要的纯数据字段（json.id + data.heights/gridSize/size）
  const serializedTerrains = (Array.isArray(terrains) ? terrains : [])
    .filter((t) => t?.json?.id && t?.data)
    .map((t) => {
      // filter 谓词已确保 json.id 与 data（createTerrain 产出的高度场纯数据）
      const d = t.data as TerrainGridData;
      const id = t.json?.id as string;
      return {
        json: { id },
        data: {
          heights: d.heights,
          gridSize: d.gridSize,
          size: d.size,
        },
      };
    });
  let worker: Worker;
  try {
    worker = new Worker(workerUrl, { type: "module" });
    worker.postMessage({ type: "init", nodes: serialized, terrains: serializedTerrains, settings });
  } catch {
    return createPhysics(opts);
  }

  // 等待 Worker ready
  const ready = await new Promise<WorkerReadyMsg | null>((resolve) => {
    worker.onmessage = (e: MessageEvent): void => {
      const msg = e.data as Partial<WorkerReadyMsg> | null; // Worker 协议（见 physics-worker.ts）
      if (msg?.type === "ready") resolve(msg as WorkerReadyMsg);
      else if (msg?.type === "error") resolve(null);
    };
    worker.onerror = (): void => resolve(null);
  });
  if (!ready) {
    worker.terminate();
    return createPhysics(opts);
  }

  const dynamicIds: string[] = ready.dynamicIds || [];
  const dynamicMap = new Map<string, THREE.Object3D>();
  const dynamicIndex = new Map<string, number>();
  for (let i = 0; i < dynamicIds.length; i++) {
    const id = dynamicIds[i];
    dynamicIndex.set(id, i);
    const node = nodes.find((n) => n.json?.id === id);
    if (node) dynamicMap.set(id, node.obj);
  }
  const cachedBodyInfos: Record<string, BodyInfo> = ready.bodyInfos || {};

  // 双缓冲：pending = Worker 上一帧返回的动力学体变换
  let pending: Extract<WorkerOutMsg, { type: "stepped" }> | null = null;
  let workerBusy = false;
  let cachedCollisions: CollisionEvent[] = [];
  let cachedVelocities = new Float32Array(dynamicIds.length * 3);
  let raycastId = 0;
  const raycastPending = new Map<number, (hits: RayHit[]) => void>();

  worker.onmessage = (e: MessageEvent): void => {
    const msg = e.data as WorkerOutMsg; // Worker 协议（见 physics-worker.ts）
    if (msg.type === "stepped") {
      pending = msg;
      if (msg.velocities) cachedVelocities = msg.velocities;
      workerBusy = false;
    } else if (msg.type === "recycleInput") {
      // Worker 消费完 step 输入缓冲后原样送回（零拷贝复用；池空时兜底新建）
      if (msg.buffer) stepBufPool.push(new Float32Array(msg.buffer));
    } else if (msg.type === "result" && msg.method === "drainCollisions") {
      // 协议约定 value = 碰撞事件数组（节点 id 对）
      cachedCollisions = msg.value as CollisionEvent[];
    } else if (msg.type === "raycastResult") {
      const resolve = raycastPending.get(msg.id);
      if (resolve) {
        raycastPending.delete(msg.id);
        resolve(msg.hits ?? []);
      }
    }
  };

  // step 输入缓冲池（transfer 往返复用，免去每帧 nodes×7 的 Float32Array 分配；
  // Worker 消费后经 recycleInput 归还，池空兜底新建）
  const stepBufPool: Float32Array[] = [];

  const api: PhysicsApi = {
    /** 运行线程标识（调试面板/回退告警消费：true = 独立线程模拟） */
    workerMode: true,
    update(dt: number): void {
      // 1) 应用上一帧 Worker 返回的动力学体变换
      if (pending) {
        const t = pending.transforms;
        for (let i = 0, j = 0; i < dynamicIds.length; i++, j += 7) {
          const obj = dynamicMap.get(dynamicIds[i]);
          if (!obj) continue;
          obj.position.set(t[j], t[j + 1], t[j + 2]);
          obj.quaternion.set(t[j + 3], t[j + 4], t[j + 5], t[j + 6]);
        }
        // 消费完的结果缓冲送回 Worker 复用（velocities 由 cachedVelocities
        // 长期引用，不回收；只回收 transforms）
        try {
          worker.postMessage({ type: "recycleResult", buf: t }, [t.buffer]);
        } catch {
          /* Worker 已终止等，静默忽略 */
        }
        cachedCollisions = pending.collisions || [];
        pending = null;
      }
      // 2) 发送当前帧全节点变换给 Worker（非忙时）
      if (!workerBusy) {
        const buf = stepBufPool.pop() ?? new Float32Array(nodes.length * 7);
        for (let i = 0, j = 0; i < nodes.length; i++, j += 7) {
          const obj = nodes[i].obj;
          buf[j] = obj.position.x;
          buf[j + 1] = obj.position.y;
          buf[j + 2] = obj.position.z;
          buf[j + 3] = obj.quaternion.x;
          buf[j + 4] = obj.quaternion.y;
          buf[j + 5] = obj.quaternion.z;
          buf[j + 6] = obj.quaternion.w;
        }
        try {
          worker.postMessage({ type: "step", dt, transforms: buf }, [buf.buffer]);
          workerBusy = true;
        } catch {
          /* Worker 已终止等，静默忽略 */
        }
      }
    },
    setGravity(x: number, y: number, z: number): void { try { worker.postMessage({ type: "command", method: "setGravity", args: [x, y, z] }); } catch {} },
    applyImpulse(nodeId: string, x: number, y: number, z: number): void { try { worker.postMessage({ type: "command", method: "applyImpulse", args: [nodeId, x, y, z] }); } catch {} },
    applyForce(nodeId: string, x: number, y: number, z: number): void { try { worker.postMessage({ type: "command", method: "applyForce", args: [nodeId, x, y, z] }); } catch {} },
    setLinearVelocity(nodeId: string, x: number, y: number, z: number): void { try { worker.postMessage({ type: "command", method: "setLinearVelocity", args: [nodeId, x, y, z] }); } catch {} },
    setAngularVelocity(nodeId: string, x: number, y: number, z: number): void { try { worker.postMessage({ type: "command", method: "setAngularVelocity", args: [nodeId, x, y, z] }); } catch {} },
    getLinearVelocity(nodeId: string): PhysVec3 | null {
      const idx = dynamicIndex.get(nodeId);
      if (idx === undefined) return null;
      const k = idx * 3;
      return { x: cachedVelocities[k], y: cachedVelocities[k + 1], z: cachedVelocities[k + 2] };
    },
    bodyInfo(nodeId: string): BodyInfo | null { return cachedBodyInfos[nodeId] || null; },
    setGravityScale(nodeId: string, scale: number): void { try { worker.postMessage({ type: "command", method: "setGravityScale", args: [nodeId, scale] }); } catch {} },
    wakeUp(nodeId: string): void { try { worker.postMessage({ type: "command", method: "wakeUp", args: [nodeId] }); } catch {} },
    castRay(options: RaycastOptions): Promise<RayHit[]> {
      return new Promise<RayHit[]>((resolve) => {
        const id = ++raycastId;
        raycastPending.set(id, resolve);
        try {
          worker.postMessage({ type: "castRay", id, options });
        } catch {
          raycastPending.delete(id);
          resolve([]);
        }
      });
    },
    drainCollisions(): CollisionEvent[] {
      const c = cachedCollisions;
      cachedCollisions = [];
      return c;
    },
    dispose(): void {
      for (const resolve of raycastPending.values()) resolve([]);
      raycastPending.clear();
      worker.postMessage({ type: "dispose" });
      worker.terminate();
    },
  };

  postLog("info", "[物理] Worker 模式已启动（物理模拟在独立线程）");
  return api;
}
