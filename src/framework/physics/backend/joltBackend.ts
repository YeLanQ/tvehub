// ---------------------------------------------------------------------------
// Jolt Physics 后端适配器（jolt-physics，WASM 内联 compat 构建）：
// - 引擎按需动态 import；Jolt() 初始化一次（wasm-compat 内联 base64，免配 wasm 路径）；
// - 碰撞层：两层表（MOVING/NON_MOVING），静态体入 NON_MOVING，其余 MOVING；
// - static/kinematic/dynamic → EMotionType_Static/Kinematic/Dynamic；
// - 运动学位姿经 BodyInterface.MoveKinematic（step 时带 dt 应用）；
// - emscripten 堆对象：位姿读写复用 scratch，形状在体销毁时释放。
// ---------------------------------------------------------------------------

import type { Vec3 } from "../../prototype/types";
import type { RigidBodyMode } from "../types";
import type {
  ColliderShapeDesc,
  IPhysicsBody,
  IPhysicsWorld,
  PhysicsBodyDesc,
  PhysicsQuat,
  PhysicsRayCastOptions,
  PhysicsRayHit,
  PhysicsTransform,
  PhysicsWorldSettings,
} from "./types";

type JoltFactory = typeof import("jolt-physics")["default"];
type JoltAPI = Awaited<ReturnType<JoltFactory>>;
type JoltBody = InstanceType<JoltAPI["Body"]>;
type JoltBodyInterface = InstanceType<JoltAPI["BodyInterface"]>;
type JoltShape = InstanceType<JoltAPI["Shape"]>;

/** 对象层（两层碰撞表：MOVING 与一切碰撞；NON_MOVING 只与 MOVING 碰撞） */
const LAYER_MOVING = 0;
const LAYER_NON_MOVING = 1;

let joltPromise: Promise<JoltAPI> | null = null;
async function loadJolt(): Promise<JoltAPI> {
  if (!joltPromise) {
    joltPromise = import("jolt-physics").then((mod) => mod.default() as Promise<JoltAPI>);
  }
  return joltPromise;
}

/** 形状构建失败（凸包退化等）时的包围盒兜底 */
function fallbackBox(jolt: JoltAPI): JoltShape {
  return new jolt.BoxShape(new jolt.Vec3(0.5, 0.5, 0.5), 0.03);
}

/** 生成单碰撞形状（不含偏移；偏移由 RotatedTranslatedShape 包装）；产物记入 outShapes 随体释放 */
function buildShape(jolt: JoltAPI, col: ColliderShapeDesc, outShapes: unknown[]): JoltShape {
  const track = (s: JoltShape): JoltShape => {
    outShapes.push(s);
    return s;
  };
  try {
    switch (col.shape) {
      case "sphere":
        return track(new jolt.SphereShape(Math.max(0.001, col.radius)));
      case "capsule":
        return track(new jolt.CapsuleShape(Math.max(0.001, col.halfHeight), Math.max(0.001, col.radius)));
      case "cylinder":
        return track(new jolt.CylinderShape(Math.max(0.001, col.halfHeight), Math.max(0.001, col.radius), 0.03));
      case "convex": {
        if (col.points.length >= 12) {
          const settings = new jolt.ConvexHullShapeSettings();
          for (let i = 0; i + 2 < col.points.length; i += 3) {
            settings.mPoints.push_back(new jolt.Vec3(col.points[i], col.points[i + 1], col.points[i + 2]));
          }
          const result = settings.Create();
          if (result.IsValid()) return track(result.Get());
        }
        return track(fallbackBox(jolt));
      }
      case "heightfield": {
        // Jolt 高度场：采样行主序 X-then-Z（与 desc.heights 布局一致），
        // 首采样位置 = mOffset，采样步长 = mScale；高度在 [min,max] 区间按
        // mBitsPerSample 量化（此版本要求 [1,16]，取 16 位：精度 (max-min)/65535）。
        // 每轴采样数须为 2 的幂（parse 已把 resolution 吸附到合法档位）。
        const s = col.samples;
        if (!col.heights || s < 2 || col.heights.length < s * s) {
          return track(fallbackBox(jolt));
        }
        const settings = new jolt.HeightFieldShapeSettings();
        settings.mSampleCount = s; // 每轴采样数（须 2 的幂；样本总数 = s²）
        settings.mBitsPerSample = 16;
        settings.mMinHeightValue = col.minHeight;
        settings.mMaxHeightValue = col.maxHeight;
        const samples = new jolt.ArrayFloat();
        samples.reserve(s * s);
        for (let i = 0; i < s * s; i++) samples.push_back(col.heights[i]);
        settings.mHeightSamples = samples;
        settings.mOffset = new jolt.Vec3(-col.terrainSizeX / 2, 0, -col.terrainSizeZ / 2);
        settings.mScale = new jolt.Vec3(
          col.terrainSizeX / (s - 1),
          1,
          col.terrainSizeZ / (s - 1),
        );
        const result = settings.Create();
        if (result.IsValid()) return track(result.Get());
        return track(fallbackBox(jolt));
      }
      case "box":
      default:
        return track(
          new jolt.BoxShape(
            new jolt.Vec3(
              Math.max(0.001, col.halfExtents.x),
              Math.max(0.001, col.halfExtents.y),
              Math.max(0.001, col.halfExtents.z),
            ),
            0.03,
          ),
        );
    }
  } catch {
    return track(fallbackBox(jolt));
  }
}

