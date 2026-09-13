// ---------------------------------------------------------------------------
// 物理系统（引擎模块）：驱动挂了 刚体/碰撞体 组件的节点。
//
// 设计要点（与 AudioSystem/AnimationSystem 同构）：
// - 绑定按节点 id 索引：引擎在节点入图/属性变化时把「节点数据 + 场景对象」交给
//   syncNode，系统按设置签名差异重建刚体；节点删除/场景重建时解绑；
// - 编辑态（未模拟）只维护绑定数据，不建物理世界；点击"模拟"（play）后异步
//   创建世界（后端工厂惰性加载引擎）、按当前世界位姿建体并快照变换；
// - 三种形态：static 不参与模拟位移；kinematic 每帧把节点对象的世界位姿作为
//   运动学目标（推开展开物，可与动画系统联动）；dynamic 由模拟驱动，回写
//   three 对象变换（不写节点数据，stop 时从快照还原，撤销历史零污染）；
// - 固定步长推进（1/60，最多 4 子步）保证跨帧率行为一致；
// - 后端/重力/开关为场景设置（数据落盘）；模拟启停为运行时控制（不落盘）。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import type { NodeComponentRef } from "../prototype/Node";
import { isColliderComponent, isRigidBodyComponent } from "../prototype/Node";
import { degToRad, type Vec3 } from "../prototype/types";
import {
  DEFAULT_PHYSICS_BACKEND,
  isPhysicsBackendId,
  parseColliderSettings,
  parseRigidBodySettings,
  type ColliderSettings,
  type PhysicsBackendId,
  type PhysicsRuntimeState,
  type RigidBodySettings,
} from "./types";
import { physicsBackendRegistry } from "./backend/factory";
import { computeColliderShapeDesc, terrainMeshSigOf } from "./colliderShape";
import type {
  IPhysicsBody,
  IPhysicsWorld,
  PhysicsQuat,
} from "./backend/types";

/** syncNode 需要的节点形状（避免依赖具体节点类；任意 Node 结构满足） */
export interface PhysicsBodyNode {
  id: string;
  components: NodeComponentRef[];
}

type PhysicsChangeListener = (nodeId: string) => void;

/** 固定模拟步长（秒）与每帧最大子步数 */
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 4;

/** 场景物理设置（引擎侧生效值；落盘由场景 settings.physics 承载） */
export interface PhysicsSceneConfig {
  backend: PhysicsBackendId;
  gravity: Vec3;
  enabled: boolean;
}

interface ColliderEntry {
  id: string;
  settings: ColliderSettings;
}

interface Binding {
  nodeId: string;
  /** 节点的场景对象（位姿来源/回写目标） */
  obj: THREE.Object3D;
  objUuid: string;
  /** 刚体设置（无刚体组件 = null → 隐式静态碰撞体） */
  rb: RigidBodySettings | null;
  /** 碰撞体列表（仅 enabled） */
  colliders: ColliderEntry[];
  /** 数据签名（设置变化 → 重建刚体） */
  sig: string;
  /** 物理世界中的刚体（模拟中非空） */
  body: IPhysicsBody | null;
}

/** 模拟前变换快照（stop 还原；three 对象局部变换） */
interface TransformSnapshot {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

export class PhysicsSystem {
  private bindings = new Map<string, Binding>();
  private listeners = new Set<PhysicsChangeListener>();
  /** 场景物理设置（configure 写入） */
  private config: PhysicsSceneConfig = {
    backend: DEFAULT_PHYSICS_BACKEND,
    gravity: { x: 0, y: -9.81, z: 0 },
    enabled: false,
  };
  /** 物理世界（模拟期间非空；后端切换/停止时销毁） */
  private world: IPhysicsWorld | null = null;
  private worldBackend: PhysicsBackendId | null = null;
  private worldState: "idle" | "loading" | "ready" | "error" = "idle";
  private worldError: string | null = null;
  /** 世界创建任务（防并发重复创建） */
  private worldTask: Promise<void> | null = null;
  /** 模拟状态 */
  private simulating = false;
  private paused = false;
  /** 模拟起点快照（stop 还原） */
  private snapshots = new Map<string, TransformSnapshot>();
  /** 固定步长累加器 */
  private accumulator = 0;

  // —— three 复用对象（避免每帧分配） ——
  private tmpPos = new THREE.Vector3();
  private tmpQuat = new THREE.Quaternion();
  private tmpMat = new THREE.Matrix4();

