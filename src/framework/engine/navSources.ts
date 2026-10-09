// ---------------------------------------------------------------------------
// 导航烘焙输入（NavSystem providers 的引擎侧实现）：
// 采样源解析（地形高度场缓存 / 网格光栅化源）、覆盖范围与合并高度场、
// 静态障碍收集、代理目标读取；全部带签名门控缓存（内容/世界矩阵未变不重算）。
// 缓存容器（navFieldCache/navMeshBoundsCache/navObstacleCache）挂在引擎上，
// 场景重建/模型换入/节点移除时由门面统一清空。
// ---------------------------------------------------------------------------
import * as THREE from "three";
import type { EditorEngine } from "./EditorEngine";
import { MeshNode, NavAgentNode, NavAreaNode, TerrainNode } from "../prototype/derived/Primitives";
import { isRigidBodyComponent } from "../prototype/Node";
import { parseRigidBodySettings } from "../physics";
import {
  mergeHeightFields,
  rasterizeMeshesToHeightField,
  type NavHeightField,
  type NavObstacle,
} from "../navigation";

/** XZ 平面范围（世界系） */
type XZBounds = { minX: number; maxX: number; minZ: number; maxZ: number };

function navXZBoundsOf(min: THREE.Vector3, max: THREE.Vector3): XZBounds {
  return { minX: min.x, maxX: max.x, minZ: min.z, maxZ: max.z };
}

/**
 * 解析导航区域的采样源（settings.sourceIds：地形或网格；空 = 场景第一块地形）。
 * - 地形读现有高度场缓存（SceneSynchronizer.refreshTerrain 写入 chunk mesh
 *   userData，与物理 heightfield 碰撞体同通道）；内容签名取地形组上的
 *   terrainSig（几何/雕刻变化 → 失效）；
 * - 网格源记录对象 + 缓存的 XZ 范围（签名含几何参数与世界矩阵，未变不重算）；
 * - excludeIds 供障碍收集排除采样源（可行走面不是障碍）。
 */
function navSourcesOf(engine: EditorEngine, area: NavAreaNode): {
  terrains: { id: string; field: NavHeightField & { sig: string }; bounds: XZBounds }[];
  meshes: { id: string; obj: THREE.Object3D; bounds: XZBounds | null }[];
  excludeIds: string[];
} {
  const terrains: { id: string; field: NavHeightField & { sig: string }; bounds: XZBounds }[] = [];
  const meshes: { id: string; obj: THREE.Object3D; bounds: XZBounds | null }[] = [];
  const ids = area.settings.sourceIds.length > 0 ? area.settings.sourceIds : [navAutoTerrainId(engine)].filter(Boolean);
  for (const id of ids) {
    const n = engine.graph.get(id);
    if (n instanceof TerrainNode) {
      const t = navTerrainFieldOf(engine, n);
      if (t) terrains.push({ id, field: t.field, bounds: t.bounds });
    } else if (n instanceof MeshNode) {
      const obj = engine.synchronizer.getObjectMap().get(id);
      if (obj) meshes.push({ id, obj, bounds: navMeshSourceBounds(engine, id, n, obj) });
    }
  }
  return { terrains, meshes, excludeIds: ids };
}

/** 自动模式：场景中第一块可见且启用的地形节点 id（无则空串） */
function navAutoTerrainId(engine: EditorEngine): string {
  for (const n of engine.graph.all()) {
    if (n instanceof TerrainNode && n.visible && n.active) return n.id;
  }
  return "";
}

/**
 * 读取地形节点的高度场（XZ 轴对齐假设与物理 heightfield 一致）。内容签名取
 * 地形组 userData.terrainSig（几何 + 雕刻签名；chunk mesh 上未写，旧版从 mesh
 * 读会退化成 gridN 导致雕刻不触发重烘焙，这里直接从组上读）。
 */
function navTerrainFieldOf(
  engine: EditorEngine,
  terrainNode: TerrainNode,
): { field: NavHeightField & { sig: string }; bounds: XZBounds } | null {
  const obj = engine.synchronizer.getObjectMap().get(terrainNode.id);
  if (!obj) return null;

  // 从地形子树读取高度场缓存（chunk 网格 userData）
  let heights: Float32Array | null = null;
  let gridN = 0;
  let size = 0;
  obj.traverse((child) => {
    if (heights) return;
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const ud = mesh.userData as {
      terrainHeights?: unknown;
      terrainGridSize?: unknown;
      terrainSize?: unknown;
    };
    if (
      ud.terrainHeights instanceof Float32Array &&
      typeof ud.terrainGridSize === "number" &&
      typeof ud.terrainSize === "number"
    ) {
      heights = ud.terrainHeights;
      gridN = ud.terrainGridSize;
      size = ud.terrainSize;
    }
  });
  if (!heights) return null;
  const groupSig = (obj.userData as { terrainSig?: unknown }).terrainSig;
  obj.updateMatrixWorld(true);
  const origin = obj.getWorldPosition(new THREE.Vector3());
  // 签名含几何/雕刻内容 + 量化原点（移动地形 → 失效重烘焙）
  const sig = `${typeof groupSig === "string" ? groupSig : String(gridN)}@${origin.x.toFixed(2)},${origin.z.toFixed(2)}`;
  const half = size / 2;
  return {
    field: {
      heights,
      gridN,
      size,
      originX: origin.x,
      originZ: origin.z,
      originY: origin.y,
      sig,
    },
    bounds: {
      minX: origin.x - half,
      maxX: origin.x + half,
      minZ: origin.z - half,
      maxZ: origin.z + half,
    },
  };
}

