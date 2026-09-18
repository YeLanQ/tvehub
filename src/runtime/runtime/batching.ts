// 场景批处理优化：InstancedMesh + 静态几何合并，减少 DrawCall。
// - InstancedMesh：相同 (geometry, material, layer) 的静态网格 → 1 个 InstancedMesh
// - 静态合并：同材质不同几何的静态网格 → mergeGeometries 合并为单个 Mesh
// - 仅处理 source=primitive 且无动画/脚本/物理/描边/透明的静态网格
// - 原始网格 visible=false 保留在树中（脚本仍可寻址），优化网格挂场景根

import * as THREE from "../core/three.module.min.js";
import { postLog } from "../core/log";

interface MeshEntry {
  json: any;
  obj: THREE.Object3D;
}

interface ClipEntry {
  nodeId: string;
}

interface OptimizeOptions {
  instancing?: boolean;
  batching?: boolean;
  /**
   * 排除节点 id（合并/实例化会把原网格置 visible=false，渲染的是副本）：
   * 脚本图引用到的实体必须保持原对象可见且未被烘焙——图在运行期移动的是
   * 树中的原对象，被批处理吞掉后位姿变化没有任何视觉表现。
   * player 经 graphReferencedEntityIds(graphDoc, nodes) 预计算传入。
   */
  excludeNodeIds?: Iterable<string>;
}

/** 场景批处理优化入口 */
export function optimizeScene(
  scene: THREE.Scene,
  meshes: MeshEntry[],
  clips: ClipEntry[],
  options?: OptimizeOptions,
): void {
  const opts = {
    instancing: options?.instancing !== false,
    batching: options?.batching !== false,
  };

  // 烘焙前先刷新整棵树的世界矩阵：副本按 matrixWorld 烘到场景根，而 player 在
  // 批处理时尚未推进过矩阵（首帧渲染/configureShadows 都在其后），单节点
  // updateMatrixWorld 只会拿父链上还是恒等的 matrixWorld 相乘，祖先变换全丢——
  // 父节点带位移的网格会被烘到错误位置（原网格已隐藏 → 视觉上整组消失）。
  scene.updateMatrixWorld(true);

  const animatedNodeIds = new Set<string>();
  for (const c of clips) if (c.nodeId) animatedNodeIds.add(c.nodeId);

  const excludeNodeIds = options?.excludeNodeIds ? new Set(options.excludeNodeIds) : undefined;

  const staticMeshes: THREE.Mesh[] = [];
  for (const { json, obj } of meshes) {
    if (!isStaticMesh(json, obj, animatedNodeIds, excludeNodeIds)) continue;
    staticMeshes.push(obj as THREE.Mesh);
  }
  if (staticMeshes.length < 2) return;

  let instanced = 0;
  let merged = 0;
  let remaining = staticMeshes;

  if (opts.instancing) {
    const result = buildInstancedMeshes(scene, staticMeshes);
    instanced = result.instancedCount;
    remaining = result.remaining;
  }

  if (opts.batching && remaining.length > 1) {
    merged = mergeStaticGeometries(scene, remaining);
  }

  if (instanced > 0 || merged > 0) {
    postLog("info", `[批处理] InstancedMesh ${instanced} 组，几何合并 ${merged} 组，优化 ${instanced + merged} 个 DrawCall`);
  }
}

/** 判断是否为可批处理的静态网格 */
function isStaticMesh(
  json: any,
  obj: THREE.Object3D,
  animatedNodeIds: Set<string>,
  excludeNodeIds?: Set<string>,
): boolean {
  if (json.source !== "primitive") return false;
  if (!(obj as any).isMesh) return false;
  const nodeId = obj.userData.nodeId;
  if (nodeId && animatedNodeIds.has(nodeId)) return false;
  // 场景图引用实体：运行期位姿由脚本图驱动，不可烘焙（烘焙=原对象隐藏）
  if (nodeId && excludeNodeIds?.has(nodeId)) return false;
  if (obj.children.length > 0) return false;
  const comps = Array.isArray(json.components) ? json.components : [];
  for (const c of comps) {
    if (!c || c.enabled === false) continue;
    if (c.type === "script" || c.type === "rigidBody" || c.type === "collider") return false;
  }
  const mat = (obj as THREE.Mesh).material as THREE.Material;
  if (mat && mat.transparent) return false;
  if (mat && (mat as any).wireframe) return false;
  return true;
}