class JoltBodyAdapter implements IPhysicsBody {
  /** 待应用运动学目标（step 时带 dt 提交） */
  kinematicTarget: { position: Vec3; quaternion: PhysicsQuat } | null = null;

  constructor(
    private jolt: JoltAPI,
    private bi: JoltBodyInterface,
    private body: JoltBody,
    readonly nodeId: string,
  ) {}

  setMode(mode: RigidBodyMode): void {
    const j = this.jolt;
    // 层保持创建时的取值：MOVING 层与一切碰撞，静态化后仍正常参与碰撞
    const t =
      mode === "static"
        ? j.EMotionType_Static
        : mode === "kinematic"
          ? j.EMotionType_Kinematic
          : j.EMotionType_Dynamic;
    this.bi.SetMotionType(this.body.GetID(), t, j.EActivation_Activate);
  }

  setKinematicTarget(position: Vec3, quaternion: PhysicsQuat): void {
    this.kinematicTarget = { position: { ...position }, quaternion: { ...quaternion } };
  }

  setTransform(position: Vec3, quaternion: PhysicsQuat): void {
    const j = this.jolt;
    this.bi.SetPosition(
      this.body.GetID(),
      new j.RVec3(position.x, position.y, position.z),
      j.EActivation_DontActivate,
    );
    this.bi.SetRotation(
      this.body.GetID(),
      new j.Quat(quaternion.x, quaternion.y, quaternion.z, quaternion.w),
      j.EActivation_DontActivate,
    );
  }

  readTransform(): PhysicsTransform | null {
    const p = this.body.GetPosition();
    const q = this.body.GetRotation();
    return {
      position: { x: p.GetX(), y: p.GetY(), z: p.GetZ() },
      quaternion: { x: q.GetX(), y: q.GetY(), z: q.GetZ(), w: q.GetW() },
    };
  }

  setMass(mass: number): void {
    const mp = this.body.GetMotionProperties();
    if (mp) mp.SetInverseMass(1 / Math.max(0.001, mass));
  }

  setDamping(linear: number, angular: number): void {
    const mp = this.body.GetMotionProperties();
    if (!mp) return;
    mp.SetLinearDamping(linear);
    mp.SetAngularDamping(angular);
  }

  setGravityScale(scale: number): void {
    const mp = this.body.GetMotionProperties();
    if (mp) mp.SetGravityFactor(scale);
  }

  setCcd(enabled: boolean): void {
    this.bi.SetMotionQuality(
      this.body.GetID(),
      enabled ? this.jolt.EMotionQuality_LinearCast : this.jolt.EMotionQuality_Discrete,
    );
  }

  applyImpulse(impulse: Vec3): void {
    this.body.AddImpulse(new this.jolt.Vec3(impulse.x, impulse.y, impulse.z));
  }

  applyForce(force: Vec3): void {
    this.body.AddForce(new this.jolt.Vec3(force.x, force.y, force.z));
  }

  setLinearVelocity(v: Vec3): void {
    this.body.SetLinearVelocity(new this.jolt.Vec3(v.x, v.y, v.z));
  }

  setAngularVelocity(v: Vec3): void {
    this.body.SetAngularVelocity(new this.jolt.Vec3(v.x, v.y, v.z));
  }

  getLinearVelocity(): Vec3 | null {
    const v = this.body.GetLinearVelocity();
    return { x: v.GetX(), y: v.GetY(), z: v.GetZ() };
  }

  wakeUp(): void {
    this.bi.ActivateBody(this.body.GetID());
  }

  raw(): JoltBody {
    return this.body;
  }
}

class JoltWorldAdapter implements IPhysicsWorld {
  readonly backend = "jolt" as const;
  private interface3d: InstanceType<JoltAPI["JoltInterface"]>;
  private bodyInterface: JoltBodyInterface;
  private bodies = new Map<JoltBody, { shapes: unknown[]; adapter: JoltBodyAdapter }>();
  private gravityScratch: InstanceType<JoltAPI["Vec3"]>;