/** 网格源的世界 XZ 范围（签名门控缓存；Box3 几何遍历只在签名变化时做） */
function navMeshSourceBounds(engine: EditorEngine, id: string, node: MeshNode, obj: THREE.Object3D): XZBounds | null {
  const sig = navMeshSig(node, obj);
  const cached = engine.navMeshBoundsCache.get(id);
  if (cached && cached.sig === sig) return cached.bounds;
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const bounds = box.isEmpty() ? null : navXZBoundsOf(box.min, box.max);
  engine.navMeshBoundsCache.set(id, { sig, bounds });
  return bounds;
}

/** 网格源变更签名：几何相关字段 + 量化世界矩阵（移动/旋转/缩放 → 失效） */
function navMeshSig(node: MeshNode, obj: THREE.Object3D): string {
  const sz = node.size ?? { x: 0, y: 0, z: 0 };
  return `${node.source}|${node.geometry}|${sz.x},${sz.y},${sz.z}|${node.model}@${navMatrixSig(obj)}`;
}

/** 世界矩阵量化签名（2 位小数；亚厘米级变化不触发重烘焙） */
function navMatrixSig(obj: THREE.Object3D): string {
  obj.updateWorldMatrix(false, false);
  const e = obj.matrixWorld.elements;
  let s = "";
  for (let k = 0; k < 16; k++) s += (k ? "," : "") + e[k].toFixed(2);
  return s;
}

/**
 * 区域覆盖范围：单地形走原快速路径（正方形）；多源取并集后扩展为正方形
 * （NavHeightField 为方格约定）。无可采样源返回 null。
 */
export function navBoundsFor(engine: EditorEngine, area: NavAreaNode): XZBounds | null {
  const src = navSourcesOf(engine, area);
  if (src.terrains.length === 0 && src.meshes.length === 0) return null;
  if (src.meshes.length === 0 && src.terrains.length === 1) return src.terrains[0].bounds;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const t of src.terrains) {
    minX = Math.min(minX, t.bounds.minX);
    maxX = Math.max(maxX, t.bounds.maxX);
    minZ = Math.min(minZ, t.bounds.minZ);
    maxZ = Math.max(maxZ, t.bounds.maxZ);
  }
  for (const m of src.meshes) {
    if (!m.bounds) continue;
    minX = Math.min(minX, m.bounds.minX);
    maxX = Math.max(maxX, m.bounds.maxX);
    minZ = Math.min(minZ, m.bounds.minZ);
    maxZ = Math.max(maxZ, m.bounds.maxZ);
  }
  if (!Number.isFinite(minX)) return null;
  // 并集 → 以中心为原点的正方形
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const half = Math.max(maxX - minX, maxZ - minZ) / 2;
  return { minX: cx - half, maxX: cx + half, minZ: cz - half, maxZ: cz + half };
}

/**
 * 区域采样高度场：单地形直接返回地形缓存场（零开销快速路径）；含网格源时
 * 光栅化网格 + 合并地形（每格取最高面），按签名键缓存（源未变不重光栅）。
 * 全场无表面（如模型未加载完）返回 null（与"没有地形"同语义）。
 */
export function navHeightFieldFor(engine: EditorEngine, area: NavAreaNode): (NavHeightField & { sig: string }) | null {
  const src = navSourcesOf(engine, area);
  if (src.terrains.length === 0 && src.meshes.length === 0) return null;
  if (src.meshes.length === 0 && src.terrains.length === 1) return src.terrains[0].field;

  const bounds = navBoundsFor(engine, area);
  if (!bounds) return null;
  const spacing = Math.min(2, Math.max(0.25, area.settings.cellSize / 2));
  const key = [
    src.terrains.map((t) => `${t.id}:${t.field.sig}:${t.field.originX.toFixed(2)},${t.field.originZ.toFixed(2)},${t.field.size}`),
    src.meshes.map((m) => `${m.id}:${navMeshSigOfObj(engine, m.id, m.obj)}`),
    spacing.toFixed(3),
    `${bounds.minX.toFixed(2)},${bounds.maxX.toFixed(2)},${bounds.minZ.toFixed(2)},${bounds.maxZ.toFixed(2)}`,
  ].join("#");
  const cached = engine.navFieldCache.get(area.id);
  if (cached && cached.key === key) return cached.field;

  const raster = rasterizeMeshesToHeightField(
    src.meshes.map((m) => m.obj),
    bounds,
    spacing,
  );
  if (!raster) return null;
  mergeHeightFields(raster, src.terrains.map((t) => t.field));
  let hasSurface = false;
  for (let k = 0; k < raster.heights.length; k++) {
    if (!Number.isNaN(raster.heights[k])) {
      hasSurface = true;
      break;
    }
  }
  if (!hasSurface) return null;
  const field: NavHeightField & { sig: string } = {
    heights: raster.heights,
    gridN: raster.gridN,
    size: raster.size,
    originX: raster.originX,
    originZ: raster.originZ,
    originY: 0,
    sig: key,
  };
  engine.navFieldCache.set(area.id, { key, field });
  return field;
}

