// ---------------------------------------------------------------------------
// Rapier3D 后端适配器（@dimforge/rapier3d-compat，WASM 内联 base64）：
// - 引擎按需动态 import（工厂 create() 调用时才加载，主包零体积）；
// - static = fixed 体，kinematic = kinematicPositionBased，dynamic = dynamic；
// - 碰撞形状挂刚体（offset 经 ColliderDesc.setTranslation）；
// - setMode 原地切换 RigidBodyType；运动学位姿走 setNextKinematic*。
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

type RapierAPI = typeof import("@dimforge/rapier3d-compat")["default"];
type RapierWorld = InstanceType<RapierAPI["World"]>;
type RapierBody = InstanceType<RapierAPI["RigidBody"]>;

/** 引擎单例加载（WASM init 一次；后续世界复用） */
let rapierPromise: Promise<RapierAPI> | null = null;
async function loadRapier(): Promise<RapierAPI> {
  if (!rapierPromise) {
    rapierPromise = import("@dimforge/rapier3d-compat").then(async (mod) => {
      const R = mod.default;
      await R.init();
      return R;
    });
  }
  return rapierPromise;
}

class RapierBodyAdapter implements IPhysicsBody {
  constructor(
    private R: RapierAPI,
    private world: RapierWorld,
    private body: RapierBody,
    readonly nodeId: string,
  ) {}

  setMode(mode: RigidBodyMode): void {
    const R = this.R;
    const t =
      mode === "static"
        ? R.RigidBodyType.Fixed
        : mode === "kinematic"
          ? R.RigidBodyType.KinematicPositionBased
          : R.RigidBodyType.Dynamic;
    this.body.setBodyType(t, true);
  }

  setKinematicTarget(position: Vec3, quaternion: PhysicsQuat): void {
    this.body.setNextKinematicTranslation({ x: position.x, y: position.y, z: position.z });
    this.body.setNextKinematicRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w });
  }

  setTransform(position: Vec3, quaternion: PhysicsQuat): void {
    this.body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.body.setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w }, true);
  }

  readTransform(): PhysicsTransform | null {
    if (!this.body.isValid()) return null;
    const p = this.body.translation();
    const q = this.body.rotation();
    return { position: { x: p.x, y: p.y, z: p.z }, quaternion: { x: q.x, y: q.y, z: q.z, w: q.w } };
  }

  setMass(mass: number): void {
    // rapier 质量分布在碰撞体上：均分到本体的全部碰撞体
    const count = Math.max(1, this.body.numColliders());
    const per = Math.max(0.001, mass) / count;
    for (let i = 0; i < count; i++) {
      const col = this.body.collider(i);
      if (col) col.setMass(per);
    }
  }

  setDamping(linear: number, angular: number): void {
    this.body.setLinearDamping(linear);
    this.body.setAngularDamping(angular);
  }

  setGravityScale(scale: number): void {
    this.body.setGravityScale(scale, true);
  }

  setCcd(enabled: boolean): void {
    this.body.enableCcd(enabled);
  }

  applyImpulse(impulse: Vec3): void {
    this.body.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
  }

  applyForce(force: Vec3): void {
    this.body.addForce({ x: force.x, y: force.y, z: force.z }, true);
  }

  setLinearVelocity(v: Vec3): void {
    this.body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
  }

  setAngularVelocity(v: Vec3): void {
    this.body.setAngvel({ x: v.x, y: v.y, z: v.z }, true);
  }

  getLinearVelocity(): Vec3 | null {
    if (!this.body.isValid()) return null;
    const v = this.body.linvel();
    return { x: v.x, y: v.y, z: v.z };
  }

  wakeUp(): void {
    this.body.wakeUp();
  }

  /** 供世界销毁 */
  raw(): RapierBody {
    return this.body;
  }
  rawWorld(): RapierWorld {
    return this.world;
  }
}