  onChange(l: PhysicsChangeListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private notify(nodeId: string): void {
    for (const l of this.listeners) l(nodeId);
  }

  private notifyAll(): void {
    for (const id of this.bindings.keys()) this.notify(id);
  }

  /** 场景物理设置（后端/重力/总开关；后端变化时丢弃旧世界，下次模拟用新后端） */
  configure(cfg: Partial<PhysicsSceneConfig>): void {
    const backendChanged = cfg.backend !== undefined && cfg.backend !== this.config.backend;
    if (cfg.backend !== undefined && isPhysicsBackendId(cfg.backend)) this.config.backend = cfg.backend;
    if (cfg.gravity) this.config.gravity = { ...cfg.gravity };
    if (cfg.enabled !== undefined) this.config.enabled = cfg.enabled;
    if (!this.config.enabled && this.simulating) this.stop();
    if (backendChanged) {
      // 旧世界随模拟停止销毁；编辑态丢弃引用即可（下次 play 用新后端重建）
      if (this.simulating) this.stop();
      this.world = null;
      this.worldBackend = null;
      this.worldState = "idle";
      this.worldError = null;
    } else if (this.world && cfg.gravity) {
      this.world.setGravity(this.config.gravity);
    }
    this.notifyAll();
  }

  /** 当前场景物理设置（弹层回显用） */
  getConfig(): PhysicsSceneConfig {
    return { ...this.config, gravity: { ...this.config.gravity } };
  }

  // ===================== 绑定（编辑态数据同步） =====================

  /** 解析节点物理组件并差异应用（引擎在入图/属性变化时调用） */
  syncNode(node: PhysicsBodyNode, obj: THREE.Object3D): void {
    const rbComp = node.components.find(isRigidBodyComponent);
    const rb = rbComp && rbComp.enabled ? parseRigidBodySettings(rbComp.rigidBody) : null;
    const colliders: ColliderEntry[] = node.components
      .filter(isColliderComponent)
      .filter((c) => c.enabled)
      .map((c) => ({ id: c.id, settings: parseColliderSettings(c.collider) }));

    if (!rb && colliders.length === 0) {
      this.unbind(node.id);
      return;
    }
    const sig = this.bindingSig(rb, colliders, obj);
    const existing = this.bindings.get(node.id);
    if (existing && existing.objUuid === obj.uuid) {
      const sigChanged = existing.sig !== sig;
      existing.rb = rb;
      existing.colliders = colliders;
      existing.sig = sig;
      if (this.simulating && this.worldState === "ready" && sigChanged) {
        this.rebuildBody(existing);
      }
      return;
    }
    if (existing) this.unbind(node.id);
    const binding: Binding = {
      nodeId: node.id,
      obj,
      objUuid: obj.uuid,
      rb,
      colliders,
      sig,
      body: null,
    };
    this.bindings.set(node.id, binding);
    // 模拟中途新增节点：世界就绪即补建体
    if (this.simulating && this.worldState === "ready") this.createBindingBody(binding);
    this.notify(node.id);
  }

  /** 数据签名（结构变化 → 重建刚体；含对象缩放，自动尺寸随缩放变化） */
  private bindingSig(rb: RigidBodySettings | null, colliders: ColliderEntry[], obj: THREE.Object3D): string {
    const parts: string[] = [];
    if (rb) {
      parts.push(
        rb.mode,
        rb.mass.toFixed(4),
        rb.linearDamping.toFixed(4),
        rb.angularDamping.toFixed(4),
        rb.gravityScale.toFixed(4),
        String(rb.ccd),
        rb.lockRotation ? "lock" : "",
        rb.upright ? "upright" : "",
      );
    } else {
      parts.push("static-implicit");
    }
    for (const c of colliders) {
      const s = c.settings;
      parts.push(
        c.id,
        s.shape,
        String(s.autoSize),
        s.autoSize ? "" : `${s.size.x.toFixed(3)}|${s.size.y.toFixed(3)}|${s.size.z.toFixed(3)}`,
        `${s.offset.x.toFixed(3)}|${s.offset.y.toFixed(3)}|${s.offset.z.toFixed(3)}`,
        s.friction.toFixed(3),
        s.restitution.toFixed(3),
        String(s.isSensor),
        s.shape === "heightfield" ? String(s.resolution) : "",
      );
    }
    parts.push(`s:${obj.scale.x.toFixed(3)}|${obj.scale.y.toFixed(3)}|${obj.scale.z.toFixed(3)}`);
    // 地形网格内容签名：改地形参数只重建网格不改缩放，混入 sig 才能触发高度场重建
    parts.push(`t:${terrainMeshSigOf(obj)}`);
    return parts.join("§");
  }

  // ===================== 模拟控制（运行时，不落盘） =====================

  /** 开始模拟：快照变换 → 异步就绪世界 → 建体（世界异常时自动回滚） */
  play(): void {
    if (this.simulating) return;
    this.simulating = true;
    this.paused = false;
    this.accumulator = 0;
    this.snapshots.clear();
    for (const b of this.bindings.values()) {
      this.snapshots.set(b.nodeId, {
        position: b.obj.position.clone(),
        quaternion: b.obj.quaternion.clone(),
        scale: b.obj.scale.clone(),
      });
    }
    this.ensureWorld();
    this.notifyAll();
  }

  /** 暂停模拟（世界保留；恢复继续） */
  pause(): void {
    if (!this.simulating || this.paused) return;
    this.paused = true;
    this.notifyAll();
  }

  /** 继续模拟 */
  resume(): void {
    if (!this.simulating || !this.paused) return;
    this.paused = false;
    this.notifyAll();
  }

  /** 停止模拟：销毁世界 → 从快照还原变换 */
  stop(): void {
    if (!this.simulating && this.worldState === "idle") return;
    this.simulating = false;
    this.paused = false;
    this.accumulator = 0;
    this.destroyWorld();
    for (const [nodeId, snap] of this.snapshots) {
      const b = this.bindings.get(nodeId);
      if (!b) continue;
      b.obj.position.copy(snap.position);
      b.obj.quaternion.copy(snap.quaternion);
      b.obj.scale.copy(snap.scale);
      // 数据节点不回写：节点 transform 保持编辑值，撤销历史零污染
    }
    this.snapshots.clear();
    this.notifyAll();
  }

  get isSimulating(): boolean {
    return this.simulating;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** 世界是否就绪（引擎初始化完成且已建体） */
  get isWorldReady(): boolean {
    return this.worldState === "ready";
  }

  /** 惰性创建物理世界（后端工厂动态加载引擎；任务去重；就绪后自动建体） */
  private ensureWorld(): void {
    if (this.worldState === "ready" && this.worldBackend === this.config.backend) {
      for (const b of this.bindings.values()) this.createBindingBody(b);
      return;
    }
    if (this.worldTask) return; // 创建中：完成回调里统一建体
    this.worldState = "loading";
    this.worldError = null;
    const backendId = this.config.backend;
    const def = physicsBackendRegistry.get(backendId);
    if (!def) {
      this.worldState = "error";
      this.worldError = `未知物理后端: ${backendId}`;
      this.simulating = false;
      this.notifyAll();
      return;
    }
    this.worldTask = def
      .create({ gravity: this.config.gravity })
      .then((world) => {
        this.world = world;
        this.worldBackend = backendId;
        this.worldState = "ready";
        if (this.simulating) {
          for (const b of this.bindings.values()) this.createBindingBody(b);
        }
      })
      .catch((e) => {
        this.worldState = "error";
        this.worldError = `物理引擎(${backendId})加载失败: ${String(e)}`;
        console.warn(`[physics] ${this.worldError}`);
        // 引擎不可用：回滚模拟并还原快照
        if (this.simulating) this.stop();
      })
      .finally(() => {
        this.worldTask = null;
        this.notifyAll();
      });
  }

  /** 销毁物理世界（停止/后端切换；引擎模块缓存保留，重建免重复加载） */
  private destroyWorld(): void {
    if (this.world) {
      this.world.dispose();
      this.world = null;
    }
    this.worldBackend = null;
    this.worldState = "idle";
    this.worldError = null;
  }

  /** 世界就绪后为绑定建体（以当前世界位姿为初值） */
  private createBindingBody(binding: Binding): void {
    const world = this.world;
    if (!world) return;
    this.destroyBindingBody(binding);
    if (!binding.rb && binding.colliders.length === 0) return;
    const obj = binding.obj;
    obj.updateWorldMatrix(true, false);
    obj.getWorldPosition(this.tmpPos);
    obj.getWorldQuaternion(this.tmpQuat);
    const rb: RigidBodySettings = binding.rb ?? {
      mode: "static",
      mass: 0,
      linearDamping: 0,
      angularDamping: 0,
      gravityScale: 1,
      ccd: false,
      lockRotation: false,
      upright: false,
    };
    const desc = {
      nodeId: binding.nodeId,
      mode: rb.mode,
      position: { x: this.tmpPos.x, y: this.tmpPos.y, z: this.tmpPos.z },
      quaternion: { x: this.tmpQuat.x, y: this.tmpQuat.y, z: this.tmpQuat.z, w: this.tmpQuat.w },
      colliders: binding.colliders.map((c) => computeColliderShapeDesc(c.settings, obj)),
      mass: rb.mass,
      linearDamping: rb.linearDamping,
      angularDamping: rb.angularDamping,
      gravityScale: rb.gravityScale,
      ccd: rb.ccd,
      lockRotation: rb.lockRotation,
      upright: rb.upright,
    };
    binding.body = desc.colliders.length ? world.createBody(desc) : null;
    this.notify(binding.nodeId);
  }

  /** 重建刚体（设置变化：销毁后按当前位姿重建，速度归零） */
  private rebuildBody(binding: Binding): void {
    this.createBindingBody(binding);
  }

  private destroyBindingBody(binding: Binding): void {
    if (binding.body && this.world) {
      this.world.destroyBody(binding.body);
    }
    binding.body = null;
  }

  // ===================== 每帧推进 =====================

  update(dt: number): void {
    if (!this.simulating || this.paused || this.worldState !== "ready" || !this.world) return;
    // 1) 驱动输入：运动学体跟随节点对象世界位姿（动画/gizmo 先行，物理随后）
    for (const b of this.bindings.values()) {
      if (!b.body || !b.rb || b.rb.mode !== "kinematic") continue;
      b.obj.updateWorldMatrix(true, false);
      b.obj.getWorldPosition(this.tmpPos);
      b.obj.getWorldQuaternion(this.tmpQuat);
      b.body.setKinematicTarget(
        { x: this.tmpPos.x, y: this.tmpPos.y, z: this.tmpPos.z },
        { x: this.tmpQuat.x, y: this.tmpQuat.y, z: this.tmpQuat.z, w: this.tmpQuat.w },
      );
    }
    // 2) 固定步长推进（大帧距截断，避免螺旋追帧）
    this.accumulator += Math.min(dt, FIXED_DT * MAX_SUBSTEPS);
    let stepped = false;
    while (this.accumulator >= FIXED_DT) {
      this.world.step(FIXED_DT);
      this.accumulator -= FIXED_DT;
      stepped = true;
    }
    if (!stepped) return;
    // 3) 回写输出：动力学体 → three 对象局部变换（父逆矩阵换算；不写节点数据）
    for (const b of this.bindings.values()) {
      if (!b.body || !b.rb || b.rb.mode !== "dynamic") continue;
      const t = b.body.readTransform();
      if (!t) continue;
      this.writeWorldTransformToObject(b.obj, t.position, t.quaternion);
    }
  }

  /** 世界位姿 → 对象局部变换（父链矩阵逆换算；scale 不动） */
  private writeWorldTransformToObject(
    obj: THREE.Object3D,
    position: Vec3,
    quaternion: PhysicsQuat,
  ): void {
    const parent = obj.parent;
    this.tmpPos.set(position.x, position.y, position.z);
    this.tmpQuat.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    if (parent) {
      parent.updateWorldMatrix(true, false);
      this.tmpMat.copy(parent.matrixWorld).invert();
      this.tmpPos.applyMatrix4(this.tmpMat);
      const parentQuat = new THREE.Quaternion().setFromRotationMatrix(parent.matrixWorld);
      this.tmpQuat.premultiply(parentQuat.invert());
    }
    obj.position.copy(this.tmpPos);
    obj.quaternion.copy(this.tmpQuat);
  }

  // ===================== 运行时驱动接口（脚本 SDK 用） =====================

  /** 按节点 id 取刚体句柄（脚本 SDK；未绑定/非模拟期返回 null） */
  bodyFor(nodeId: string): IPhysicsBody | null {
    return this.bindings.get(nodeId)?.body ?? null;
  }

  /** 世界重力（脚本 SDK 读取） */
  getGravity(): Vec3 {
    return { ...this.config.gravity };
  }

  /** 运行时状态快照（检查器/弹层展示用） */
  stateFor(nodeId: string): PhysicsRuntimeState | null {
    const b = this.bindings.get(nodeId);
    if (!b) return null;
    return {
      backend: this.worldBackend ?? this.config.backend,
      worldReady: this.worldState === "ready",
      worldLoading: this.worldState === "loading",
      simulating: this.simulating,
      paused: this.paused,
      ready: b.body !== null,
      error: this.worldError,
    };
  }

  /** 节点是否已建立绑定 */
  isBound(nodeId: string): boolean {
    return this.bindings.has(nodeId);
  }

  // ===================== 生命周期 =====================

  /** 解除节点绑定（节点删除/场景替换时调用；模拟中先销毁体） */
  unbind(nodeId: string): void {
    const b = this.bindings.get(nodeId);
    if (!b) return;
    this.destroyBindingBody(b);
    this.bindings.delete(nodeId);
    this.snapshots.delete(nodeId);
  }

  unbindAll(): void {
    if (this.simulating) this.stop();
    for (const b of [...this.bindings.values()]) this.destroyBindingBody(b);
    this.bindings.clear();
    this.snapshots.clear();
  }

  dispose(): void {
    this.stop();
    this.unbindAll();
    this.listeners.clear();
  }
}

/** 度制欧拉 → 四元数（编辑态调试工具；当前绑定直接读对象四元数，保留供脚本层用） */
export function eulerDegToQuat(rotation: { x: number; y: number; z: number }): PhysicsQuat {
  const r = degToRad(rotation);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r.x, r.y, r.z, "XYZ"));
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}
