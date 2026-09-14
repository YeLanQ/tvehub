// ---------------------------------------------------------------------------
// 导航系统（framework 层）：导航区域/代理节点与运行态的绑定同步。
//
// - 区域：注册时按签名（设置 + 地形内容 + 障碍数）判定是否重烘焙；烘焙产物写
//   节点对象的 userData（navBake/navBakeSig），供同步器渲染可视化叠层与检查器
//   读统计——与地形高度场缓存 userData 同套路，不进场景 JSON；
// - 代理：路径与行进状态只存在内存（不序列化）；路径经 requestPath 计算，
//   每帧 update 沿路径推进（贴地形高度 + 朝向移动方向），碰撞用烘焙 SDF 查表
//   滑移（O(1)，不再做实时几何求交）；
// - 位姿回写只写 three 对象（经父逆矩阵换算世界系），不写节点数据——与物理
//   系统同约定，避免每帧产生撤销历史。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { NavAreaNode, NavAgentNode } from "../prototype/nodes";
import {
  bakeNavArea,
  sampleNavHeight,
  sampleNavSdf,
  sampleNavSdfGradient,
  NAV_SURFACE_LIFT,
  type NavBakeResult,
  type NavHeightField,
  type NavObstacle,
} from "./bake";
import { findNavPath, type NavPathPoint } from "./pathfinding";
import {
  navAgentSettingsSig,
  navAreaSettingsSig,
  parseNavAgentSettings,
  parseNavAreaSettings,
  type NavAgentSettings,
  type NavAreaSettings,
} from "./types";

/** 代理当前路径的编辑器可视化注册表（NavAgentHelper 读取画线；仅编辑态） */
export const navAgentPathVisuals = new Map<string, { points: NavPathPoint[]; version: number }>();

let pathVersionCounter = 0;

/** 场景数据提供者（EditorEngine 注入：从图与对象表收集烘焙输入） */
export interface NavSystemProviders {
  /** 区域覆盖范围（世界系 XZ AABB）；null = 场景中没有可采样的地形 */
  boundsFor(area: NavAreaNode, obj: THREE.Object3D): { minX: number; maxX: number; minZ: number; maxZ: number } | null;
  /** 区域采样地形的高度场（含内容签名；签名参与烘焙判定） */
  heightFieldFor(area: NavAreaNode, obj: THREE.Object3D): (NavHeightField & { sig: string }) | null;
  /** 区域范围内的静态障碍列表（世界系） */
  obstaclesFor(area: NavAreaNode, obj: THREE.Object3D): NavObstacle[];
}

interface AreaBinding {
  node: NavAreaNode;
  obj: THREE.Object3D;
  objUuid: string;
  settings: NavAreaSettings;
  sig: string;
  bake: NavBakeResult | null;
}

interface AgentBinding {
  node: NavAgentNode;
  obj: THREE.Object3D;
  objUuid: string;
  settings: NavAgentSettings;
  sig: string;
  /** 当前路径（世界系；null = 空闲） */
  path: NavPathPoint[] | null;
  /** 下一个路径点下标 */
  seg: number;
  /** 上次寻路是否成功（检查器状态展示） */
  lastPathOk: boolean;
}

/** 代理移动状态（update 返回值；检查器/日志展示用） */
export type NavAgentMoveState = "idle" | "moving" | "arrived" | "noArea" | "noPath";

export class NavSystem {
  /** 场景数据提供者（EditorEngine 构造后注入） */
  providers: NavSystemProviders | null = null;
  /** 烘焙产物更新后回调（EditorEngine 接同步器刷新可视化叠层） */
  onBakeUpdated: ((nodeId: string) => void) | null = null;

  private areas = new Map<string, AreaBinding>();
  private agents = new Map<string, AgentBinding>();

  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private tmpM = new THREE.Matrix4();

  // ===================== 区域（绑定 + 烘焙） =====================

  /** 注册/更新导航区域（引擎在入图/属性变化时调用；签名变化即重烘焙） */
  syncArea(node: NavAreaNode, obj: THREE.Object3D): void {
    const settings = parseNavAreaSettings(node.settings);
    const existing = this.areas.get(node.id);
    if (existing && existing.objUuid === obj.uuid) {
      existing.settings = settings;
      existing.node = node;
      this.rebakeIfNeeded(existing);
      return;
    }
    const binding: AreaBinding = {
      node,
      obj,
      objUuid: obj.uuid,
      settings,
      sig: "",
      bake: null,
    };
    this.areas.set(node.id, binding);
    this.rebakeIfNeeded(binding);
  }

  /** 手动重烘焙（检查器按钮；返回烘焙结果） */
  bakeArea(nodeId: string): NavBakeResult | null {
    const binding = this.areas.get(nodeId);
    if (!binding) return null;
    this.rebakeIfNeeded(binding, true);
    return binding.bake;
  }