  constructor(
    private jolt: JoltAPI,
    gravity: Vec3,
  ) {
    const j = this.jolt;
    const settings = new j.JoltSettings();
    settings.mMaxWorkerThreads = 1;
    // 两层碰撞表（JoltPhysics.js 官方示例配置）
    const objectFilter = new j.ObjectLayerPairFilterTable(2);
    objectFilter.EnableCollision(LAYER_MOVING, LAYER_NON_MOVING);
    objectFilter.EnableCollision(LAYER_MOVING, LAYER_MOVING);
    const bpInterface = new j.BroadPhaseLayerInterfaceTable(2, 2);
    bpInterface.MapObjectToBroadPhaseLayer(LAYER_MOVING, new j.BroadPhaseLayer(0));
    bpInterface.MapObjectToBroadPhaseLayer(LAYER_NON_MOVING, new j.BroadPhaseLayer(1));
    settings.mObjectLayerPairFilter = objectFilter;
    settings.mBroadPhaseLayerInterface = bpInterface;
    settings.mObjectVsBroadPhaseLayerFilter = new j.ObjectVsBroadPhaseLayerFilterTable(
      bpInterface,
      2,
      objectFilter,
      2,
    );
    this.interface3d = new j.JoltInterface(settings);
    this.bodyInterface = this.interface3d.GetPhysicsSystem().GetBodyInterface();
    this.gravityScratch = new j.Vec3(gravity.x, gravity.y, gravity.z);
    this.interface3d.GetPhysicsSystem().SetGravity(this.gravityScratch);
  }

  setGravity(g: Vec3): void {
    this.gravityScratch.Set(g.x, g.y, g.z);
    this.interface3d.GetPhysicsSystem().SetGravity(this.gravityScratch);
  }

  createBody(desc: PhysicsBodyDesc): IPhysicsBody | null {
    const j = this.jolt;
    if (!desc.colliders.length) return null;
    const shapes: unknown[] = [];
    // 复合形状经 Settings 构建（MutableCompoundShape 无公开构造），AddShapeShape
    // 直接吃 Shape 子体（偏移即子体位移）
    const compoundSettings = new j.MutableCompoundShapeSettings();
    shapes.push(compoundSettings);
    for (const col of desc.colliders) {
      const s = buildShape(j, col, shapes);
      compoundSettings.AddShapeShape(
        new j.Vec3(col.offset.x, col.offset.y, col.offset.z),
        new j.Quat(0, 0, 0, 1),
        s,
        0,
      );
    }
    const shape: JoltShape = compoundSettings.Create().Get();
    const layer = desc.mode === "static" ? LAYER_NON_MOVING : LAYER_MOVING;
    const motionType =
      desc.mode === "static"
        ? j.EMotionType_Static
        : desc.mode === "kinematic"
          ? j.EMotionType_Kinematic
          : j.EMotionType_Dynamic;
    const creation = new j.BodyCreationSettings(
      shape,
      new j.RVec3(desc.position.x, desc.position.y, desc.position.z),
      new j.Quat(desc.quaternion.x, desc.quaternion.y, desc.quaternion.z, desc.quaternion.w),
      motionType,
      layer,
    );
    if (desc.lockRotation) {
      // 锁定旋转 = 只允许平移自由度（X|Y|Z）
      creation.mAllowedDOFs =
        j.EAllowedDOFs_TranslationX | j.EAllowedDOFs_TranslationY | j.EAllowedDOFs_TranslationZ;
    } else if (desc.upright) {
      // 直立不倒 = 平移 + 仅 Y 轴旋转（碰撞不产生俯仰/翻滚）
      creation.mAllowedDOFs =
        j.EAllowedDOFs_TranslationX | j.EAllowedDOFs_TranslationY | j.EAllowedDOFs_TranslationZ |
        j.EAllowedDOFs_RotationY;
    }
    const body = this.bodyInterface.CreateBody(creation);
    if (!body) return null;
    this.bodyInterface.AddBody(body.GetID(), j.EActivation_Activate);
    body.SetFriction(desc.colliders[0]?.friction ?? 0.6);
    body.SetRestitution(desc.colliders[0]?.restitution ?? 0.1);
    if (desc.mode === "dynamic") {
      const mp = body.GetMotionProperties();
      if (mp) {
        mp.SetInverseMass(1 / Math.max(0.001, desc.mass));
        mp.SetLinearDamping(desc.linearDamping);
        mp.SetAngularDamping(desc.angularDamping);
        mp.SetGravityFactor(desc.gravityScale);
      }
    }
    if (desc.ccd) {
      this.bodyInterface.SetMotionQuality(body.GetID(), j.EMotionQuality_LinearCast);
    }
    // 传感器在体级标注（单碰撞体语义；多碰撞体传感器请拆分节点）
    if (desc.colliders.length === 1 && desc.colliders[0].isSensor) body.SetIsSensor(true);
    const adapter = new JoltBodyAdapter(j, this.bodyInterface, body, desc.nodeId);
    this.bodies.set(body, { shapes, adapter });
    return adapter;
  }

