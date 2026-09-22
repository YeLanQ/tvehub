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
  sampleHeightField,
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
  /** 区域覆盖范围（世界系 XZ AABB）；null = 场景中没有可采样的源 */
  boundsFor(area: NavAreaNode, obj: THREE.Object3D): { minX: number; maxX: number; minZ: number; maxZ: number } | null;
  /** 区域采样源的高度场（含内容签名；签名参与烘焙判定） */
  heightFieldFor(area: NavAreaNode, obj: THREE.Object3D): (NavHeightField & { sig: string }) | null;
  /** 区域范围内的静态障碍列表（世界系） */
  obstaclesFor(area: NavAreaNode, obj: THREE.Object3D): NavObstacle[];
  /** 代理目标节点的世界 XZ（缺失/不可见 → null）；缺省 = 目标功能不可用 */
  targetFor?(nodeId: string): { x: number; z: number } | null;
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
  /** 顺序巡回：当前目标下标（settings.targetIds 内） */
  targetIdx: number;
  /** 目标位置签名（量化坐标；目标节点移动 → 重评估路径） */
  targetSig: string;
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

  /**
   * 任意两点寻路（图追击驱动器用）：选「覆盖起点的已烘焙区域」（否则覆盖终点，
   * 再退第一个已烘焙区域）跑 A* + 视线拉直，返回平滑路径点（世界系，贴地高度）。
   * 无已烘焙区域 / 找不到可达路线 → null（调用方回退直线移动）。
   */
  pathBetween(
    from: { x: number; z: number },
    to: { x: number; z: number },
    agentRadius = 0.5,
  ): NavPathPoint[] | null {
    const bakes = [...this.areas.values()].filter((a) => a.bake);
    if (!bakes.length) return null;
    const covering = (x: number, z: number) =>
      bakes.find((a) => {
        const b = a.bake!.bounds;
        return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
      });
    const area = covering(from.x, from.z) ?? covering(to.x, to.z) ?? bakes[0];
    const res = findNavPath(area.bake!, from.x, from.z, to.x, to.z, agentRadius);
    return res.found ? res.points : null;
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
      heightAt: (x, z) => sampleHeightField(hf, x, z),
    });
    // 产物挂到节点对象 userData（同步器渲染叠层 / 检查器读统计共用）
    binding.obj.userData.navBake = binding.bake;
    binding.obj.userData.navBakeSig = sig;
    this.onBakeUpdated?.(binding.node.id);
  }

  // ===================== 代理（绑定 + 寻路 + tick） =====================

  /** 注册/更新导航代理（路径保留；设置签名或目标位置变化时重置/重评估） */
  syncAgent(node: NavAgentNode, obj: THREE.Object3D): void {
    const settings = parseNavAgentSettings(node.settings);
    const existing = this.agents.get(node.id);
    if (existing && existing.objUuid === obj.uuid) {
      const sigChanged = existing.sig !== navAgentSettingsSig(settings);
      existing.settings = settings;
      existing.node = node;
      existing.sig = navAgentSettingsSig(settings);
      if (sigChanged) {
        existing.targetIdx = 0;
        existing.targetSig = "";
        this.resetPath(existing);
        return;
      }
      // 设置未变但目标节点移动了 → 按移动模式重评估当前路径（nearest 重选
      // 最近可达；sequence 重走到当前目标的新位置）
      if ((existing.path || existing.lastPathOk) && settings.targetIds.length > 0) {
        const tSig = this.targetsSigOf(settings);
        if (tSig !== existing.targetSig) {
          const area = this.resolveArea(existing);
          if (area?.bake) {
            const ok = settings.moveMode === "nearest"
              ? this.repathNearest(existing, area)
              : this.repathSequenceFrom(existing, area, existing.targetIdx);
            if (ok) this.publishPath(existing);
            else this.resetPath(existing);
          }
        }
      }
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
      targetIdx: 0,
      targetSig: "",
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
    const points = this.pathToPoint(agent, area, pos.x, pos.z, targetX, targetZ);
    agent.lastPathOk = points !== null;
    agent.path = points;
    agent.seg = 0;
    this.publishPath(agent);
    return points !== null;
  }

  /**
   * 按设置启动代理移动（检查器「开始移动」/暂停恢复）：sequence = 从 startIdx 起
   * 依次巡回（跳过缺失/不可达的）；nearest = 走向路径最短的可达目标。
   * continueFromCurrent：从当前巡回目标续走（中断恢复），不回到第一个目标重走。
   */
  startAgent(agentNodeId: string, opts?: { continueFromCurrent?: boolean }): boolean {
    const agent = this.agents.get(agentNodeId);
    if (!agent) return false;
    const area = this.resolveArea(agent);
    if (!area?.bake) {
      agent.lastPathOk = false;
      return false;
    }
    const startIdx = opts?.continueFromCurrent ? Math.max(0, agent.targetIdx) : 0;
    const ok = agent.settings.moveMode === "nearest"
      ? this.repathNearest(agent, area)
      : this.repathSequenceFrom(agent, area, startIdx);
    if (ok) this.publishPath(agent);
    else this.resetPath(agent);
    return ok;
  }

  /** 代理当前巡回目标下标（检查器状态展示；nearest = -1） */
  getAgentTargetIndex(agentNodeId: string): number {
    return this.agents.get(agentNodeId)?.targetIdx ?? -1;
  }

  /** 目标节点世界 XZ（provider 缺失/节点不可解析 → null） */
  private targetPosOf(nodeId: string): { x: number; z: number } | null {
    return this.providers?.targetFor?.(nodeId) ?? null;
  }

  /** 目标列表位置签名（量化坐标；目标节点移动 → 值变化） */
  private targetsSigOf(settings: NavAgentSettings): string {
    return settings.targetIds.map((id) => {
      const p = this.targetPosOf(id);
      return p ? `${id}:${p.x.toFixed(2)},${p.z.toFixed(2)}` : `${id}:null`;
    }).join("|");
  }

  /** A* 到单点（半径取代理与区域设置较大者）；不可达 → null */
  private pathToPoint(
    agent: AgentBinding,
    area: AreaBinding,
    fromX: number,
    fromZ: number,
    x: number,
    z: number,
  ): NavPathPoint[] | null {
    if (!area.bake) return null;
    const res = findNavPath(
      area.bake,
      fromX,
      fromZ,
      x,
      z,
      Math.max(agent.settings.radius, area.settings.agentRadius),
    );
    return res.found ? res.points : null;
  }

  /** 顺序巡回：从 startIdx 起依次尝试目标（跳过缺失/不可达），成功设路径与游标 */
  private repathSequenceFrom(agent: AgentBinding, area: AreaBinding, startIdx: number): boolean {
    const ids = agent.settings.targetIds;
    const pos = agent.obj.getWorldPosition(this.tmpV);
    for (let i = Math.max(0, startIdx); i < ids.length; i++) {
      const p = this.targetPosOf(ids[i]);
      if (!p) continue;
      const points = this.pathToPoint(agent, area, pos.x, pos.z, p.x, p.z);
      if (!points) continue;
      agent.path = points;
      agent.seg = 0;
      agent.targetIdx = i;
      agent.targetSig = this.targetsSigOf(agent.settings);
      agent.lastPathOk = true;
      return true;
    }
    agent.lastPathOk = false;
    return false;
  }

  /** 最近可达：对全部目标求路径，取折线最短者（缺失/不可达跳过；全不可达 → false） */
  private repathNearest(agent: AgentBinding, area: AreaBinding): boolean {
    const pos = agent.obj.getWorldPosition(this.tmpV);
    let best: { points: NavPathPoint[]; len: number } | null = null;
    for (const id of agent.settings.targetIds) {
      const p = this.targetPosOf(id);
      if (!p) continue;
      const points = this.pathToPoint(agent, area, pos.x, pos.z, p.x, p.z);
      if (!points) continue;
      let len = 0;
      for (let k = 1; k < points.length; k++) {
        len += Math.hypot(points[k].x - points[k - 1].x, points[k].z - points[k - 1].z);
      }
      if (!best || len < best.len) best = { points, len };
    }
    if (!best) {
      agent.lastPathOk = false;
      return false;
    }
    agent.path = best.points;
    agent.seg = 0;
    agent.targetIdx = -1;
    agent.targetSig = this.targetsSigOf(agent.settings);
    agent.lastPathOk = true;
    return true;
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

  /** 解除全部绑定（场景整体重建/切换：绑定持有旧场景对象，必须整体重绑） */
  unbindAll(): void {
    this.areas.clear();
    this.agents.clear();
    navAgentPathVisuals.clear();
  }

  /** 推进全部代理（编辑器渲染回调调用；路径/碰撞全部查烘焙表） */
  update(dt: number): void {
    if (dt <= 0) return;
    for (const agent of this.agents.values()) {
      if (!agent.path || agent.path.length === 0) continue;
      const area = this.resolveArea(agent);
      if (!area?.bake) continue;
      this.advance(agent, area, dt);
    }
  }

  // —— 私有：移动 ——


  private advance(agent: AgentBinding, area: AreaBinding, dt: number): void {
    const bake = area.bake;
    if (!bake) return;
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
      // 顺序巡回：接力下一个目标（loop 循环）；非巡回/走完 → 停下清路径
      if (!this.advanceSequence(agent, area)) {
        this.resetPath(agent);
      } else {
        this.publishPath(agent);
      }
    } else {
      const wp = agent.path ? agent.path[Math.min(agent.seg, agent.path.length - 1)] : null;
      if (wp) {
        const yaw = Math.atan2(wp.x - x, wp.z - z);
        obj.rotation.set(0, yaw, 0);
      }
      this.publishPath(agent);
    }
  }

  /** 到达目标后的顺序接力：取下一目标寻路（loop 循环；非 sequence/无下一目标 → false） */
  private advanceSequence(agent: AgentBinding, area: AreaBinding): boolean {
    if (agent.settings.moveMode !== "sequence") return false;
    const ids = agent.settings.targetIds;
    if (ids.length === 0) return false;
    let next = agent.targetIdx + 1;
    if (next >= ids.length) {
      if (!agent.settings.loop || ids.length === 1) return false;
      next = 0;
    }
    return this.repathSequenceFrom(agent, area, next);
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