function colliderDesc(R: RapierAPI, col: ColliderShapeDesc): InstanceType<RapierAPI["ColliderDesc"]> | null {
  let d: InstanceType<RapierAPI["ColliderDesc"]> | null = null;
  switch (col.shape) {
    case "sphere":
      d = R.ColliderDesc.ball(Math.max(0.001, col.radius));
      break;
    case "capsule":
      d = R.ColliderDesc.capsule(Math.max(0.001, col.halfHeight), Math.max(0.001, col.radius));
      break;
    case "cylinder":
      d = R.ColliderDesc.cylinder(Math.max(0.001, col.halfHeight), Math.max(0.001, col.radius));
      break;
    case "convex": {
      if (col.points.length >= 12) {
        const hull = R.ColliderDesc.convexHull(new Float32Array(col.points));
        if (hull) {
          d = hull;
          break;
        }
      }
      // 顶点不足/构建失败：包围盒兜底
      d = R.ColliderDesc.cuboid(0.5, 0.5, 0.5);
      break;
    }
    case "heightfield": {
      // Rapier（parry）高度场：heights 为 (nrows+1)×(ncols+1) 列主序矩阵，
      // 索引 = row + col*S，row ↔ 引擎 z、col ↔ 引擎 x（cell 宽 = scale.x/(S-1)）；
      // y = height × scale.y 绝对值，XZ 以原点为中心。desc.heights 是行主序
      // [z][x]（x 为快索引）→ 目标索引 row=z/col=x 恰好转置传入。
      // 网格无数据/规模不符 → 包围盒兜底（与 convex 顶点不足同策略）。
      const s = col.samples;
      if (!col.heights || s < 2 || col.heights.length < s * s) {
        d = R.ColliderDesc.cuboid(0.5, 0.5, 0.5);
        break;
      }
      const cm = new Float32Array(s * s);
      for (let iz = 0; iz < s; iz++) {
        for (let ix = 0; ix < s; ix++) {
          cm[iz + ix * s] = col.heights[iz * s + ix];
        }
      }
      d = R.ColliderDesc.heightfield(s - 1, s - 1, cm, {
        x: Math.max(0.001, col.terrainSizeX),
        y: 1,
        z: Math.max(0.001, col.terrainSizeZ),
      });
      break;
    }
    case "box":
    default:
      d = R.ColliderDesc.cuboid(
        Math.max(0.001, col.halfExtents.x),
        Math.max(0.001, col.halfExtents.y),
        Math.max(0.001, col.halfExtents.z),
      );
      break;
  }
  return d;
}

class RapierWorldAdapter implements IPhysicsWorld {
  readonly backend = "rapier" as const;
  private bodies = new Set<RapierBody>();

  constructor(
    private R: RapierAPI,
    private world: RapierWorld,
  ) {}

  setGravity(g: Vec3): void {
    this.world.gravity = { x: g.x, y: g.y, z: g.z };
  }

  createBody(desc: PhysicsBodyDesc): IPhysicsBody | null {
    const R = this.R;
    const bd =
      desc.mode === "static"
        ? R.RigidBodyDesc.fixed()
        : desc.mode === "kinematic"
          ? R.RigidBodyDesc.kinematicPositionBased()
          : R.RigidBodyDesc.dynamic();
    bd
      .setTranslation(desc.position.x, desc.position.y, desc.position.z)
      .setRotation({ x: desc.quaternion.x, y: desc.quaternion.y, z: desc.quaternion.z, w: desc.quaternion.w })
      .setLinearDamping(desc.linearDamping)
      .setAngularDamping(desc.angularDamping)
      .setGravityScale(desc.gravityScale)
      .setCcdEnabled(desc.ccd);
    const body = this.world.createRigidBody(bd);
    if (desc.lockRotation) body.lockRotations(true, true);
    else if (desc.upright) body.restrictRotations(false, true, false, true);
    for (const col of desc.colliders) {
      const cd = colliderDesc(R, col);
      if (!cd) continue;
      cd
        .setTranslation(col.offset.x, col.offset.y, col.offset.z)
        .setFriction(col.friction)
        .setRestitution(col.restitution)
        .setSensor(col.isSensor);
      this.world.createCollider(cd, body);
    }
    this.bodies.add(body);
    return new RapierBodyAdapter(this.R, this.world, body, desc.nodeId);
  }

  destroyBody(body: IPhysicsBody): void {
    const rb = body as RapierBodyAdapter;
    if (!this.bodies.has(rb.raw())) return;
    this.bodies.delete(rb.raw());
    this.world.removeRigidBody(rb.raw());
  }

  step(dt: number): void {
    this.world.timestep = Math.max(0.0001, dt);
    this.world.step();
  }

  dispose(): void {
    this.world.free();
  }
}

/** 创建 Rapier 物理世界（首次调用时异步初始化 WASM） */
export async function createRapierWorld(settings: PhysicsWorldSettings): Promise<IPhysicsWorld> {
  void settings.engineBaseUrl;
  const R = await loadRapier();
  const world = new R.World({ x: settings.gravity.x, y: settings.gravity.y, z: settings.gravity.z });
  return new RapierWorldAdapter(R, world);
}
