import { vec3, type JsonRecord, type Vec3 } from "../prototype/types";
import {
  CameraNode,
  LightNode,
  MeshNode,
  type GeometryKind,
} from "../prototype/derived/Primitives";
import { Node } from "../prototype/Node";
import { PrototypeRegistry } from "../prototype/PrototypeRegistry";
import { Transform } from "../prototype/Transform";

export type EditorNodeType = "node" | "meshNode" | "lightNode" | "cameraNode";

export interface CreateOptions {
  parentId?: string | null;
  name?: string;
  position?: Vec3;
}

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

  createLight(
    kind: "point" | "directional" | "ambient",
    opts: CreateOptions = {},
  ): LightNode {
    const node = this.registry.create("lightNode") as LightNode;
    node.lightKind = kind;
    node.positionHint = vec3(5, 8, 5);
    node.name = opts.name ?? `Light_${kind}`;
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

export type { MeshNode, LightNode, CameraNode };

export function createNodeFactory(registry: PrototypeRegistry): NodeFactory {
  return new NodeFactory(registry);
}