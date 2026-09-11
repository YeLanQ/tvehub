import { PrototypeRegistry, createDefaultRegistry } from "./PrototypeRegistry";
import type { PrototypeCtor } from "./PrototypeRegistry";

export { Prototype } from "./Prototype";
export type { IPrototype, ITransform, INode } from "./interfaces";
export { Node, parseNodeComponents } from "./Node";
export type { NodeComponentRef } from "./Node";
export { Transform, AnchoredTransform } from "./Transform";
export {
  MeshNode,
  LightNode,
  AmbientLightNode,
  PointLightNode,
  DirectionalLightNode,
  SpotLightNode,
  CameraNode,
  AudioNode,
  ParticleSystemNode,
  UICanvasNode,
  UIImageNode,
  UITextNode,
  UIButtonNode,
} from "./derived/Primitives";
export { PrototypeRegistry, createDefaultRegistry };
export type { PrototypeCtor };
export type { NodeInit, RegisteredNodeTypes } from "./Node";
export type {
  GeometryKind,
  MeshNodeInit,
  LightNodeInit,
  CameraNodeInit,
  AudioNodeInit,
  ParticleSystemNodeInit,
  LightKind,
} from "./derived/Primitives";
export type { TransformInit } from "./Transform";
export type { Vec3, Euler, JsonValue, JsonRecord } from "./types";
// 组件契约层（描述符注册表：每种组件类型的创建/解析/克隆/写出/重置）
export {
  parseAnimClipBinding,
  cloneComponentForWrite,
  cloneNodeComponents,
  descriptorOf,
} from "./components";
export type {
  AnimClipBinding,
  AnimationClipComponentRef,
  AudioSourceComponentRef,
  ColliderComponentRef,
  ComponentCreateOptions,
  ComponentDescriptor,
  ComponentType,
  INodeComponent,
  LightComponentRef,
  RigidBodyComponentRef,
  ScriptComponentRef,
} from "./components";
export {
  isAnimationClipComponent,
  isAudioSourceComponent,
  isColliderComponent,
  isLightComponent,
  isRigidBodyComponent,
  isScriptComponent,
} from "./components";
// 节点能力接口（与各自类同文件声明）
export type { IMeshNode, IAnimatable } from "./nodes/MeshNode";
export type { ILightNode } from "./nodes/LightNode";
export type { IPointLightNode } from "./nodes/PointLightNode";
export type { IAmbientLightNode } from "./nodes/AmbientLightNode";
export type { IDirectionalLightNode } from "./nodes/DirectionalLightNode";
export type { ISpotLightNode } from "./nodes/SpotLightNode";
export type { ICameraNode } from "./nodes/CameraNode";
export type { ISkyboxNode } from "./nodes/SkyboxNode";
export type { IAudioNode } from "./nodes/AudioNode";
export type { IParticleSystemNode } from "./nodes/ParticleSystemNode";
export type { IUICanvasNode } from "./nodes/UICanvasNode";
export type { IUIImageNode } from "./nodes/UIImageNode";
export type { IUITextNode } from "./nodes/UITextNode";
export type { IUIButtonNode } from "./nodes/UIButtonNode";
export type {
  ScenePrototypeDoc,
  NodePrototypeDoc,
  MeshNodePrototypeDoc,
  LightNodePrototypeDoc,
  CameraNodePrototypeDoc,
  TransformPrototypeDoc,
  PrototypeTypeMap,
  PrototypeDocumentation,
} from "./docs";
