import * as THREE from "three";
import type { Node } from "../../prototype/Node";
import type { SceneGraph, SceneChange } from "../../scene/SceneGraph";
import {
  MeshNode,
  LightNode,
  PointLightNode,
  DirectionalLightNode,
  SpotLightNode,
  CameraNode,
} from "../../prototype/derived/Primitives";
import { degToRad } from "../../prototype/types";
import { disposeObject3D, buildGeometry } from "./utils";
import { createIconSprite, type SpriteIconKind } from "./helpers/spriteIcon";
import { DEFAULT_MATERIAL_PARAMS, type MaterialParams } from "../../material/types";
import {
  DEFAULT_MATERIAL_TYPE,
  materialTypeRegistry,
} from "../../material/factory";

/** 材质参数查询（EditorEngine 注入 MaterialManager） */
export interface MaterialParamsLookup {
  paramsFor(rel: string): MaterialParams;
  /** 材质类型查询（注册表 key；未注入回退默认类型 physical） */
  typeFor?(rel: string): string;
  /** 异步加载贴图资产（rel → Texture；srgb=true 表示颜色贴图）。引擎注入，未注入则无贴图 */
  loadTexture?(rel: string, srgb: boolean): Promise<THREE.Texture | null>;
}

const defaultLookup: MaterialParamsLookup = {
  paramsFor: () => ({ ...DEFAULT_MATERIAL_PARAMS }),
};

export class SceneSynchronizer {
  private objectMap = new Map<string, THREE.Object3D>();
  private scene: THREE.Scene;
  private lookup: MaterialParamsLookup;

  constructor(scene: THREE.Scene, lookup: MaterialParamsLookup = defaultLookup) {
    this.scene = scene;
    this.lookup = lookup;
  }

  getObjectMap(): Map<string, THREE.Object3D> {
    return this.objectMap;
  }

  rebuildAll(graph: SceneGraph): void {
    this.objectMap.forEach((o: THREE.Object3D) => {
      o.parent?.remove(o);
      disposeObject3D(o);
    });
    this.objectMap.clear();
    graph.all().forEach((n: Node) => this.createObjectOnly(n));
    graph.all().forEach((n: Node) => this.attachParent(n));
    graph.all().forEach((n: Node) => this.refreshNode(n));
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

  private disposeMapped(id: string, _graph: SceneGraph): void {
    const rootObj = this.objectMap.get(id);
    if (!rootObj) return;
    // 不依赖 graph 遍历：SceneGraph.remove 在 emit "remove" 前已把节点从图中删除，
    // 若按 graph 找子树会拿到空集合，导致 Three 对象残留。改为按 objectMap 中的
    // Three 子树收集映射到的场景节点 id，逐一摘除并释放。
    const ids: string[] = [];
    rootObj.traverse((o) => {
      const nid = (o as THREE.Object3D).userData?.nodeId as string | undefined;
      if (nid && this.objectMap.has(nid)) ids.push(nid);
    });
    ids.forEach((sid) => {
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
    const rotRad = degToRad(node.transform.rotation);
    obj.rotation.set(rotRad.x, rotRad.y, rotRad.z);
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
    this.updateMeshMaterial(mesh, obj);
  }

  /**
   * 只刷新网格材质（几何/变换不动）：
   * 材质资产参数被修改保存后调用（避免重建几何）。
   */
  refreshMeshMaterial(mesh: MeshNode): void {
    const obj = this.objectMap.get(mesh.id);
    if (!obj) return;
    this.updateMeshMaterial(mesh, obj as THREE.Mesh);
  }

  /**
   * 按材质引用路径把 three 材质对齐到资产（类型 + 参数）：
   * 类型经工厂注册表解析（.mat 的 materialType 字段），类型不符时重建材质实例，
   * 参数应用规则由类型定义提供（MaterialTypeDef.apply）。
   */
  private updateMeshMaterial(mesh: MeshNode, obj: THREE.Mesh): void {
    const rel = mesh.material;
    const typeKey = this.lookup.typeFor?.(rel) ?? DEFAULT_MATERIAL_TYPE;
    const def = materialTypeRegistry.getOrDefault(typeKey);
    const params = this.lookup.paramsFor(rel);
    let mat: THREE.Material | undefined = obj.material as THREE.Material | undefined;
    if (!mat || !def.matches(mat)) {
      mat?.dispose();
      mat = def.create();
      obj.material = mat;
    }
    def.apply(mat, params, this.lookup);
  }

  private refreshLight(light: LightNode, obj: THREE.Object3D): void {
    obj.children
      .slice()
      .filter((c) => (c.userData as { lamp?: boolean }).lamp)
      .forEach((c) => {
        obj.remove(c);
        disposeObject3D(c);
      });

    // 平行光/聚光灯有方向语义：指向节点本地 -Z 的目标点对象随节点一起旋转
    const isTargeted =
      light instanceof DirectionalLightNode || light instanceof SpotLightNode;
    let dirTarget = obj.children.find((c) => c.name === "__dirTarget") as THREE.Object3D | null;
    if (!isTargeted) {
      if (dirTarget) {
        obj.remove(dirTarget);
        dirTarget = null;
      }
    } else if (!dirTarget) {
      dirTarget = new THREE.Object3D();
      dirTarget.name = "__dirTarget";
      dirTarget.position.set(0, 0, -1);
      obj.add(dirTarget);
    }

    const lamp = new THREE.Group();
    lamp.userData.lamp = true;
    let iconKind: SpriteIconKind = "light-point";
    if (light instanceof PointLightNode) {
      lamp.add(new THREE.PointLight(light.lightColor, light.intensity, light.distance, light.decay));
      iconKind = "light-point";
    } else if (light instanceof DirectionalLightNode) {
      const dl = new THREE.DirectionalLight(light.lightColor, light.intensity);
      dl.castShadow = light.castShadow;
      if (dirTarget) dl.target = dirTarget;
      lamp.add(dl);
      iconKind = "light-directional";
    } else if (light instanceof SpotLightNode) {
      const angleRad = (light.angle * Math.PI) / 180;
      const sl = new THREE.SpotLight(
        light.lightColor,
        light.intensity,
        light.distance,
        angleRad,
        light.penumbra,
        light.decay,
      );
      sl.castShadow = light.castShadow;
      if (dirTarget) sl.target = dirTarget;
      lamp.add(sl);
      iconKind = "light-spot";
    } else {
      // AmbientLightNode
      lamp.add(new THREE.AmbientLight(light.lightColor, light.intensity));
      iconKind = "light-ambient";
    }

    // 灯光类型对应的图标（点光灯泡 / 平行光太阳 / 环境光球体 / 聚光灯束）
    const icon = createIconSprite(iconKind, light.lightColor, 0.8);
    icon.name = "__lightIcon";
    lamp.add(icon);
    obj.add(lamp);
  }

  private refreshCamera(node: CameraNode, obj: THREE.Object3D): void {
    // 相机节点用图标精灵表示（真实渲染时相机本身无实体几何）
    let icon = obj.children.find((c) => c.name === "__camIcon") as THREE.Sprite | null;
    if (!icon) {
      icon = createIconSprite("camera", node.isEditorCamera ? 0x66aaff : 0x9ad7ff, 1.15);
      icon.name = "__camIcon";
      obj.add(icon);
    }
    (icon.material as THREE.SpriteMaterial).color.setHex(
      node.isEditorCamera ? 0x66aaff : 0x9ad7ff,
    );
  }

  dispose(): void {
    this.objectMap.forEach((o) => {
      o.parent?.remove(o);
      disposeObject3D(o);
    });
    this.objectMap.clear();
  }
}