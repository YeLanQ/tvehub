import * as THREE from "three";
import type { Node } from "../../prototype/Node";
import type { SceneGraph, SceneChange } from "../scene/SceneGraph";
import {
  MeshNode,
  LightNode,
  CameraNode,
} from "../../prototype/derived/Primitives";
import type { GeometryKind } from "../../prototype/nodes/MeshNode";
import type { Vec3 } from "../../prototype/types";
import { disposeObject3D, buildGeometry, findNodeOwner } from "./utils";

export class SceneSynchronizer {
  private objectMap = new Map<string, THREE.Object3D>();
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  getObjectMap(): Map<string, THREE.Object3D> {
    return this.objectMap;
  }

  rebuildAll(graph: SceneGraph): void {
    this.objectMap.forEach((o) => {
      o.parent?.remove(o);
      disposeObject3D(o);
    });
    this.objectMap.clear();
    graph.all().forEach((n) => this.createObjectOnly(n));
    graph.all().forEach((n) => this.attachParent(n));
    graph.all().forEach((n) => this.refreshNode(n));
  }

  onGraphChange(c: SceneChange, graph: SceneGraph): void {
    const node = graph.get(c.nodeId);
    switch (c.kind) {
      case "add":
        if (node) this.syncRecursively(node, graph);
        break;
      case "remove":
        this.disposeMapped(c.nodeId, graph);
        break;
      case "reparent":
        if (node) this.remount(node);
        break;
      case "transform":
        if (node) this.applyTransform(node);
        break;
      case "rename":
        if (node) this.renameObject(node);
        break;
      case "properties":
        if (node) this.refreshNode(node);
        break;
    }
  }

  private createObjectOnly(node: Node): THREE.Object3D {
    let obj: THREE.Object3D;
    if (node instanceof MeshNode) obj = new THREE.Mesh();
    else if (node instanceof LightNode) obj = new THREE.Group();
    else if (node instanceof CameraNode) obj = new THREE.Group();
    else obj = new THREE.Group();
    obj.name = node.name;
    obj.userData.nodeId = node.id;
    obj.userData.nodeKind = node.typeKey;
    this.objectMap.set(node.id, obj);
    return obj;
  }

  private ensureObject(node: Node): void {
    if (!this.objectMap.has(node.id)) this.createObjectOnly(node);
  }

  private syncRecursively(node: Node, graph: SceneGraph): void {
    this.ensureObject(node);
    this.attachParent(node);
    node.childIds.forEach((cid) => {
      const child = graph.get(cid);
      if (child) this.syncRecursively(child, graph);
    });
    this.refreshNode(node);
  }

  private attachParent(node: Node): void {
    const obj = this.objectMap.get(node.id);
    if (!obj) return;
    const newParent = node.parentId ? this.objectMap.get(node.parentId) : undefined;
    const host = newParent ?? this.scene;
    if (obj.parent !== host) host.add(obj);
  }

  private disposeMapped(id: string, graph: SceneGraph): void {
    const subIds = collectSubtree(graph, id);
    subIds.forEach((sid) => {
      const obj = this.objectMap.get(sid);
      if (obj) {
        obj.parent?.remove(obj);
        disposeObject3D(obj);
        this.objectMap.delete(sid);
      }
    });
  }

  private remount(node: Node): void {
    this.attachParent(node);
    this.renameObject(node);
  }

  private renameObject(node: Node): void {
    const obj = this.objectMap.get(node.id);
    if (obj) obj.name = node.name;
  }

  applyTransform(node: Node): void {
    const obj = this.objectMap.get(node.id);
    if (!obj) return;
    obj.position.set(node.transform.position.x, node.transform.position.y, node.transform.position.z);
    obj.rotation.set(node.transform.rotation.x, node.transform.rotation.y, node.transform.rotation.z);
    obj.scale.set(node.transform.scale.x, node.transform.scale.y, node.transform.scale.z);
  }

  private refreshNode(node: Node): void {
    const obj = this.objectMap.get(node.id);
    if (!obj) return;
    obj.visible = node.visible && node.active;
    if (node instanceof MeshNode) this.refreshMesh(node, obj as THREE.Mesh);
    else if (node instanceof LightNode) this.refreshLight(node, obj);
    else if (node instanceof CameraNode) this.refreshCamera(node, obj);
    this.applyTransform(node);
  }

  private refreshMesh(mesh: MeshNode, obj: THREE.Mesh): void {
    const geom = buildGeometry(mesh.geometry, mesh.size);
    obj.geometry.dispose();
    obj.geometry = geom;
    let mat = obj.material as THREE.MeshStandardMaterial;
    if (!(mat instanceof THREE.MeshStandardMaterial)) {
      mat = new THREE.MeshStandardMaterial();
      obj.material = mat;
    }
    mat.color.setHex(mesh.color);
    mat.metalness = mesh.metalness;
    mat.roughness = mesh.roughness;
    mat.emissive.setHex(mesh.emissive);
    mat.wireframe = mesh.wireframe;
    mat.needsUpdate = true;
  }

  private refreshLight(light: LightNode, obj: THREE.Object3D): void {
    obj.children
      .slice()
      .filter((c) => (c.userData as { lamp?: boolean }).lamp)
      .forEach((c) => {
        obj.remove(c);
        disposeObject3D(c);
      });
    const lamp = new THREE.Group();
    lamp.userData.lamp = true;
    if (light.lightKind === "point") {
      lamp.add(new THREE.PointLight(light.lightColor, light.intensity));
      lamp.add(new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), emissiveMat(light.lightColor)));
    } else if (light.lightKind === "directional") {
      const dl = new THREE.DirectionalLight(light.lightColor, light.intensity);
      dl.castShadow = light.castShadow;
      lamp.add(dl);
      lamp.add(new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), emissiveMat(light.lightColor)));
    } else {
      lamp.add(new THREE.AmbientLight(light.lightColor, light.intensity));
    }
    obj.add(lamp);
  }

  private refreshCamera(node: CameraNode, obj: THREE.Object3D): void {
    let body = obj.children.find((c) => c.name === "__camBody");
    if (!body) {
      body = new THREE.Mesh();
      body.name = "__camBody";
      obj.add(body);
    }
    const mesh = body as THREE.Mesh;
    const geom = new THREE.BoxGeometry(0.7, 0.5, 1.0);
    mesh.geometry.dispose();
    mesh.geometry = geom;
    mesh.material = emissiveMat(node.isEditorCamera ? 0x44aaff : 0xcccccc);
  }

  dispose(): void {
    this.objectMap.forEach((o) => {
      o.parent?.remove(o);
      disposeObject3D(o);
    });
    this.objectMap.clear();
  }
}

function collectSubtree(graph: SceneGraph, id: string): string[] {
  const out: string[] = [];
  const walk = (cur: string) => {
    out.push(cur);
    graph.childrenOf(cur).forEach((c) => walk(c.id));
  };
  if (graph.has(id)) walk(id);
  return out;
}

function emissiveMat(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, wireframe: false });
}