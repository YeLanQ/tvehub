import type { JsonRecord, Vec3 } from "../prototype/types";
import {
  AudioNode,
  CameraNode,
  LightNode,
  MeshNode,
  ParticleSystemNode,
  SkyboxNode,
  UIButtonNode,
  UICanvasNode,
  UIImageNode,
  UILayoutNode,
  UITextNode,
  skyMaterialForKind,
  type LightKind,
  type SkyboxKind,
  type UIScaleMode,
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
  | "particleSystemNode"
  | "uiCanvasNode"
  | "uiImageNode"
  | "uiTextNode"
  | "uiButtonNode"
  | "uiLayoutNode";

/** UI 画布创建默认值（应用层从项目设置传入：设计分辨率/屏幕方向/缩放模式） */
export interface UICanvasDefaults {
  designWidth: number;
  designHeight: number;
  scaleMode: UIScaleMode;
}

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

  /**
   * 创建 UI 画布（Canvas-Widget 的 Canvas；Widget 挂其下，屏幕叠加渲染）。
   * defaults：项目设置默认值（设计分辨率按屏幕方向定向 + 缩放模式）；
   * 缺省回退 1280×720 / fixedauto。
   */
  createUICanvas(opts: CreateOptions = {}, defaults?: UICanvasDefaults): UICanvasNode {
    const node = this.registry.create("uiCanvasNode") as UICanvasNode;
    node.name = opts.name ?? "UI Canvas";
    if (defaults) {
      node.designWidth = defaults.designWidth;
      node.designHeight = defaults.designHeight;
      node.scaleMode = defaults.scaleMode;
    }
    this.decorate(node, { ...opts, name: undefined });
    return node;
  }

  /** 创建 UI 图片 Widget（默认纯色矩形；图片资产经检查器绑定） */
  createUIImage(opts: CreateOptions = {}): UIImageNode {
    const node = this.registry.create("uiImageNode") as UIImageNode;
    node.name = opts.name ?? "Image";
    this.decorate(node, { ...opts, name: undefined });
    return node;
  }

  /** 创建 UI 文本 Widget（默认内容 "Text"；样式经检查器调整） */
  createUIText(opts: CreateOptions = {}): UITextNode {
    const node = this.registry.create("uiTextNode") as UITextNode;
    node.name = opts.name ?? "Text";
    this.decorate(node, { ...opts, name: undefined });
    return node;
  }

  /** 创建 UI 按钮 Widget（背景 + 标签；运行时可点击，脚本经 engine.ui 订阅） */
  createUIButton(opts: CreateOptions = {}): UIButtonNode {
    const node = this.registry.create("uiButtonNode") as UIButtonNode;
    node.name = opts.name ?? "Button";
    this.decorate(node, { ...opts, name: undefined });
    return node;
  }

  /** 创建 UI 布局容器（横向/竖向/网格排列直接子 UI 节点；自身经锚点定位） */
  createUILayout(opts: CreateOptions = {}): UILayoutNode {
    const node = this.registry.create("uiLayoutNode") as UILayoutNode;
    node.name = opts.name ?? "Layout";
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
            : K extends "uiCanvasNode"
              ? UICanvasNode
              : K extends "uiImageNode"
                ? UIImageNode
                : K extends "uiTextNode"
                  ? UITextNode
              : K extends "uiButtonNode"
                ? UIButtonNode
                : K extends "uiLayoutNode"
                  ? UILayoutNode
                  : Node;

function defaultSkyboxName(kind: SkyboxKind): string {
  return kind === "procedural" ? "Procedural Skybox" : "Cube Skybox";
}

export type {
  MeshNode,
  LightNode,
  CameraNode,
  SkyboxNode,
  AudioNode,
  ParticleSystemNode,
  UICanvasNode,
  UIImageNode,
  UITextNode,
  UIButtonNode,
  UILayoutNode,
};

export function createNodeFactory(registry: PrototypeRegistry): NodeFactory {
  return new NodeFactory(registry);
}
