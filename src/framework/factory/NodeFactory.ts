import type { JsonRecord, Vec3 } from "../prototype/types";
import {
  CameraNode,
  LightNode,
  MeshNode,
  SkyboxNode,
  skyMaterialForKind,
  type GeometryKind,
  type LightKind,
  type SkyboxKind,
} from "../prototype/derived/Primitives";
import { Node } from "../prototype/Node";
import { PrototypeRegistry } from "../prototype/PrototypeRegistry";
import { Transform } from "../prototype/Transform";

export type EditorNodeType =
  | "node"
  | "meshNode"
  | "lightNode"
  | "cameraNode"
  | "skyboxNode";

export interface CreateOptions {
  parentId?: string | null;
  name?: string;
  position?: Vec3;
}

const LIGHT_TYPE_KEY: Record<LightKind, string> = {
  point: "pointLightNode",
  directional: "directionalLightNode",
  ambient: "ambientLightNode",
  spot: "spotLightNode",
};

const LIGHT_DEFAULT_NAME: Record<LightKind, string> = {
  point: "Point Light",
  directional: "Directional Light",
  ambient: "Ambient Light",
  spot: "Spot Light",
};

/**
 * 工厂层。
 * 屏蔽“原型实例化”的细节：调用方只声明要哪种类型，
 * 工厂从 PrototypeRegistry 取出对应模板并 clone 派生出节点，
 * 再统一注入编辑器级默认值（命名、变换、父级）。
 */
export class NodeFactory {
  constructor(private registry: PrototypeRegistry) {}

  create<K extends EditorNodeType>(type: K, opts: CreateOptions = {}): NodeOf<K> {
    const node = this.registry.create(type) as NodeOf<K>;
    this.decorate(node, opts);
    return node;
  }

  private decorate(node: Node, opts: CreateOptions): void {
    if (opts.parentId !== undefined) node.parentId = opts.parentId;
    if (opts.name) node.name = opts.name;
    if (opts.position) node.transform = new Transform({ position: opts.position });
  }

  createMesh(geometry: GeometryKind, opts: CreateOptions = {}): MeshNode {
    const node = this.registry.create("meshNode") as MeshNode;
    node.geometry = geometry;
    node.name = opts.name ?? defaultMeshName(geometry);
    this.decorate(node, { ...opts, name: undefined });
    return node;
  }

  /** 按灯光类型创建对应节点原型（点光/平行光/环境光/聚光灯） */
  createLight(kind: LightKind, opts: CreateOptions = {}): LightNode {
    const node = this.registry.create(LIGHT_TYPE_KEY[kind]) as LightNode;
    node.name = opts.name ?? LIGHT_DEFAULT_NAME[kind];
    this.decorate(node, { ...opts, name: undefined });
    return node;
  }

  createCamera(opts: CreateOptions & { isEditorCamera?: boolean } = {}): CameraNode {
    const node = this.registry.create("cameraNode") as CameraNode;
    node.isEditorCamera = opts.isEditorCamera ?? false;
    node.name = opts.name ?? (node.isEditorCamera ? "EditorCamera" : "Camera");
    this.decorate(node, { ...opts, name: undefined });
    return node;
  }

  /** 按天空盒类型创建对应节点原型（程序化天空 / 默认立方体天空盒） */
  createSkybox(kind: SkyboxKind, opts: CreateOptions = {}): SkyboxNode {
    const node = this.registry.create("skyboxNode") as SkyboxNode;
    node.skyKind = kind;
    // 类型固定 → 材质引用固定到对应的内置天空盒材质
    node.material = skyMaterialForKind(kind);
    node.name = opts.name ?? defaultSkyboxName(kind);
    this.decorate(node, { ...opts, name: undefined });
    return node;
  }

  fromJSON(json: JsonRecord): Node {
    return this.registry.createFromJSON(json);
  }
}

type NodeOf<K extends EditorNodeType> = K extends "meshNode"
  ? MeshNode
  : K extends "lightNode"
    ? LightNode
    : K extends "cameraNode"
      ? CameraNode
      : K extends "skyboxNode"
        ? SkyboxNode
        : Node;

function defaultMeshName(geometry: GeometryKind): string {
  const map: Record<GeometryKind, string> = {
    box: "Cube",
    sphere: "Sphere",
    plane: "Plane",
    cylinder: "Cylinder",
  };
  return map[geometry];
}

function defaultSkyboxName(kind: SkyboxKind): string {
  return kind === "procedural" ? "Procedural Skybox" : "Cube Skybox";
}

export type { MeshNode, LightNode, CameraNode, SkyboxNode };

export function createNodeFactory(registry: PrototypeRegistry): NodeFactory {
  return new NodeFactory(registry);
}
