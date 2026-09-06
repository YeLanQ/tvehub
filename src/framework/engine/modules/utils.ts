import * as THREE from "three";
import type { TransformSnapshot } from "../../scene/SceneClient";
import type { Vec3 } from "../../prototype/types";
import type { LightNode } from "../../prototype/nodes/LightNode";

export function snapshotTransform(node: {
  transform: { position: Vec3; rotation: Vec3; scale: Vec3 };
}): TransformSnapshot {
  return {
    position: { ...node.transform.position },
    rotation: { ...node.transform.rotation },
    scale: { ...node.transform.scale },
  };
}

export function sameTransform(a: TransformSnapshot, b: TransformSnapshot): boolean {
  const EPS = 1e-6;
  return (
    Math.abs(a.position.x - b.position.x) < EPS &&
    Math.abs(a.position.y - b.position.y) < EPS &&
    Math.abs(a.position.z - b.position.z) < EPS &&
    Math.abs(a.rotation.x - b.rotation.x) < EPS &&
    Math.abs(a.rotation.y - b.rotation.y) < EPS &&
    Math.abs(a.rotation.z - b.rotation.z) < EPS &&
    Math.abs(a.scale.x - b.scale.x) < EPS &&
    Math.abs(a.scale.y - b.scale.y) < EPS &&
    Math.abs(a.scale.z - b.scale.z) < EPS
  );
}

export function applySpawnOffset(node: { transform: { setPosition: (x: number, y: number, z: number) => void } }): void {
  const r = () => (Math.random() - 0.5) * 3;
  node.transform.setPosition(r(), 0.5 + Math.random(), r());
}

/**
 * 新添加的灯光节点放置到场景里可观察的位置/方向：
 * - point：放置在原点附近；
 * - directional / spot：放在斜上方并让本地 -Z（光照方向）指向世界原点，
 *   保证一加入就能照亮场景中心物体（聚光灯可见光束效果）。
 * - ambient：无空间语义，保持默认位置。
 */
export function applyLightSpawn(node: LightNode): void {
  if (node.lightKind === "ambient") return;
  const pos =
    node.lightKind === "point" ? new THREE.Vector3(2, 2.5, 2) : new THREE.Vector3(3, 4, 3);
  node.transform.position = { x: pos.x, y: pos.y, z: pos.z };
  if (node.lightKind === "directional" || node.lightKind === "spot") {
    const dir = new THREE.Vector3(0, 0, 0).sub(pos);
    if (dir.lengthSq() < 1e-6) return;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir.normalize());
    const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
    const R2D = 180 / Math.PI;
    node.transform.setRotation(e.x * R2D, e.y * R2D, e.z * R2D);
  }
}

export function findNodeOwner(
  obj: THREE.Object3D,
  map: Map<string, THREE.Object3D>
): string | null {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (cur.userData?.nodeId && map.get(cur.userData.nodeId as string) === cur) {
      return cur.userData.nodeId as string;
    }
    cur = cur.parent;
  }
  return null;
}

export function emissiveMat(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, wireframe: false });
}

/** 子树是否为共享资源（模型实例与缓存模板共享几何/材质，不可释放） */
function isSharedSubtree(o: THREE.Object3D): boolean {
  return (o.userData as { sharedResources?: boolean }).sharedResources === true;
}

export function disposeObject3D(obj: THREE.Object3D): void {
  // 模型实例与缓存模板共享几何/材质（SkeletonUtils.clone 不复制资源）：
  // 标记 sharedResources 的子树整棵跳过，避免销毁模板资源导致其它实例花屏
  if (isSharedSubtree(obj)) return;
  const mesh = obj as THREE.Mesh;
  if (mesh.geometry) mesh.geometry.dispose();
  const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
  if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
  else if (mat) mat.dispose();
  for (const child of [...obj.children]) disposeObject3D(child);
}