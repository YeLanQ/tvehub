// ---------------------------------------------------------------------------
// 导航运行时（预览/构建）：把编辑器 NavSystem（烘焙/寻路/避障/巡回）接入
// 网页预览与构建产物 —— 与编辑器视口同一套 framework/navigation 实现。
//
// 数据来源：player 传入的场景节点表（json + obj）——
// - navAreaNode：烘焙区域（settings.sourceIds 或自动第一块地形的高度场 +
//   静态碰撞体障碍 → 可行走网格 + SDF 距离场）；
// - navAgentNode：代理（targetIds 巡回目标 / moveMode / loop / speed / radius）；
// - 路径点位置取目标节点世界 XZ；障碍 = 启用碰撞体且非动态刚体的节点 AABB。
//
// 每帧：场景世界矩阵刷新 → NavSystem.update(dt) 沿路径推进代理（SDF 滑移避障）。
// setAgentPaused：图行为（op.chase 追击态）可暂停代理巡回，恢复后自动重寻路。
// ---------------------------------------------------------------------------
import * as THREE from "three";
import { NavSystem } from "../../framework/navigation/NavSystem";
import { sampleHeightField, type NavHeightField, type NavObstacle } from "../../framework/navigation/bake";
import { mergeHeightFields, rasterizeMeshesToHeightField } from "../../framework/navigation/meshField";
import {
  navAreaSettingsSig,
  parseNavAgentSettings,
  parseNavAreaSettings,
  type NavAreaSettings,
} from "../../framework/navigation/types";

export interface NavRuntimeNode {
  json: Record<string, unknown>;
  obj: THREE.Object3D;
}

export interface NavRuntimeCtx {
  scene: THREE.Scene;
  /** 场景节点表（json + 已构建的 Object3D；player 的 nodes 数组） */
  nodes: NavRuntimeNode[];
  /** 诊断日志回调（player 传 postLog；缺省 console.warn） */
  onLog?: (msg: string) => void;
}

interface Vec3Like { x: number; y: number; z: number }
interface XZBounds { minX: number; maxX: number; minZ: number; maxZ: number }