  getAreaBake(nodeId: string): NavBakeResult | null {
    return this.areas.get(nodeId)?.bake ?? null;
  }

  /** 区域统计（检查器展示；未烘焙返回 null） */
  getAreaStats(nodeId: string): NavBakeResult["stats"] | null {
    return this.areas.get(nodeId)?.bake?.stats ?? null;
  }

  /** 场景中第一个导航区域的 id（代理默认绑定目标） */
  firstAreaId(): string {
    return this.areas.keys().next().value ?? "";
  }

  /** 签名不一致（或强制）→ 重新烘焙并写 userData + 上报刷新 */
  private rebakeIfNeeded(binding: AreaBinding, force = false): void {
    const p = this.providers;
    if (!p) return;
    const hf = p.heightFieldFor(binding.node, binding.obj);
    const bounds = p.boundsFor(binding.node, binding.obj);
    const obstacles = binding.settings.obstaclesMode === "auto"
      ? p.obstaclesFor(binding.node, binding.obj)
      : [];
    const terrainSig = hf?.sig ?? "none";
    const sig = `${navAreaSettingsSig(binding.settings)}#${terrainSig}#${obstacles.length}`;
    if (!force && binding.sig === sig && binding.bake) return;
    binding.sig = sig;
    if (!hf || !bounds) {
      binding.bake = null;
      return;
    }
    binding.bake = bakeNavArea({
      bounds,
      obstacles,
      settings: binding.settings,
      heightAt: (x, z) => heightFieldSample(hf, x, z),
    });
    // 产物挂到节点对象 userData（同步器渲染叠层 / 检查器读统计共用）
    binding.obj.userData.navBake = binding.bake;
    binding.obj.userData.navBakeSig = sig;
    this.onBakeUpdated?.(binding.node.id);
  }

  // ===================== 代理（绑定 + 寻路 + tick） =====================

  /** 注册/更新导航代理（路径保留；设置签名变化时清路径重置状态） */
  syncAgent(node: NavAgentNode, obj: THREE.Object3D): void {
    const settings = parseNavAgentSettings(node.settings);
    const existing = this.agents.get(node.id);
    if (existing && existing.objUuid === obj.uuid) {
      const sigChanged = existing.sig !== navAgentSettingsSig(settings);
      existing.settings = settings;
      existing.node = node;
      existing.sig = navAgentSettingsSig(settings);
      if (sigChanged) this.resetPath(existing);
      return;
    }
    const binding: AgentBinding = {
      node,
      obj,
      objUuid: obj.uuid,
      settings,
      sig: navAgentSettingsSig(settings),
      path: null,
      seg: 0,
      lastPathOk: false,
    };
    this.agents.set(node.id, binding);
  }

  /** 计算到目标点的路径（世界 XZ）；返回是否找到（状态经 lastPathOk 暴露） */
  requestPath(agentNodeId: string, targetX: number, targetZ: number): boolean {
    const agent = this.agents.get(agentNodeId);
    if (!agent) return false;
    const area = this.resolveArea(agent);
    if (!area?.bake) {
      agent.lastPathOk = false;
      return false;
    }
    const pos = agent.obj.getWorldPosition(this.tmpV);
    const res = findNavPath(
      area.bake,
      pos.x,
      pos.z,
      targetX,
      targetZ,
      Math.max(agent.settings.radius, area.settings.agentRadius),
    );
    agent.lastPathOk = res.found;
    agent.path = res.found ? res.points : null;
    agent.seg = 0;
    this.publishPath(agent);
    return res.found;
  }

  clearPath(agentNodeId: string): void {
    const agent = this.agents.get(agentNodeId);
    if (agent) this.resetPath(agent);
  }

  getAgentPath(agentNodeId: string): NavPathPoint[] | null {
    return this.agents.get(agentNodeId)?.path ?? null;
  }

  getAgentState(agentNodeId: string): { moving: boolean; lastPathOk: boolean; hasArea: boolean } {
    const agent = this.agents.get(agentNodeId);
    if (!agent) return { moving: false, lastPathOk: false, hasArea: false };
    return {
      moving: !!agent.path,
      lastPathOk: agent.lastPathOk,
      hasArea: !!this.resolveArea(agent)?.bake,
    };
  }

  unbind(nodeId: string): void {
    this.areas.delete(nodeId);
    const agent = this.agents.get(nodeId);
    if (agent) {
      navAgentPathVisuals.delete(nodeId);
      this.agents.delete(nodeId);
    }
  }

  /** 推进全部代理（编辑器渲染回调调用；路径/碰撞全部查烘焙表） */
  update(dt: number): void {
    if (dt <= 0) return;
    for (const agent of this.agents.values()) {
      if (!agent.path || agent.path.length === 0) continue;
      const area = this.resolveArea(agent);
      if (!area?.bake) continue;
      this.advance(agent, area.bake, dt);
    }
  }

  // —— 私有：移动 ——