/** 按 (geometry, material, layer) 分组创建 InstancedMesh */
function buildInstancedMeshes(
  scene: THREE.Scene,
  meshes: THREE.Mesh[],
): { remaining: THREE.Mesh[]; instancedCount: number } {
  const groups = new Map<string, THREE.Mesh[]>();
  for (const mesh of meshes) {
    const key = getInstancingKey(mesh);
    if (!key) continue;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(mesh);
  }

  const remaining: THREE.Mesh[] = [];
  let instancedCount = 0;
  const matrix = new THREE.Matrix4();

  for (const [, group] of groups) {
    if (group.length < 2) {
      remaining.push(...group);
      continue;
    }
    const template = group[0];
    const geom = template.geometry;
    const mat = template.material;
    const layer = template.userData.nodeLayer || 0;

    const inst = new THREE.InstancedMesh(geom, mat, group.length);
    inst.castShadow = template.castShadow;
    inst.receiveShadow = template.receiveShadow;
    inst.layers.set(layer);
    inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    inst.name = "__batchedInstances";

    for (let i = 0; i < group.length; i++) {
      group[i].updateMatrixWorld();
      inst.setMatrixAt(i, group[i].matrixWorld);
      group[i].visible = false;
      group[i].castShadow = false;
    }
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
    instancedCount++;
  }

  return { remaining, instancedCount };
}

/** 实例化分组 key：geometry+material+layer 对象身份 */
function getInstancingKey(mesh: THREE.Mesh): string | null {
  const geom = mesh.geometry;
  const mat = mesh.material;
  if (!geom || !mat) return null;
  const layer = mesh.userData.nodeLayer || 0;
  return `${geom.id}|${mat.id}|${layer}`;
}

/** 按材质分组合并几何体 */
function mergeStaticGeometries(scene: THREE.Scene, meshes: THREE.Mesh[]): number {
  const byMaterial = new Map<number, THREE.Mesh[]>();
  for (const mesh of meshes) {
    const mat = mesh.material as THREE.Material;
    let group = byMaterial.get(mat.id);
    if (!group) {
      group = [];
      byMaterial.set(mat.id, group);
    }
    group.push(mesh);
  }

  let mergedCount = 0;

  for (const [, group] of byMaterial) {
    if (group.length < 2) continue;
    const template = group[0];
    const mat = template.material;
    const layer = template.userData.nodeLayer || 0;

    const geometries: THREE.BufferGeometry[] = [];
    for (const mesh of group) {
      mesh.updateMatrixWorld();
      const clone = mesh.geometry.clone();
      clone.applyMatrix4(mesh.matrixWorld);
      geometries.push(clone);
    }

    const merged = mergeGeometries(geometries);
    if (!merged) continue;

    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = template.castShadow;
    mesh.receiveShadow = template.receiveShadow;
    mesh.layers.set(layer);
    mesh.name = "__batchedMerge";
    scene.add(mesh);

    for (const original of group) {
      original.visible = false;
      original.castShadow = false;
    }
    mergedCount++;
  }

  return mergedCount;
}

/** 合并多个 BufferGeometry（position + normal + uv + index） */
function mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!geometries.length) return null;

  let posCount = 0;
  let idxCount = 0;
  for (const g of geometries) {
    const pos = g.attributes.position;
    if (!pos) return null;
    posCount += pos.count;
    if (g.index) idxCount += g.index.count;
  }

  const positions = new Float32Array(posCount * 3);
  const hasNormals = geometries.every((g) => g.attributes.normal);
  const normals = hasNormals ? new Float32Array(posCount * 3) : null;
  const hasUVs = geometries.every((g) => g.attributes.uv);
  const uvs = hasUVs ? new Float32Array(posCount * 2) : null;
  const indices = idxCount > 0 ? new Uint32Array(idxCount) : null;

  let posOff = 0;
  let normOff = 0;
  let uvOff = 0;
  let idxOff = 0;
  let vertOff = 0;

  for (const g of geometries) {
    const pos = g.attributes.position;
    positions.set(pos.array as Float32Array, posOff);
    posOff += pos.count * 3;

    if (normals && g.attributes.normal) {
      const norm = g.attributes.normal;
      normals.set(norm.array as Float32Array, normOff);
      normOff += norm.count * 3;
    }
    if (uvs && g.attributes.uv) {
      const uv = g.attributes.uv;
      uvs.set(uv.array as Float32Array, uvOff);
      uvOff += uv.count * 2;
    }
    if (indices && g.index) {
      const idx = g.index;
      const arr = idx.array;
      for (let i = 0; i < idx.count; i++) {
        indices[idxOff + i] = arr[i] + vertOff;
      }
      idxOff += idx.count;
    }
    vertOff += pos.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (normals) merged.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  if (uvs) merged.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  if (indices) merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeBoundingSphere();
  return merged;
}