// ---------------------------------------------------------------------------
// Ammo.js（Bullet Physics）后端适配器（离线构建经 <script> 注入，免打包）：
// - 引擎资源从 engineBaseUrl（public/engine/runtime/physics-engines/ammo/）
//   加载 ammo.wasm.js + ammo.wasm.wasm；编辑器与播放器共用同一份离线文件；
// - static = 质量0；kinematic = 质量0 + CF_KINEMATIC_OBJECT + DISABLE_DEACTIVATION
//   （位移经 motion state 写入）；dynamic = 质量/惯性全额；
// - 传感器 = CF_NO_CONTACT_RESPONSE；重力缩放 = 每体 setGravity(gravity×scale)；
// - 多碰撞体/带偏移时用 btCompoundShape 复合。
// ---------------------------------------------------------------------------

import type { Vec3 } from "../../prototype/types";
import type { RigidBodyMode } from "../types";
import type {
  ColliderShapeDesc,
  IPhysicsBody,
  IPhysicsWorld,
  PhysicsBodyDesc,
  PhysicsQuat,
  PhysicsTransform,
  PhysicsWorldSettings,
} from "./types";

// —— Ammo（无类型的 vendored 构建）最小面 ——
interface AmmoVector3 {
  x(): number;
  y(): number;
  z(): number;
  setValue(x: number, y: number, z: number): void;
}
interface AmmoQuaternion {
  x(): number;
  y(): number;
  z(): number;
  w(): number;
  setValue(x: number, y: number, z: number, w: number): void;
}
interface AmmoTransform {
  setIdentity(): void;
  setOrigin(v: AmmoVector3): void;
  setRotation(q: AmmoQuaternion): void;
  getOrigin(): AmmoVector3;
  getRotation(): AmmoQuaternion;
}
interface AmmoMotionState {
  getWorldTransform(t: AmmoTransform): void;
  setWorldTransform(t: AmmoTransform): void;
}
interface AmmoShape {
  calculateLocalInertia(mass: number, out: AmmoVector3): void;
}
interface AmmoConvexHullShape extends AmmoShape {
  addPoint(p: AmmoVector3, recalcLocalAabb?: boolean): void;
  recalcLocalAabb(): void;
}
interface AmmoCompoundShape extends AmmoShape {
  addChildShape(t: AmmoTransform, shape: AmmoShape): void;
}
interface AmmoRigidBody {
  getMotionState(): AmmoMotionState;
  setMassProps(mass: number, inertia: AmmoVector3): void;
  setDamping(linear: number, angular: number): void;
  setGravity(g: AmmoVector3): void;
  setActivationState(state: number): void;
  activate(force?: boolean): void;
  isActive(): boolean;
  setCollisionFlags(flags: number): void;
  getCollisionFlags(): number;
  setFriction(f: number): void;
  setRestitution(r: number): void;
  applyCentralImpulse(v: AmmoVector3): void;
  applyCentralForce(v: AmmoVector3): void;
  setLinearVelocity(v: AmmoVector3): void;
  setAngularVelocity(v: AmmoVector3): void;
  getLinearVelocity(): AmmoVector3;
  setCcdMotionThreshold(t: number): void;
  setCcdSweptSphereRadius(r: number): void;
}
interface AmmoDynamicsWorld {
  setGravity(v: AmmoVector3): void;
  addRigidBody(b: AmmoRigidBody): void;
  removeRigidBody(b: AmmoRigidBody): void;
  stepSimulation(dt: number, subSteps: number, fixedStep: number): void;
}
interface AmmoAPI {
  btVector3: new (x?: number, y?: number, z?: number) => AmmoVector3;
  btQuaternion: new (x: number, y: number, z: number, w: number) => AmmoQuaternion;
  btTransform: new () => AmmoTransform;
  btDefaultMotionState: new (startTransform: AmmoTransform) => AmmoMotionState;
  btBoxShape: new (halfExtents: AmmoVector3) => AmmoShape;
  btSphereShape: new (radius: number) => AmmoShape;
  btCapsuleShape: new (radius: number, cylinderHeight: number) => AmmoShape;
  btCylinderShape: new (halfExtents: AmmoVector3) => AmmoShape;
  btConvexHullShape: new () => AmmoConvexHullShape;
  btCompoundShape: new () => AmmoCompoundShape;
  btRigidBodyConstructionInfo: new (
    mass: number,
    motionState: AmmoMotionState,
    shape: AmmoShape,
    localInertia: AmmoVector3,
  ) => object;
  btRigidBody: new (info: object) => AmmoRigidBody;
  btDefaultCollisionConfiguration: new () => object;
  btCollisionDispatcher: new (cfg: object) => object;
  btDbvtBroadphase: new () => object;
  btSequentialImpulseConstraintSolver: new () => object;
  btDiscreteDynamicsWorld: new (
    dispatcher: object,
    broadphase: object,
    solver: object,
    cfg: object,
  ) => AmmoDynamicsWorld;
}

