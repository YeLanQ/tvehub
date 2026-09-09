import {
  AmbientLightNode,
  AudioNode,
  CameraNode,
  DirectionalLightNode,
  LightNode,
  MeshNode,
  PointLightNode,
  SkyboxNode,
  SpotLightNode,
} from "./derived/Primitives";
import { Node, type RegisteredNodeTypes } from "./Node";
import type { JsonRecord } from "./types";

/** 类型键 → 构造空模板原型的工厂函数 */
export type PrototypeCtor = () => Node;

/**
 * 原型注册中心。
 * 集中登记“基元 + 派生原型”的类型键与模板工厂，
 * 供工厂层按类型克隆派生出具体实例（Prototype 模式的核心登记表）。
 */
export class PrototypeRegistry implements RegisteredNodeTypes {
  private ctors = new Map<string, PrototypeCtor>();

  register(type: string, factory: PrototypeCtor): void {
    this.ctors.set(type, factory);
  }

  has(type: string): boolean {
    return this.ctors.has(type);
  }

  /** 取出模板原型 */
  getTemplate(type: string): Node {
    const ctor = this.ctors.get(type);
    if (!ctor) throw new Error(`unregistered prototype type: ${type}`);
    return ctor();
  }

  /** 从注册的模板原型 clone 出一个全新实例（派生） */
  create(type: string): Node {
    return this.getTemplate(type).clone();
  }

  /** 按序列化数据反序列化出实例（先取正确派生类模板，再回填扩展字段） */
  createFromJSON(json: JsonRecord): Node {
    const type = json.type as string;
    const node = this.getTemplate(type);
    node.applyJSON(json);
    return node;
  }

  listTypes(): string[] {
    return [...this.ctors.keys()];
  }
}

/** 缺省注册表：登记两个基元与其派生原型 */
export function createDefaultRegistry(): PrototypeRegistry {
  const registry = new PrototypeRegistry();
  registry.register(Node.kType, () => new Node());
  registry.register(MeshNode.kType, () => new MeshNode());
  // 灯光按类型拆分注册
  registry.register(PointLightNode.kType, () => new PointLightNode());
  registry.register(DirectionalLightNode.kType, () => new DirectionalLightNode());
  registry.register(AmbientLightNode.kType, () => new AmbientLightNode());
  registry.register(SpotLightNode.kType, () => new SpotLightNode());
  // 兼容旧场景里 type = "lightNode" 的灯光：按点光源回退解析
  registry.register(LightNode.kType, () => new PointLightNode());
  registry.register(CameraNode.kType, () => new CameraNode());
  registry.register(SkyboxNode.kType, () => new SkyboxNode());
  registry.register(AudioNode.kType, () => new AudioNode());
  return registry;
}