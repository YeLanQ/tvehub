import * as THREE from "three";
import type { EditorEngine } from "./EditorEngine";
import { Node } from "../prototype/Node";
import { CameraNode } from "../prototype/nodes/CameraNode";
import { DirectionalLightNode } from "../prototype/nodes/DirectionalLightNode";
import { vec3 } from "../prototype/types";

/** 让物体本地 -Z 指向 target，返回欧拉角（度，XYZ 顺序） */
function aimAt(target: THREE.Vector3, pos: THREE.Vector3): [number, number, number] {
  const dir = new THREE.Vector3().subVectors(target, pos).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
  const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
  const R2D = 180 / Math.PI;
  return [e.x * R2D, e.y * R2D, e.z * R2D];
}

/**
 * 搭建初始场景：一个根 Group 节点 + 一盏环境光 + 一盏方向光。
 * 通过工厂派生原型节点，并直接写入场景图（初始态不入历史栈）。
 */
export function setupStarterScene(engine: EditorEngine): void {
  const root = new Node({ name: "Root" });

  engine.graph.setRoot(root);

  const ambient = engine.factory.createLight("ambient", { parentId: root.id, name: "Ambient" });
  engine.graph.add(ambient);

  const sun = engine.factory.createLight("directional", {
    parentId: root.id,
    name: "Directional Light",
  }) as DirectionalLightNode;
  sun.intensity = 2.0;
  sun.castShadow = true;
  sun.transform.position = vec3(6, 10, 6);
  // 平行光方向 = 节点本地 -Z；转动节点让它朝向世界原点，维持原来的光照效果
  const lightPos = new THREE.Vector3(sun.transform.position.x, sun.transform.position.y, sun.transform.position.z);
  const [rx, ry, rz] = aimAt(new THREE.Vector3(0, 0, 0), lightPos);
  sun.transform.setRotation(rx, ry, rz);
  engine.graph.add(sun);

  const cube = engine.factory.createMesh("box", { parentId: root.id, name: "Starter Cube" });
  cube.transform.position = vec3(0, 0.5, 0);
  engine.graph.add(cube);

  // 主相机：让“预览”页签一开始就有真实的场景相机可用
  const cam = engine.factory.createCamera({ parentId: root.id, name: "Main Camera" }) as CameraNode;
  cam.transform.position = vec3(5, 3.2, 5);
  const camPos = new THREE.Vector3(cam.transform.position.x, cam.transform.position.y, cam.transform.position.z);
  const [cx, cy, cz] = aimAt(new THREE.Vector3(0, 0.6, 0), camPos);
  cam.transform.setRotation(cx, cy, cz);
  engine.graph.add(cam);

  engine.rebuildAll();
  engine.select(cube.id);
}