/** Bullet 碰撞对象标志位 */
const CF_KINEMATIC_OBJECT = 2;
const CF_NO_CONTACT_RESPONSE = 4;
/** 激活状态：不休眠（运动学体持续跟随节点变换必需） */
const DISABLE_DEACTIVATION = 4;

let ammoPromise: Promise<AmmoAPI> | null = null;

/**
 * 动态加载 ammo ESM 初始化器（public/engine/runtime/physics-engines/ammo/ammo-esm.mjs；
 * wasm 以 base64 内联，无外部 .wasm 文件依赖，编辑器与播放器共用同一份文件）。
 * URL 在运行时拼接（public 资产不经打包器），@vite-ignore 阻止构建期解析。
 */
function loadAmmo(engineBaseUrl: string): Promise<AmmoAPI> {
  if (!ammoPromise) {
    ammoPromise = (async () => {
      const base = engineBaseUrl.replace(/\/+$/, "");
      const url = new URL(`${base}/ammo-esm.mjs`, document.baseURI).href;
      const mod = (await import(/* @vite-ignore */ url)) as {
        initAmmo?: () => Promise<AmmoAPI>;
      };
      if (typeof mod.initAmmo !== "function") {
        throw new Error(`ammo-esm.mjs 缺少 initAmmo: ${url}`);
      }
      return await mod.initAmmo();
    })();
  }
  return ammoPromise;
}

/** emscripten 对象释放（胶水未导出 destroy 时为无害空操作） */
function safeDestroy(api: AmmoAPI, obj: unknown): void {
  try {
    (api as { destroy?: (o: unknown) => void }).destroy?.(obj);
  } catch {
    /* 已释放/非托管对象忽略 */
  }
}

/** 形状构建（不含偏移；offset 经复合形状/包装处理）；产物记入 outShapes 随体释放 */
function buildShape(api: AmmoAPI, col: ColliderShapeDesc, outShapes: AmmoShape[]): AmmoShape {
  const v = new api.btVector3(0, 0, 0);
  outShapes.push(v as unknown as AmmoShape);
  switch (col.shape) {
    case "sphere":
      return new api.btSphereShape(Math.max(0.001, col.radius));
    case "capsule":
      // Bullet btCapsuleShape(radius, cylinderHeight)：柱段全高
      return new api.btCapsuleShape(Math.max(0.001, col.radius), Math.max(0.002, col.halfHeight * 2));
    case "cylinder":
      return new api.btCylinderShape(
        new api.btVector3(Math.max(0.001, col.radius), Math.max(0.001, col.halfHeight), Math.max(0.001, col.radius)),
      );
    case "convex": {
      if (col.points.length >= 12) {
        const hull = new api.btConvexHullShape();
        for (let i = 0; i + 2 < col.points.length; i += 3) {
          hull.addPoint(new api.btVector3(col.points[i], col.points[i + 1], col.points[i + 2]), false);
        }
        hull.recalcLocalAabb();
        outShapes.push(hull);
        return hull;
      }
      return new api.btBoxShape(new api.btVector3(0.5, 0.5, 0.5));
    }
    case "box":
    default:
      return new api.btBoxShape(
        new api.btVector3(
          Math.max(0.001, col.halfExtents.x),
          Math.max(0.001, col.halfExtents.y),
          Math.max(0.001, col.halfExtents.z),
        ),
      );
  }
}

