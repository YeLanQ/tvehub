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
//   冲量/力/速度/重力缩放。
// ---------------------------------------------------------------------------

import * as THREE from "./three.module.min.js";
import { postLog } from "./log.mjs";

/** 固定模拟步长（秒）与每帧最大子步数（与编辑器一致） */
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 4;

// ---------------------------------------------------------------------------
// 设置收敛（与 framework/physics/types.ts 同规则）
// ---------------------------------------------------------------------------

function num(v, fb) {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function parseRigidBody(v) {
  const o = v && typeof v === "object" ? v : {};
  const mode = typeof o.mode === "string" ? o.mode : "dynamic";
  return {
    mode: mode === "static" || mode === "kinematic" || mode === "dynamic" ? mode : "dynamic",
    mass: clamp(num(o.mass, 1), 0.001, 1e6),
    linearDamping: Math.max(0, num(o.linearDamping, 0.05)),
    angularDamping: Math.max(0, num(o.angularDamping, 0.05)),
    gravityScale: Math.max(0, num(o.gravityScale, 1)),
    ccd: o.ccd === true,
  };
}

function parseCollider(v) {
  const o = v && typeof v === "object" ? v : {};
  const shape = typeof o.shape === "string" ? o.shape : "box";
  const sz = o.size && typeof o.size === "object" ? o.size : {};
  const off = o.offset && typeof o.offset === "object" ? o.offset : {};
  return {
    shape: ["box", "sphere", "capsule", "cylinder", "convex"].includes(shape) ? shape : "box",
    autoSize: o.autoSize !== false,
    size: { x: num(sz.x, 1), y: num(sz.y, 1), z: num(sz.z, 1) },
    offset: { x: num(off.x, 0), y: num(off.y, 0), z: num(off.z, 0) },
    friction: clamp(num(o.friction, 0.6), 0, 4),
    restitution: clamp(num(o.restitution, 0.1), 0, 1),
    isSensor: o.isSensor === true,
  };
}

// ---------------------------------------------------------------------------
// 碰撞形状推导（对象局部包围盒 + 世界缩放烘入尺寸；与编辑器同规则）
// ---------------------------------------------------------------------------

function computeLocalBounds(obj) {
  obj.updateWorldMatrix(true, true);
  const box = new THREE.Box3().makeEmpty();
  const objInv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const childMat = new THREE.Matrix4();
  let firstMesh = null;
  let sampleAttr = null;
  obj.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    childMat.copy(child.matrixWorld).premultiply(objInv);
    const geo = child.geometry;
    geo.computeBoundingBox();
    if (geo.boundingBox) box.union(geo.boundingBox.clone().applyMatrix4(childMat));
    if (!firstMesh) {
      firstMesh = child;
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
  const points = [];
  if (sampleAttr) {
    const count = sampleAttr.count;
    const step = Math.max(1, Math.floor(count / 64));
    const v = new THREE.Vector3();
    for (let i = 0; i < count && points.length < 64 * 3; i += step) {
      v.fromBufferAttribute(sampleAttr, i).applyMatrix4(childMat);
      points.push(v.x, v.y, v.z);
    }
  }
  return { center, half, points };
}

function colliderDescFor(col, obj) {
  const s = col;
  let half = { x: 0.5, y: 0.5, z: 0.5 };
  let center = { x: 0, y: 0, z: 0 };
  let points = [];
  if (s.autoSize) {
    const b = computeLocalBounds(obj);
    if (b) {
      half = b.half;
      center = b.center;
      points = b.points;
    }
  } else {
    half = { x: Math.max(0.05, s.size.x / 2), y: Math.max(0.05, s.size.y / 2), z: Math.max(0.05, s.size.z / 2) };
  }
  const ws = obj.getWorldScale(new THREE.Vector3());
  const sx = Math.abs(ws.x) || 1;
  const sy = Math.abs(ws.y) || 1;
  const sz = Math.abs(ws.z) || 1;
  const uniform = (sx + sy + sz) / 3;
  const desc = {
    shape: s.shape,
    halfExtents: { x: Math.max(0.001, half.x * sx), y: Math.max(0.001, half.y * sy), z: Math.max(0.001, half.z * sz) },
    radius: Math.max(0.001, Math.max(half.x * sx, half.z * sz, s.shape === "sphere" ? half.y * sy : 0.001)),
    halfHeight: 0.5,
    points: [],
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
      desc.radius = Math.max(0.001, Math.max(half.x, half.z));
      desc.halfHeight = Math.max(0.001, half.y - desc.radius);
      break;
    case "cylinder":
      desc.radius = Math.max(0.001, Math.max(half.x, half.z));
      desc.halfHeight = Math.max(0.001, half.y);
      break;
    case "convex": {
      if (points.length) {
        const scaled = new Array(points.length);
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

async function loadRapier() {
  // 字面量说明符：单页构建经 build.rs 重写为 import map 裸说明符（勿改成运行时拼 URL）
  const mod = await import("./physics-engines/rapier.mjs");
  const R = mod.default;
  await R.init();
  return {
    createWorld(gravity) {
      const world = new R.World({ x: gravity.x, y: gravity.y, z: gravity.z });
      const bodies = new Set();
      const shapeOf = (col) => {
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
          default:
            return R.ColliderDesc.cuboid(col.halfExtents.x, col.halfExtents.y, col.halfExtents.z);
        }
      };
      return {
        setGravity(g) {
          world.gravity = { x: g.x, y: g.y, z: g.z };
        },
        createBody(desc) {
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
          for (const col of desc.colliders) {
            const cd = shapeOf(col)
              .setTranslation(col.offset.x, col.offset.y, col.offset.z)
              .setFriction(col.friction)
              .setRestitution(col.restitution)
              .setSensor(col.isSensor);
            world.createCollider(cd, body);
          }
          bodies.add(body);
          return {
            nodeId: desc.nodeId,
            setMode(mode) {
              body.setBodyType(
                mode === "static"
                  ? R.RigidBodyType.Fixed
                  : mode === "kinematic"
                    ? R.RigidBodyType.KinematicPositionBased
                    : R.RigidBodyType.Dynamic,
                true,
              );
            },
            setKinematicTarget(p, q) {
              body.setNextKinematicTranslation(p);
              body.setNextKinematicRotation(q);
            },
            setTransform(p, q) {
              body.setTranslation(p, true);
              body.setRotation(q, true);
            },
            readTransform() {
              if (!body.isValid()) return null;
              const t = body.translation();
              const r = body.rotation();
              return { position: t, quaternion: r };
            },
            setMass(mass) {
              const count = Math.max(1, body.numColliders());
              for (let i = 0; i < count; i++) body.collider(i)?.setMass(Math.max(0.001, mass) / count);
            },
            setDamping(l, a) {
              body.setLinearDamping(l);
              body.setAngularDamping(a);
            },
            setGravityScale(s) {
              body.setGravityScale(s, true);
            },
            setCcd(on) {
              body.enableCcd(on);
            },
            applyImpulse(v) {
              body.applyImpulse(v, true);
            },
            applyForce(v) {
              body.addForce(v, true);
            },
            setLinearVelocity(v) {
              body.setLinvel(v, true);
            },
            setAngularVelocity(v) {
              body.setAngvel(v, true);
            },
            getLinearVelocity() {
              return body.isValid() ? body.linvel() : null;
            },
            wakeUp() {
              body.wakeUp();
            },
            raw: body,
          };
        },
        destroyBody(b) {
          const raw = b.raw;
          if (!bodies.has(raw)) return;
          bodies.delete(raw);
          world.removeRigidBody(raw);
        },
        step(dt) {
          world.timestep = Math.max(0.0001, dt);
          world.step();
        },
        dispose() {
          world.free();
        },
      };
    },
  };
}

async function loadJolt() {
  // 字面量说明符：单页构建经 build.rs 重写为 import map 裸说明符（勿改成运行时拼 URL）
  const mod = await import("./physics-engines/jolt.mjs");
  const Jolt = await mod.default();
  const LAYER_MOVING = 0;
  const LAYER_NON_MOVING = 1;
  return {
    createWorld(gravity) {
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
      const bodies = new Map();
      const buildShape = (col, out) => {
        let s;
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
        setGravity(g) {
          gravityScratch.Set(g.x, g.y, g.z);
          system.SetGravity(gravityScratch);
        },
        createBody(desc) {
          const shapes = [];
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
          const body = bi.CreateBody(creation);
          if (!body) return null;
          bi.AddBody(body.GetID(), Jolt.EActivation_Activate);
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
          let kinTarget = null;
          const handle = {
            nodeId: desc.nodeId,
            setMode(mode) {
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
            setKinematicTarget(p, q) {
              kinTarget = { p, q };
            },
            setTransform(p, q) {
              bi.SetPosition(body.GetID(), new Jolt.RVec3(p.x, p.y, p.z), Jolt.EActivation_DontActivate);
              bi.SetRotation(body.GetID(), new Jolt.Quat(q.x, q.y, q.z, q.w), Jolt.EActivation_DontActivate);
            },
            readTransform() {
              const p = body.GetPosition();
              const q = body.GetRotation();
              return { position: { x: p.GetX(), y: p.GetY(), z: p.GetZ() }, quaternion: { x: q.GetX(), y: q.GetY(), z: q.GetZ(), w: q.GetW() } };
            },
            setMass(mass) {
              mp?.SetInverseMass(1 / Math.max(0.001, mass));
            },
            setDamping(l, a) {
              mp?.SetLinearDamping(l);
              mp?.SetAngularDamping(a);
            },
            setGravityScale(s) {
              mp?.SetGravityFactor(s);
            },
            setCcd(on) {
              bi.SetMotionQuality(body.GetID(), on ? Jolt.EMotionQuality_LinearCast : Jolt.EMotionQuality_Discrete);
            },
            applyImpulse(v) {
              body.AddImpulse(new Jolt.Vec3(v.x, v.y, v.z));
            },
            applyForce(v) {
              body.AddForce(new Jolt.Vec3(v.x, v.y, v.z));
            },
            setLinearVelocity(v) {
              body.SetLinearVelocity(new Jolt.Vec3(v.x, v.y, v.z));
            },
            setAngularVelocity(v) {
              body.SetAngularVelocity(new Jolt.Vec3(v.x, v.y, v.z));
            },
            getLinearVelocity() {
              const v = body.GetLinearVelocity();
              return { x: v.GetX(), y: v.GetY(), z: v.GetZ() };
            },
            wakeUp() {
              bi.ActivateBody(body.GetID());
            },
            raw: body,
            takeKinematicTarget() {
              const t = kinTarget;
              kinTarget = null;
              return t;
            },
          };
          bodies.set(body, { shapes, handle });
          return handle;
        },
        destroyBody(b) {
          const entry = bodies.get(b.raw);
          if (!entry) return;
          bodies.delete(b.raw);
          bi.RemoveBody(b.raw.GetID());
          bi.DestroyBody(b.raw.GetID());
          for (const s of entry.shapes) {
            try {
              Jolt.destroy(s);
            } catch {
              /* 忽略 */
            }
          }
        },
        step(dt) {
          for (const { handle } of bodies.values()) {
            const t = handle.takeKinematicTarget();
            if (!t) continue;
            bi.MoveKinematic(
              handle.raw.GetID(),
              new Jolt.RVec3(t.p.x, t.p.y, t.p.z),
              new Jolt.Quat(t.q.x, t.q.y, t.q.z, t.q.w),
              dt,
            );
          }
          interface3d.Step(dt, 1);
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

async function loadAmmo() {
  // ESM 初始化器内联 wasmBinary（无外部 .wasm 文件依赖，单页内联可用）；
  // 字面量说明符：单页构建经 build.rs 重写为 import map 裸说明符
  const { initAmmo } = await import("./physics-engines/ammo/ammo-esm.mjs");
  const Ammo = await initAmmo();
  return {
    createWorld(gravity) {
      const cfg = new Ammo.btDefaultCollisionConfiguration();
      const dispatcher = new Ammo.btCollisionDispatcher(cfg);
      const broadphase = new Ammo.btDbvtBroadphase();
      const solver = new Ammo.btSequentialImpulseConstraintSolver();
      const world = new Ammo.btDiscreteDynamicsWorld(dispatcher, broadphase, solver, cfg);
      world.setGravity(new Ammo.btVector3(gravity.x, gravity.y, gravity.z));
      const bodies = [];
      const buildShape = (col, out) => {
        let s;
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
          default:
            s = new Ammo.btBoxShape(
              new Ammo.btVector3(col.halfExtents.x, col.halfExtents.y, col.halfExtents.z),
            );
        }
        out.push(s);
        return s;
      };
      const CF_KINEMATIC_OBJECT = 2;
      const CF_NO_CONTACT_RESPONSE = 4;
      const DISABLE_DEACTIVATION = 4;
      return {
        setGravity(g) {
          world.setGravity(new Ammo.btVector3(g.x, g.y, g.z));
        },
        createBody(desc) {
          const shapes = [];
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
          world.addRigidBody(body);
          const handle = {
            nodeId: desc.nodeId,
            setMode(mode) {
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
            setKinematicTarget(p, q) {
              const t = new Ammo.btTransform();
              t.setIdentity();
              t.setOrigin(new Ammo.btVector3(p.x, p.y, p.z));
              t.setRotation(new Ammo.btQuaternion(q.x, q.y, q.z, q.w));
              body.getMotionState().setWorldTransform(t);
              body.activate(true);
            },
            setTransform(p, q) {
              const t = new Ammo.btTransform();
              t.setIdentity();
              t.setOrigin(new Ammo.btVector3(p.x, p.y, p.z));
              t.setRotation(new Ammo.btQuaternion(q.x, q.y, q.z, q.w));
              body.getMotionState().setWorldTransform(t);
            },
            readTransform() {
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
            setMass(m) {
              const inertia = new Ammo.btVector3(0, 0, 0);
              compound.calculateLocalInertia(Math.max(0.001, m), inertia);
              body.setMassProps(Math.max(0.001, m), inertia);
              body.activate(true);
            },
            setDamping(l, a) {
              body.setDamping(l, a);
            },
            setGravityScale() {
              /* ammo 走每体重力，运行时简化：跟随世界重力 */
            },
            setCcd(on) {
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
            applyForce(v) {
              body.applyCentralForce(new Ammo.btVector3(v.x, v.y, v.z));
              body.activate(true);
            },
            setLinearVelocity(v) {
              body.setLinearVelocity(new Ammo.btVector3(v.x, v.y, v.z));
              body.activate(true);
            },
            setAngularVelocity(v) {
              body.setAngularVelocity(new Ammo.btVector3(v.x, v.y, v.z));
              body.activate(true);
            },
            getLinearVelocity() {
              const v = body.getLinearVelocity();
              return { x: v.x(), y: v.y(), z: v.z() };
            },
            wakeUp() {
              body.activate(true);
            },
            raw: body,
          };
          bodies.push(handle);
          return handle;
        },
        destroyBody(b) {
          const i = bodies.indexOf(b);
          if (i >= 0) bodies.splice(i, 1);
          world.removeRigidBody(b.raw);
        },
        step(dt) {
          world.stepSimulation(Math.max(0.0001, dt), 1, Math.max(0.0001, dt));
        },
        dispose() {
          for (const b of [...bodies]) world.removeRigidBody(b.raw);
          bodies.length = 0;
        },
      };
    },
  };
}

/** 后端加载器表（工厂注册；新增后端在此追加） */
const BACKEND_LOADERS = {
  rapier: loadRapier,
  jolt: loadJolt,
  ammo: loadAmmo,
};

// ---------------------------------------------------------------------------
// 物理系统（创建入口）
// ---------------------------------------------------------------------------

/**
 * 创建播放器物理运行时。
 * @param {object} opts
 * @param {Array<{json: object, obj: object}>} opts.nodes buildSceneTree 的全节点注册表
 * @param {object} [opts.settings] scene.settings.physics（backend/gravity/physicsEnabled）
 * @returns {Promise<object>} { update(dt), setGravity, applyImpulse, … } 物理控制 API
 */
export async function createPhysics({ nodes, settings } = {}) {
  const cfg = settings && typeof settings === "object" ? settings : {};
  const gravity = {
    x: num(cfg.gravity?.x, 0),
    y: num(cfg.gravity?.y, -9.81),
    z: num(cfg.gravity?.z, 0),
  };
  const enabled = cfg.physicsEnabled === true;
  const backendId = ["ammo", "jolt", "rapier"].includes(cfg.backend) ? cfg.backend : "rapier";

  /** 脚本宿主/调试用的运行控制面（未启用/未就绪时安全空转） */
  const api = {
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
    setGravityScale() {},
    wakeUp() {},
  };

  // 绑定收集（文档序：先父后子）
  const bindings = [];
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
      body: null,
    });
  }
  if (!bindings.length || !enabled) return api;

  const loader = BACKEND_LOADERS[backendId] ?? BACKEND_LOADERS.rapier;
  let world = null;
  try {
    const backend = await loader();
    world = backend.createWorld(gravity);
  } catch (e) {
    postLog("error", `物理引擎(${backendId})加载失败: ${e?.message ?? e}`);
    return api;
  }

  // 建体（以当前世界位姿为初值）
  const tmpPos = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const snapshots = new Map();
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
    const rb = b.rb ?? { mode: "static", mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 1, ccd: false };
    b.body = world.createBody({
      nodeId: b.nodeId,
      mode: rb.mode,
      position: { x: tmpPos.x, y: tmpPos.y, z: tmpPos.z },
      quaternion: { x: tmpQuat.x, y: tmpQuat.y, z: tmpQuat.z, w: tmpQuat.w },
      colliders: b.colliders.map((c) => colliderDescFor(c.settings, obj)),
      mass: rb.mass,
      linearDamping: rb.linearDamping,
      angularDamping: rb.angularDamping,
      gravityScale: rb.gravityScale,
      ccd: rb.ccd,
    });
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
    if (!stepped) return;
    // 3) 动力学体回写对象局部变换
    for (const b of bindings) {
      if (!b.body || !b.rb || b.rb.mode !== "dynamic") continue;
      const t = b.body.readTransform();
      if (!t) continue;
      const parent = b.obj.parent;
      writePos.set(t.position.x, t.position.y, t.position.z);
      writeQuat.set(t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w);
      if (parent) {
        parent.updateWorldMatrix(true, false);
        tmpMat.copy(parent.matrixWorld).invert();
        writePos.applyMatrix4(tmpMat);
        parentQuat.setFromRotationMatrix(parent.matrixWorld);
        writeQuat.premultiply(parentQuat.invert());
      }
      b.obj.position.copy(writePos);
      b.obj.quaternion.copy(writeQuat);
    }
  };

  api.setGravity = (x, y, z) => world.setGravity({ x, y, z });

  const bodyOf = (nodeId) => bindings.find((b) => b.nodeId === nodeId)?.body ?? null;
  api.applyImpulse = (nodeId, x, y, z) => bodyOf(nodeId)?.applyImpulse({ x, y, z });
  api.applyForce = (nodeId, x, y, z) => bodyOf(nodeId)?.applyForce({ x, y, z });
  api.setLinearVelocity = (nodeId, x, y, z) => bodyOf(nodeId)?.setLinearVelocity({ x, y, z });
  api.setAngularVelocity = (nodeId, x, y, z) => bodyOf(nodeId)?.setAngularVelocity({ x, y, z });
  api.getLinearVelocity = (nodeId) => bodyOf(nodeId)?.getLinearVelocity() ?? null;
  api.setGravityScale = (nodeId, scale) => bodyOf(nodeId)?.setGravityScale(scale);
  api.wakeUp = (nodeId) => bodyOf(nodeId)?.wakeUp();

  return api;
}