/** 网格对象的世界矩阵签名（源解析处未持节点时按缓存签名兜底） */
function navMeshSigOfObj(engine: EditorEngine, id: string, obj: THREE.Object3D): string {
  const n = engine.graph.get(id);
  if (n instanceof MeshNode) return navMeshSig(n, obj);
  return navMatrixSig(obj);
}

/**
 * 收集静态障碍（世界系 AABB）：带启用碰撞体组件、且不挂动态/运动学刚体的
 * 节点（静态体 = 隐式静态或 mode=static 的刚体）；采样源子树排除（高度场是
 * 可行走面，不是障碍），导航节点自身无几何自然为空。候选 + 签名比对后按需
 * 重算 AABB（场景级缓存；障碍移动 → 矩阵签名变化 → 失效）。
 */
export function navObstaclesFor(engine: EditorEngine, area: NavAreaNode): NavObstacle[] {
  const cand: { id: string; obj: THREE.Object3D }[] = [];
  const parts: string[] = [];
  for (const node of engine.graph.all()) {
    if (!node.visible || !node.active) continue;
    if (node instanceof NavAreaNode || node instanceof NavAgentNode) continue;
    const hasCollider = node.components.some((c) => c.type === "collider" && c.enabled);
    if (!hasCollider) continue;
    const rbComp = node.components.find(isRigidBodyComponent);
    if (rbComp && rbComp.enabled && parseRigidBodySettings(rbComp.rigidBody).mode !== "static") {
      continue;
    }
    const obj = engine.synchronizer.getObjectMap().get(node.id);
    if (!obj) continue;
    cand.push({ id: node.id, obj });
    parts.push(`${node.id}@${navMatrixSig(obj)}`);
  }
  const sig = parts.join(";");
  let items: { id: string; box: NavObstacle }[];
  if (engine.navObstacleCache && engine.navObstacleCache.sig === sig) {
    items = engine.navObstacleCache.items;
  } else {
    const box = new THREE.Box3();
    items = [];
    for (const { id, obj } of cand) {
      box.setFromObject(obj);
      if (box.isEmpty()) continue;
      items.push({ id, box: navObstacleOf(box) });
    }
    engine.navObstacleCache = { sig, items };
  }
  const exclude = new Set(navSourcesOf(engine, area).excludeIds);
  return items.filter((it) => !exclude.has(it.id)).map((it) => it.box);
}

function navObstacleOf(box: THREE.Box3): NavObstacle {
  return {
    minX: box.min.x,
    maxX: box.max.x,
    minZ: box.min.z,
    maxZ: box.max.z,
    minY: box.min.y,
    maxY: box.max.y,
  };
}

/** 代理目标节点的世界 XZ（缺失/隐藏/停用 → null；供巡回/最近可达寻路） */
export function navTargetOf(engine: EditorEngine, nodeId: string): { x: number; z: number } | null {
  const n = engine.graph.get(nodeId);
  if (!n || !n.visible || !n.active) return null;
  const obj = engine.synchronizer.getObjectMap().get(nodeId);
  if (!obj) return null;
  obj.updateWorldMatrix(true, false);
  const p = obj.getWorldPosition(new THREE.Vector3());
  return { x: p.x, z: p.z };
}

/**
 * 场景内容变化（网格/地形/障碍/模型加载完成/目标节点移动）→ 全部导航节点
 * 按签名重检：区域重烘焙（未变不重烤）、代理重同步（目标列表/位置变了 →
 * 按移动模式重评估路径；nearest 模式目标移动后由此重新选最近可达）。
 */
export function resyncNavAreas(engine: EditorEngine): void {
  // 世界矩阵刷新：确保签名与烘焙输入读到最新变换（同步器只写本地变换）
  engine.renderer.scene.updateMatrixWorld(true);
  for (const n of engine.graph.all()) {
    if (n instanceof NavAreaNode) {
      const obj = engine.synchronizer.getObjectMap().get(n.id);
      if (obj) engine.nav.syncArea(n, obj);
    } else if (n instanceof NavAgentNode) {
      const obj = engine.synchronizer.getObjectMap().get(n.id);
      if (obj) engine.nav.syncAgent(n, obj);
    }
  }
}