class AmmoBodyAdapter implements IPhysicsBody {
  /** 每体重力（重力缩放≠1 时覆盖世界重力） */
  private scaledGravity: AmmoVector3 | null = null;

  constructor(
    private api: AmmoAPI,
    world: AmmoDynamicsWorld,
    private body: AmmoRigidBody,
    private shape: AmmoShape,
    private worldGravity: Vec3,
    private gravityScale: number,
    readonly nodeId: string,
  ) {
    void world;
  }

  private kinematic(): boolean {
    return (this.body.getCollisionFlags() & CF_KINEMATIC_OBJECT) !== 0;
  }

  setMode(mode: RigidBodyMode): void {
    const api = this.api;
    const body = this.body;
    // Bullet 原地切换：改质量/标志位/激活态
    if (mode === "dynamic") {
      const inertia = new api.btVector3(0, 0, 0);
      this.shape.calculateLocalInertia(Math.max(0.001, 1), inertia);
      body.setMassProps(1, inertia);
      safeDestroy(api, inertia);
      body.setCollisionFlags(body.getCollisionFlags() & ~CF_KINEMATIC_OBJECT);
      body.activate(true);
    } else {
      const zero = new api.btVector3(0, 0, 0);
      body.setMassProps(0, zero);
      safeDestroy(api, zero);
      if (mode === "kinematic") {
        body.setCollisionFlags(body.getCollisionFlags() | CF_KINEMATIC_OBJECT);
        body.setActivationState(DISABLE_DEACTIVATION);
      } else {
        body.setCollisionFlags(body.getCollisionFlags() & ~CF_KINEMATIC_OBJECT);
      }
    }
  }

  setKinematicTarget(position: Vec3, quaternion: PhysicsQuat): void {
    if (!this.kinematic()) return;
    const api = this.api;
    const t = new api.btTransform();
    t.setIdentity();
    t.setOrigin(new api.btVector3(position.x, position.y, position.z));
    t.setRotation(new api.btQuaternion(quaternion.x, quaternion.y, quaternion.z, quaternion.w));
    this.body.getMotionState().setWorldTransform(t);
    this.body.activate(true);
    safeDestroy(api, t);
  }

  setTransform(position: Vec3, quaternion: PhysicsQuat): void {
    const api = this.api;
    const t = new api.btTransform();
    t.setIdentity();
    t.setOrigin(new api.btVector3(position.x, position.y, position.z));
    t.setRotation(new api.btQuaternion(quaternion.x, quaternion.y, quaternion.z, quaternion.w));
    this.body.getMotionState().setWorldTransform(t);
    safeDestroy(api, t);
  }

  readTransform(): PhysicsTransform | null {
    const api = this.api;
    const t = new api.btTransform();
    this.body.getMotionState().getWorldTransform(t);
    const p = t.getOrigin();
    const q = t.getRotation();
    const out: PhysicsTransform = {
      position: { x: p.x(), y: p.y(), z: p.z() },
      quaternion: { x: q.x(), y: q.y(), z: q.z(), w: q.w() },
    };
    safeDestroy(api, t);
    return out;
  }

  setMass(mass: number): void {
    const api = this.api;
    const inertia = new api.btVector3(0, 0, 0);
    this.shape.calculateLocalInertia(Math.max(0.001, mass), inertia);
    this.body.setMassProps(Math.max(0.001, mass), inertia);
    safeDestroy(api, inertia);
    this.body.activate(true);
  }

  setDamping(linear: number, angular: number): void {
    this.body.setDamping(linear, angular);
  }