  destroyBody(body: IPhysicsBody): void {
    const adapter = body as JoltBodyAdapter;
    const raw = adapter.raw();
    const entry = this.bodies.get(raw);
    if (!entry) return;
    this.bodies.delete(raw);
    this.bodyInterface.RemoveBody(raw.GetID());
    this.bodyInterface.DestroyBody(raw.GetID());
    for (const s of entry.shapes) {
      try {
        this.jolt.destroy(s);
      } catch {
        /* 已释放/非托管对象忽略 */
      }
    }
  }

  step(dt: number): void {
    const j = this.jolt;
    // 运动学目标：MoveKinematic 需要步长 dt（内部换算为速度）
    for (const { adapter } of this.bodies.values()) {
      const t = adapter.kinematicTarget;
      if (!t) continue;
      adapter.kinematicTarget = null;
      this.bodyInterface.MoveKinematic(
        adapter.raw().GetID(),
        new j.RVec3(t.position.x, t.position.y, t.position.z),
        new j.Quat(t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w),
        dt,
      );
    }
    this.interface3d.Step(dt, 1);
  }

  castRay(options: PhysicsRayCastOptions): PhysicsRayHit[] {
    const j = this.jolt;
    const dir = options.direction;
    const dirLen = Math.hypot(dir.x, dir.y, dir.z);
    if (dirLen < 1e-9) return [];
    const maxDistance = options.maxDistance ?? Infinity;
    const exclude = new Set(options.excludeNodeIds ?? []);
    const rayLen = Number.isFinite(maxDistance) ? maxDistance : 1e9;
    // Jolt 射线是有向线段：方向须带长度，命中分数 mFraction ∈ [0,1) 相对线段长
    const ray = new j.RRayCast();
    (ray as unknown as { mOrigin: unknown }).mOrigin = new j.RVec3(options.origin.x, options.origin.y, options.origin.z);
    ray.mDirection = new j.Vec3(dir.x / dirLen * rayLen, dir.y / dirLen * rayLen, dir.z / dirLen * rayLen);
    const result = new j.RayCastResult();
    // result 为 in/out（初值 fraction = 1）：CastRay 只在更近时覆写，
    // 逐体投完后 result 即最近命中，bestNodeId/bestBody 记录归属
    let bestNodeId: string | null = null;
    let bestBody: JoltBody | null = null;
    for (const [body, entry] of this.bodies) {
      const nodeId = entry.adapter.nodeId;
      if (exclude.has(nodeId)) continue;
      const ts = body.GetTransformedShape();
      const prevFraction = result.mFraction;
      try {
        (ts as unknown as { CastRay: (r: unknown, res: unknown) => void }).CastRay(ray, result);
      } catch {
        continue;
      }
      if (result.mFraction < prevFraction) {
        bestNodeId = nodeId;
        bestBody = body;
      }
    }
    if (!bestNodeId || !bestBody || result.mFraction >= 1) {
      j.destroy(ray);
      j.destroy(result);
      return [];
    }
    const point = ray.GetPointOnRay(result.mFraction);
    let normal = { x: 0, y: 0, z: 0 };
    try {
      const ts = bestBody.GetTransformedShape();
      const n = (ts as unknown as { GetWorldSpaceSurfaceNormal: (id: unknown, p: unknown) => { GetX(): number; GetY(): number; GetZ(): number } }).GetWorldSpaceSurfaceNormal(result.mSubShapeID2, point);
      normal = { x: n.GetX(), y: n.GetY(), z: n.GetZ() };
      j.destroy(n);
    } catch {
      /* GetWorldSpaceSurfaceNormal 不可用时法线归零 */
    }
    const hit: PhysicsRayHit = {
      nodeId: bestNodeId,
      point: { x: point.GetX(), y: point.GetY(), z: point.GetZ() },
      normal,
      distance: result.mFraction * rayLen,
    };
    j.destroy(point);
    j.destroy(ray);
    j.destroy(result);
    return [hit];
  }

  dispose(): void {
    this.jolt.destroy(this.gravityScratch);
    // JoltInterface 销毁即释放整个物理系统（wasm 模块随进程退出回收）
    this.jolt.destroy(this.interface3d);
  }
}

/** 创建 Jolt 物理世界（首次调用时异步初始化 WASM） */
export async function createJoltWorld(settings: PhysicsWorldSettings): Promise<IPhysicsWorld> {
  void settings.engineBaseUrl;
  const jolt = await loadJolt();
  return new JoltWorldAdapter(jolt, settings.gravity);
}
