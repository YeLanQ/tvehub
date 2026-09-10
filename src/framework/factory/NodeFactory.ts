import type { JsonRecord, Vec3 } from "../prototype/types";
import {
  AudioNode,
  CameraNode,
  LightNode,
  MeshNode,
  ParticleSystemNode,
  SkyboxNode,
  skyMaterialForKind,
  type LightKind,
  type SkyboxKind,
} from "../prototype/derived/Primitives";
import { Node } from "../prototype/Node";
import { PrototypeRegistry } from "../prototype/PrototypeRegistry";
import { Transform } from "../prototype/Transform";
import { geometryRegistry, modelFileStem } from "../mesh";

export type EditorNodeType =
  | "node"
  | "meshNode"
  | "lightNode"
  | "cameraNode"
  | "skyboxNode"
  | "audioNode"
  | "particleSystemNode";

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

  createMesh(geometry: string, opts: CreateOptions = {}): MeshNode {
    const node = this.registry.create("meshNode") as MeshNode;
    const def = geometryRegistry.getOrDefault(geometry);
    node.source = "primitive";
    node.geometry = def.key;
    node.name = opts.name ?? def.label;
    this.decorate(node, { ...opts, name: undefined });
    return node;
  }

  /**
   * 按模型资产引用创建模型网格（source=model）：
   * 几何/材质由模型内嵌，节点只持有引用；动画默认自动播放首个剪辑。
   */
  createModel(rel: string, opts: CreateOptions = {}): MeshNode {
    const node = this.registry.create("meshNode") as MeshNode;
    node.source = "model";
    node.model = rel;
    node.material = ""; // 模型材质内嵌，不走材质资产
    node.name = opts.name ?? modelFileStem(rel);
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

  /** 创建音源节点（音频资产引用与播放参数后续经检查器绑定） */
  createAudio(opts: CreateOptions = {}): AudioNode {
    const node = this.registry.create("audioNode") as AudioNode;
    node.name = opts.name ?? "Audio Source";
    this.decorate(node, { ...opts, name: undefined });
    return node;
  }

  /** 创建粒子系统节点（默认为循环的叠加混合圆锥发射器；参数经检查器调整） */
  createParticleSystem(opts: CreateOptions = {}): ParticleSystemNode {
    const node = this.registry.create("particleSystemNode") as ParticleSystemNode;
    node.name = opts.name ?? "Particle System";
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
        : K extends "audioNode"
          ? AudioNode
          : K extends "particleSystemNode"
            ? ParticleSystemNode
            : Node;

function defaultSkyboxName(kind: SkyboxKind): string {
  return kind === "procedural" ? "Procedural Skybox" : "Cube Skybox";
}

export type { MeshNode, LightNode, CameraNode, SkyboxNode, AudioNode, ParticleSystemNode };

export function createNodeFactory(registry: PrototypeRegistry): NodeFactory {
  return new NodeFactory(registry);
}