  setGravityScale(scale: number): void {
    this.gravityScale = Math.max(0, scale);
    if (this.scaledGravity) {
      safeDestroy(this.api, this.scaledGravity);
      this.scaledGravity = null;
    }
    if (Math.abs(this.gravityScale - 1) > 1e-6) {
      this.scaledGravity = new this.api.btVector3(
        this.worldGravity.x * this.gravityScale,
        this.worldGravity.y * this.gravityScale,
        this.worldGravity.z * this.gravityScale,
      );
      this.body.setGravity(this.scaledGravity);
    }
    this.body.activate(true);
  }

  /** 世界重力变化后同步每体覆盖重力（scale=1 的体回退世界重力） */
  syncWorldGravity(g: Vec3): void {
    this.worldGravity = { ...g };
    if (this.scaledGravity) {
      safeDestroy(this.api, this.scaledGravity);
      this.scaledGravity = new this.api.btVector3(g.x * this.gravityScale, g.y * this.gravityScale, g.z * this.gravityScale);
      this.body.setGravity(this.scaledGravity);
    }
  }

  setCcd(enabled: boolean): void {
    if (enabled) {
      this.body.setCcdMotionThreshold(0.01);
      this.body.setCcdSweptSphereRadius(0.02);
    } else {
      this.body.setCcdMotionThreshold(0);
      this.body.setCcdSweptSphereRadius(0);
    }
  }

  applyImpulse(impulse: Vec3): void {
    this.body.applyCentralImpulse(new this.api.btVector3(impulse.x, impulse.y, impulse.z));
    this.body.activate(true);
  }

  applyForce(force: Vec3): void {
    this.body.applyCentralForce(new this.api.btVector3(force.x, force.y, force.z));
    this.body.activate(true);
  }

  setLinearVelocity(v: Vec3): void {
    this.body.setLinearVelocity(new this.api.btVector3(v.x, v.y, v.z));
    this.body.activate(true);
  }

  setAngularVelocity(v: Vec3): void {
    this.body.setAngularVelocity(new this.api.btVector3(v.x, v.y, v.z));
    this.body.activate(true);
  }

  getLinearVelocity(): Vec3 | null {
    const v = this.body.getLinearVelocity();
    return { x: v.x(), y: v.y(), z: v.z() };
  }

  wakeUp(): void {
    this.body.activate(true);
  }

  raw(): AmmoRigidBody {
    return this.body;
  }
}

class AmmoWorldAdapter implements IPhysicsWorld {
  readonly backend = "ammo" as const;
  private world: AmmoDynamicsWorld;
  private bodies: AmmoBodyAdapter[] = [];
  /** 全部托管 emscripten 对象（dispose 逐个释放） */
  private tracked: unknown[] = [];
  private gravity: Vec3;

  constructor(
    private api: AmmoAPI,
    gravity: Vec3,
  ) {
    this.gravity = { ...gravity };
    const cfg = new api.btDefaultCollisionConfiguration();
    const dispatcher = new api.btCollisionDispatcher(cfg);
    const broadphase = new api.btDbvtBroadphase();
    const solver = new api.btSequentialImpulseConstraintSolver();
    this.world = new api.btDiscreteDynamicsWorld(dispatcher, broadphase, solver, cfg);
    const g = new api.btVector3(gravity.x, gravity.y, gravity.z);
    this.world.setGravity(g);
    this.tracked.push(cfg, dispatcher, broadphase, solver, g);
  }

  setGravity(g: Vec3): void {
    this.gravity = { ...g };
    const v = new this.api.btVector3(g.x, g.y, g.z);
    this.world.setGravity(v);
    this.tracked.push(v);
    // 每体覆盖重力（缩放≠1）按新世界重力重算
    for (const b of this.bodies) b.syncWorldGravity(g);
  }

