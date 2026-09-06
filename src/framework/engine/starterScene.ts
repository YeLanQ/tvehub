// ---------------------------------------------------------------------------
// 初始场景：空/损坏场景装载失败时的回退内容。构建完整场景文档（信封 + 嵌套
// 节点树），经后端 scene_load_doc 落入会话（无历史、不落盘），再由前端镜像
// 重建渲染。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import type { NodeFactory } from "../factory/NodeFactory";
import { Node } from "../prototype/Node";
import { CameraNode } from "../prototype/nodes/CameraNode";
import { DirectionalLightNode } from "../prototype/nodes/DirectionalLightNode";
import { vec3, type JsonRecord } from "../prototype/types";
import { createDefaultMetadata, createDefaultSettings } from "../scene/ScenePrototype";

/** 让物体本地 -Z 指向 target，返回欧拉角（度，XYZ 顺序） */
function aimAt(target: THREE.Vector3, pos: THREE.Vector3): [number, number, number] {
  const dir = new THREE.Vector3().subVectors(target, pos).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
  const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
  const R2D = 180 / Math.PI;
  return [e.x * R2D, e.y * R2D, e.z * R2D];
}

/**
 * 构建初始场景文档：一个根 Group 节点 + 一盏环境光 + 一盏方向光 +
 * 一个 Starter Cube + 一台主相机（预览页签一开始就有真实场景相机）。
 */
export function buildStarterSceneDoc(factory: NodeFactory): JsonRecord {
  const root = new Node({ name: "Root" });
  const children: Node[] = [];
  const append = (node: Node): void => {
    node.parentId = root.id;
    root.childIds.push(node.id);
    children.push(node);
  };

  const ambient = factory.createLight("ambient", { parentId: root.id, name: "Ambient" });
  append(ambient);

  const sun = factory.createLight("directional", {
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
  append(sun);

  const cube = factory.createMesh("box", { parentId: root.id, name: "Starter Cube" });
  cube.transform.position = vec3(0, 0.5, 0);
  append(cube);

  const cam = factory.createCamera({ parentId: root.id, name: "Main Camera" }) as CameraNode;
  cam.transform.position = vec3(5, 3.2, 5);
  const camPos = new THREE.Vector3(cam.transform.position.x, cam.transform.position.y, cam.transform.position.z);
  const [cx, cy, cz] = aimAt(new THREE.Vector3(0, 0.6, 0), camPos);
  cam.transform.setRotation(cx, cy, cz);
  append(cam);

  const serialize = (node: Node): JsonRecord => {
    const json = node.toJSON() as JsonRecord;
    json.children = node.childIds
      .map((cid) => children.find((c) => c.id === cid))
      .filter((c): c is Node => !!c)
      .map(serialize);
    return json;
  };

  return {
    type: "scene",
    metadata: createDefaultMetadata("Main") as unknown as JsonRecord,
    settings: createDefaultSettings() as unknown as JsonRecord,
    root: serialize(root),
  };
}
