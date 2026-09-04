import * as THREE from "three";
import type { TransformSnapshot } from "../../command/commands";
import type { Vec3 } from "../../prototype/types";
import type { GeometryKind } from "../../prototype/nodes/MeshNode";

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

export function buildGeometry(kind: GeometryKind, size: Vec3): THREE.BufferGeometry {
  const x = Math.max(0.01, size.x);
  const y = Math.max(0.01, size.y);
  const z = Math.max(0.01, size.z);
  switch (kind) {
    case "sphere":
      return new THREE.SphereGeometry(x / 2, 32, 24);
    case "plane":
      return new THREE.PlaneGeometry(x, z);
    case "cylinder":
      return new THREE.CylinderGeometry(x / 2, x / 2, y, 24);
    default:
      return new THREE.BoxGeometry(x, y, z);
  }
}

export function emissiveMat(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, wireframe: false });
}

export function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) mat.dispose();
  });
}