  createBody(desc: PhysicsBodyDesc): IPhysicsBody | null {
    const api = this.api;
    if (!desc.colliders.length) return null;
    // 形状：单碰撞体且无偏移直接用；否则复合
    const shapes: AmmoShape[] = [];
    let shape: AmmoShape;
    if (desc.colliders.length === 1 && desc.colliders[0].offset.x === 0 && desc.colliders[0].offset.y === 0 && desc.colliders[0].offset.z === 0) {
      shape = buildShape(api, desc.colliders[0], shapes);
    } else {
      const compound = new api.btCompoundShape();
      shapes.push(compound);
      for (const col of desc.colliders) {
        const child = buildShape(api, col, shapes);
        const t = new api.btTransform();
        t.setIdentity();
        t.setOrigin(new api.btVector3(col.offset.x, col.offset.y, col.offset.z));
        compound.addChildShape(t, child);
        this.tracked.push(t);
      }
      shape = compound;
    }
    // 位姿 + 运动状态
    const start = new api.btTransform();
    start.setIdentity();
    start.setOrigin(new api.btVector3(desc.position.x, desc.position.y, desc.position.z));
    start.setRotation(new api.btQuaternion(desc.quaternion.x, desc.quaternion.y, desc.quaternion.z, desc.quaternion.w));
    const motionState = new api.btDefaultMotionState(start);
    this.tracked.push(start, motionState);
    // 质量与惯性
    const mass = desc.mode === "dynamic" ? Math.max(0.001, desc.mass) : 0;
    const inertia = new api.btVector3(0, 0, 0);
    if (mass > 0) shape.calculateLocalInertia(mass, inertia);
    this.tracked.push(inertia);
    const info = new api.btRigidBodyConstructionInfo(mass, motionState, shape, inertia);
    this.tracked.push(info);
    const body = new api.btRigidBody(info);
    this.tracked.push(body);
    if (desc.mode === "kinematic") {
      body.setCollisionFlags(body.getCollisionFlags() | CF_KINEMATIC_OBJECT);
      body.setActivationState(DISABLE_DEACTIVATION);
    }
    if (desc.colliders.some((c) => c.isSensor)) {
      body.setCollisionFlags(body.getCollisionFlags() | CF_NO_CONTACT_RESPONSE);
    }
    body.setFriction(desc.colliders[0]?.friction ?? 0.6);
    body.setRestitution(desc.colliders[0]?.restitution ?? 0.1);
    body.setDamping(desc.linearDamping, desc.angularDamping);
    if (desc.ccd) {
      body.setCcdMotionThreshold(0.01);
      body.setCcdSweptSphereRadius(0.02);
    }
    this.world.addRigidBody(body);
    const adapter = new AmmoBodyAdapter(api, this.world, body, shape, this.gravity, desc.gravityScale, desc.nodeId);
    if (desc.mode === "dynamic" && Math.abs(desc.gravityScale - 1) > 1e-6) {
      adapter.setGravityScale(desc.gravityScale);
    }
    this.bodies.push(adapter);
    return adapter;
  }

  destroyBody(body: IPhysicsBody): void {
    const adapter = body as AmmoBodyAdapter;
    const idx = this.bodies.indexOf(adapter);
    if (idx < 0) return;
    this.bodies.splice(idx, 1);
    this.world.removeRigidBody(adapter.raw());
  }

  step(dt: number): void {
    this.world.stepSimulation(Math.max(0.0001, dt), 1, Math.max(0.0001, dt));
  }

  dispose(): void {
    for (const b of [...this.bodies]) this.world.removeRigidBody(b.raw());
    this.bodies = [];
    for (const obj of this.tracked) {
      try {
        safeDestroy(this.api, obj);
      } catch {
        /* 已释放对象忽略 */
      }
    }
    this.tracked = [];
  }
}

/** 创建 Ammo 物理世界（首次调用时注入脚本并初始化 WASM） */
export async function createAmmoWorld(settings: PhysicsWorldSettings): Promise<IPhysicsWorld> {
  const base =
    settings.engineBaseUrl || "engine/runtime/physics-engines/ammo";
  const api = await loadAmmo(base);
  return new AmmoWorldAdapter(api, settings.gravity);
}
