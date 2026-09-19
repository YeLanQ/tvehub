// LOD（Level of Detail）：基于相机距离自动切换网格精度。
// - 节点 components 中 type=lod 组件声明额外层级（distance + geometry/size）
// - 原始网格 = level 0（distance=0，最高精度）
// - 额外层级按 distance 升序添加为 LOD 子级
// - THREE.LOD 在渲染时自动按相机距离切换可见层级（autoUpdate=true）
// - 仅 source=primitive 网格支持 LOD（模型网格跳过）

import * as THREE from "../core/three.module.min.js";
import { num, vec } from "../core/utils";

/** 检查节点是否有 LOD 组件，有则用 THREE.LOD 包装原始网格 */
export function wrapLOD(json: any, obj: THREE.Object3D, ctx: any): THREE.Object3D {
  if (json.source !== "primitive") return obj;
  if (!(obj as any).isMesh) return obj;

  const comps = Array.isArray(json.components) ? json.components : [];
  const lodComp = comps.find(
    (c: any) => c && c.type === "lod" && c.enabled !== false && c.lod && Array.isArray(c.lod.levels) && c.lod.levels.length > 0,
  );
  if (!lodComp) return obj;

  const mesh = obj as THREE.Mesh;
  const mat = mesh.material;
  const levels = lodComp.lod.levels
    .filter((l: any) => l && typeof l.distance === "number" && l.distance > 0)
    .sort((a: any, b: any) => a.distance - b.distance);
  if (levels.length === 0) return obj;

  const lod = new THREE.LOD();
  lod.position.copy(mesh.position);
  lod.rotation.copy(mesh.rotation);
  lod.scale.copy(mesh.scale);
  lod.layers.copy(mesh.layers);
  lod.userData = { ...mesh.userData };
  lod.name = mesh.name;

  mesh.position.set(0, 0, 0);
  mesh.rotation.set(0, 0, 0);
  mesh.scale.set(1, 1, 1);
  lod.addLevel(mesh, 0);

  for (const level of levels) {
    const geom = createLODGeometry(level.geometry || "box", level.size);
    const levelMesh = new THREE.Mesh(geom, mat);
    levelMesh.castShadow = mesh.castShadow;
    levelMesh.receiveShadow = mesh.receiveShadow;
    levelMesh.layers.copy(mesh.layers);
    levelMesh.name = "__lodLevel";
    lod.addLevel(levelMesh, num(level.distance, 0));
  }

  return lod;
}

/** 按种类+尺寸创建基元几何（与 mesh.ts getPrimitiveGeometry 同规则，但不缓存） */
function createLODGeometry(kind: string, size: any): THREE.BufferGeometry {
  const sz = vec(size, { x: 1, y: 1, z: 1 });
  const x = Math.max(0.01, num(sz.x, 1));
  const y = Math.max(0.01, num(sz.y, 1));
  const z = Math.max(0.01, num(sz.z, 1));
  if (kind === "sphere") return new THREE.SphereGeometry(x / 2, 16, 12);
  if (kind === "plane") return new THREE.PlaneGeometry(x, z, 5, 5).rotateX(-Math.PI / 2);
  if (kind === "cylinder") return new THREE.CylinderGeometry(x / 2, x / 2, y, 12);
  if (kind === "cone") return new THREE.ConeGeometry(x / 2, y, 12);
  if (kind === "torus") return new THREE.TorusGeometry(x / 2, y / 2, 8, 24);
  if (kind === "capsule") return new THREE.CapsuleGeometry(x / 2, y, 4, 12);
  return new THREE.BoxGeometry(x, y, z);
}