export function createNavRuntime(ctx: NavRuntimeCtx) {
  const nav = new NavSystem();
  const nodes = ctx.nodes;
  const jsonById = new Map<string, NavRuntimeNode>();
  for (const n of nodes) {
    const id = typeof n.json.id === "string" ? n.json.id : "";
    if (id) jsonById.set(id, n);
  }

  const worldPos = (obj: THREE.Object3D): Vec3Like => {
    obj.updateWorldMatrix(true, false);
    const p = new THREE.Vector3();
    obj.getWorldPosition(p);
    return { x: p.x, y: p.y, z: p.z };
  };

  // ----- 烘焙输入：采样源解析（sourceIds 或自动第一块地形） -----
  function sourcesOf(areaSettings: NavAreaSettings): NavRuntimeNode[] {
    const ids = areaSettings.sourceIds.length > 0 ? areaSettings.sourceIds : [];
    if (ids.length) {
      const list = ids.map((id) => jsonById.get(id)).filter((n): n is NavRuntimeNode => !!n);
      if (list.length) return list;
    }
    for (const n of nodes) {
      if (n.json.type === "terrainNode" && n.json.active !== false && n.json.visible !== false) return [n];
    }
    return [];
  }

  /** 地形源高度场：读 chunk mesh userData 缓存（与编辑器同一通道） */
  function terrainFieldOf(entry: NavRuntimeNode): (NavHeightField & { sig: string }) & { bounds: XZBounds } | null {
    let heights: Float32Array | null = null;
    let gridN = 0;
    let size = 0;
    entry.obj.traverse((child) => {
      if (heights) return;
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const ud = mesh.userData as { terrainHeights?: unknown; terrainGridSize?: unknown; terrainSize?: unknown };
      if (ud.terrainHeights instanceof Float32Array && typeof ud.terrainGridSize === "number" && typeof ud.terrainSize === "number") {
        heights = ud.terrainHeights;
        gridN = ud.terrainGridSize;
        size = ud.terrainSize;
      }
    });
    if (!heights) return null;
    const origin = worldPos(entry.obj);
    const half = size / 2;
    return {
      heights,
      gridN,
      size,
      originX: origin.x,
      originZ: origin.z,
      originY: 0,
      sig: `${gridN}@${origin.x.toFixed(2)},${origin.z.toFixed(2)}`,
      bounds: { minX: origin.x - half, maxX: origin.x + half, minZ: origin.z - half, maxZ: origin.z + half },
    } as NavHeightField & { sig: string } & { bounds: XZBounds };
  }

  /** 网格源 XZ 范围（Box3 遍历） */
  function meshBoundsOf(entry: NavRuntimeNode): XZBounds | null {
    entry.obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(entry.obj);
    return box.isEmpty() ? null : { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z };
  }

  /** 区域覆盖范围：单源走快速路径；多源取并集后扩展为正方形 */
  function boundsFor(entry: NavRuntimeNode, settings: NavAreaSettings): XZBounds | null {
    const src = sourcesOf(settings);
    if (!src.length) return null;
    const bounds = src.map((s) => (s.json.type === "terrainNode" ? terrainFieldOf(s)?.bounds ?? meshBoundsOf(s) : meshBoundsOf(s)));
    const ok = bounds.filter((b): b is XZBounds => !!b);
    if (!ok.length) return null;
    if (ok.length === 1) return ok[0];
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const b of ok) {
      minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX);
      minZ = Math.min(minZ, b.minZ); maxZ = Math.max(maxZ, b.maxZ);
    }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const half = Math.max(maxX - minX, maxZ - minZ) / 2;
    return { minX: cx - half, maxX: cx + half, minZ: cz - half, maxZ: cz + half };
  }

  /** 区域采样高度场：单地形直读缓存；多源光栅化网格后与地形合并 */
  function heightFieldFor(entry: NavRuntimeNode, settings: NavAreaSettings): (NavHeightField & { sig: string }) | null {
    const src = sourcesOf(settings);
    const terrains = src.filter((s) => s.json.type === "terrainNode");
    const meshes = src.filter((s) => s.json.type !== "terrainNode");
    if (!terrains.length && !meshes.length) return null;
    if (!meshes.length && terrains.length === 1) {
      const f = terrainFieldOf(terrains[0]);
      return f ? { heights: f.heights, gridN: f.gridN, size: f.size, originX: f.originX, originZ: f.originZ, originY: 0, sig: f.sig } : null;
    }
    const bounds = boundsFor(entry, settings);
    if (!bounds) return null;
    const spacing = Math.min(2, Math.max(0.25, settings.cellSize / 2));
    const raster = rasterizeMeshesToHeightField(meshes.map((m) => m.obj), bounds, spacing);
    if (!raster) return null;
    mergeHeightFields(raster, terrains.map((t) => {
      const f = terrainFieldOf(t);
      return { heights: f ? f.heights : new Float32Array(), gridN: f ? f.gridN : 0, size: f ? f.size : 0, originX: f ? f.originX : 0, originZ: f ? f.originZ : 0, originY: 0, sig: f ? f.sig : "" } as NavHeightField;
    }));
    let hasSurface = false;
    for (let k = 0; k < raster.heights.length; k++) {
      if (!Number.isNaN(raster.heights[k])) { hasSurface = true; break; }
    }
    if (!hasSurface) return null;
    return { heights: raster.heights, gridN: raster.gridN, size: raster.size, originX: raster.originX, originZ: raster.originZ, originY: 0, sig: `raster@${bounds.minX.toFixed(1)},${bounds.minZ.toFixed(1)},${spacing.toFixed(2)}` };
  }

  /** 静态障碍：启用碰撞体且非动态刚体的节点 AABB（排除采样源） */
  function obstaclesFor(entry: NavRuntimeNode, settings: NavAreaSettings): NavObstacle[] {
    const exclude = new Set(settings.sourceIds.length > 0 ? settings.sourceIds : []);
    for (const s of sourcesOf(settings)) exclude.add(s.json.id as string);
    const out: NavObstacle[] = [];
    for (const n of nodes) {
      const json = n.json;
      if (json.type === "navAreaNode" || json.type === "navAgentNode") continue;
      if (json.active === false || json.visible === false) continue;
      const comps = Array.isArray(json.components) ? (json.components as Record<string, unknown>[]) : [];
      const hasCollider = comps.some((c) => c && c.type === "collider" && c.enabled !== false);
      if (!hasCollider) continue;
      const rb = comps.find((c) => c && c.type === "rigidBody") as Record<string, unknown> | undefined;
      if (rb && rb.enabled !== false) {
        const body = (rb.rigidBody ?? {}) as Record<string, unknown>;
        if (typeof body.mode === "string" && body.mode !== "static") continue;
      }
      n.obj.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(n.obj);
      if (box.isEmpty()) continue;
      out.push({ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z, minY: box.min.y, maxY: box.max.y });
    }
    return out;
  }

  // ----- providers 装配 -----
  nav.providers = {
    boundsFor: (area) => {
      const entry = jsonById.get(area.id);
      return entry ? boundsFor(entry, parseNavAreaSettings(entry.json.settings)) : null;
    },
    heightFieldFor: (area) => {
      const entry = jsonById.get(area.id);
      return entry ? heightFieldFor(entry, parseNavAreaSettings(entry.json.settings)) : null;
    },
    obstaclesFor: (area) => {
      const entry = jsonById.get(area.id);
      if (!entry) return [];
      return obstaclesFor(entry, parseNavAreaSettings(entry.json.settings));
    },
    targetFor: (nodeId) => {
      const entry = jsonById.get(nodeId);
      if (!entry || entry.json.active === false || entry.json.visible === false) return null;
      const p = worldPos(entry.obj);
      return { x: p.x, z: p.z };
    },
  };

  // ----- 同步区域与代理（autoStart 的代理自动开始巡回） -----
  // NavSystem 只需要 { id, settings }——传轻量 stub，避免构造节点类实例
  // （json.transform 是普通对象，直接当 init 会崩）
  for (const n of nodes) {
    const nodeId = typeof n.json.id === "string" ? n.json.id : "";
    if (!nodeId) continue;
    if (n.json.type === "navAreaNode") {
      const areaSettings = parseNavAreaSettings(n.json.settings);
      nav.syncArea({ id: nodeId, settings: areaSettings } as unknown as NavAreaNode, n.obj);
      const stats = nav.getAreaStats(nodeId);
      ctx.onLog?.(
        `[nav] 区域 ${nodeId} 烘焙: ${stats ? `${stats.cells} 格 / 可行走 ${stats.walkableCells}（占比 ${stats.walkableRatio.toFixed(2)}）` : "失败（无采样源或高度场缺失）"}`,
      );
    } else if (n.json.type === "navAgentNode") {
      const agentSettings = parseNavAgentSettings(n.json.settings);
      nav.syncAgent({ id: nodeId, settings: agentSettings } as unknown as NavAgentNode, n.obj);
      const s = (n.json.settings ?? {}) as Record<string, unknown>;
      if (s.autoStart !== false) {
        const ok = nav.startAgent(nodeId);
        ctx.onLog?.(
          `[nav] 代理 ${nodeId} startAgent=${ok}（targets=${agentSettings.targetIds.length}，speed=${agentSettings.speed}）`,
        );
      }
    }
  }

  /** 被图追击驱动器暂停的代理（暂停 = 清路径停移动；恢复 = 重新寻路巡回） */
  const pausedAgents = new Set<string>();

  return {
    /** 每帧推进：刷新世界矩阵后沿路径移动代理 */
    update(dt: number) {
      if (dt <= 0) return;
      ctx.scene.updateMatrixWorld(true);
      nav.update(dt);
    },
    /** 暂停/恢复代理巡回（图追击驱动器用；仅在状态变化时触达 NavSystem） */
    setAgentPaused(nodeId: string, paused: boolean): void {
      const was = pausedAgents.has(nodeId);
      if (paused && !was) {
        pausedAgents.add(nodeId);
        nav.clearPath(nodeId);
      } else if (!paused && was) {
        pausedAgents.delete(nodeId);
        nav.startAgent(nodeId);
      }
    },
    /** 图追击驱动器寻路：任意两点的烘焙网格 A* 平滑路径（无可达路线/未烘焙 → null，驱动器回退直线） */
    pathBetween(from: { x: number; z: number }, to: { x: number; z: number }) {
      return nav.pathBetween(from, to);
    },
    dispose() {
      nav.unbindAll();
    },
  };
}