  private advance(agent: AgentBinding, bake: NavBakeResult, dt: number): void {
    const obj = agent.obj;
    obj.updateMatrixWorld(true);
    const pos = obj.getWorldPosition(this.tmpV);
    let { x, z } = pos;
    let arrived = false;

    // ① 朝当前路径点推进（XZ 平面）
    let remaining = Math.max(0.001, agent.settings.speed * dt);
    while (remaining > 0 && agent.path) {
      const wp = agent.path[Math.min(agent.seg, agent.path.length - 1)];
      const dx = wp.x - x;
      const dz = wp.z - z;
      const dist = Math.hypot(dx, dz);
      if (dist <= remaining) {
        // 到达该路径点（SDF 滑移后仍落到附近即可）
        x = wp.x;
        z = wp.z;
        remaining -= dist;
        agent.seg++;
        if (agent.seg >= agent.path.length) {
          arrived = true;
          break;
        }
        continue;
      }
      x += (dx / dist) * remaining;
      z += (dz / dist) * remaining;
      remaining = 0;
    }

    // ② SDF 碰撞滑移：距离不足时沿 ∇SDF 推出（查表，无几何求交）
    const clearance = agent.settings.radius;
    const sdf = sampleNavSdf(bake, x, z);
    if (sdf < clearance) {
      const grad = { x: 0, z: 0 };
      sampleNavSdfGradient(bake, x, z, grad);
      const glen = Math.hypot(grad.x, grad.z);
      if (glen > 1e-5) {
        const push = Math.min(clearance - sdf, 1);
        x += (grad.x / glen) * push;
        z += (grad.z / glen) * push;
      }
      // 推出后仍在障碍内（凸角挤压）：回退到最后安全位置
      if (sampleNavSdf(bake, x, z) < clearance * 0.5) {
        const last = agent.path
          ? agent.path[Math.max(0, Math.min(agent.seg - 1, agent.path.length - 1))]
          : null;
        x = last?.x ?? pos.x;
        z = last?.z ?? pos.z;
      }
    }

    // ③ 回写对象位姿（世界系 → 本地：父逆矩阵；Y 贴地形高度；朝向移动方向）
    const y = sampleNavHeight(bake, x, z) + NAV_SURFACE_LIFT;
    const parent = obj.parent;
    if (parent) {
      this.tmpM.copy(parent.matrixWorld).invert();
    } else {
      this.tmpM.identity();
    }
    const local = this.tmpV2.set(x, y, z).applyMatrix4(this.tmpM);
    obj.position.copy(local);
    if (arrived) {
      this.resetPath(agent);
    } else {
      const wp = agent.path ? agent.path[Math.min(agent.seg, agent.path.length - 1)] : null;
      if (wp) {
        const yaw = Math.atan2(wp.x - x, wp.z - z);
        obj.rotation.set(0, yaw, 0);
      }
      this.publishPath(agent);
    }
  }

  /** 代理绑定 → 生效的导航区域（显式绑定优先，回退场景第一个） */
  private resolveArea(agent: AgentBinding): AreaBinding | null {
    if (agent.settings.areaId) {
      const a = this.areas.get(agent.settings.areaId);
      if (a?.bake) return a;
      return null;
    }
    for (const a of this.areas.values()) {
      if (a.bake) return a;
    }
    return null;
  }

  private resetPath(agent: AgentBinding): void {
    agent.path = null;
    agent.seg = 0;
    this.publishPath(agent);
  }

  /** 同步路径到编辑器可视化注册表（helper 画线用） */
  private publishPath(agent: AgentBinding): void {
    if (agent.path && agent.path.length > 0) {
      navAgentPathVisuals.set(agent.node.id, {
        points: agent.path.map((p) => ({ ...p })),
        version: ++pathVersionCounter,
      });
    } else {
      navAgentPathVisuals.delete(agent.node.id);
    }
  }
}

/** 高度场采样：世界 XZ → 绝对 Y；出界返回 null */
function heightFieldSample(hf: NavHeightField, x: number, z: number): number | null {
  const half = hf.size / 2;
  const lx = x - hf.originX;
  const lz = z - hf.originZ;
  if (lx < -half || lx > half || lz < -half || lz > half) return null;
  const segs = hf.gridN - 1;
  const fx = Math.min(segs, Math.max(0, ((lx + half) / hf.size) * segs));
  const fz = Math.min(segs, Math.max(0, ((lz + half) / hf.size) * segs));
  const ix = Math.min(hf.gridN - 2, Math.floor(fx));
  const iz = Math.min(hf.gridN - 2, Math.floor(fz));
  const tx = fx - ix;
  const tz = fz - iz;
  const h = hf.heights;
  const n = hf.gridN;
  const h00 = h[iz * n + ix];
  const h10 = h[iz * n + ix + 1];
  const h01 = h[(iz + 1) * n + ix];
  const h11 = h[(iz + 1) * n + ix + 1];
  const rel =
    (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  return rel + hf.originY;
}
