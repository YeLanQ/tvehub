import { PrototypeRegistry, createDefaultRegistry } from "./PrototypeRegistry";
import type { PrototypeCtor } from "./PrototypeRegistry";

export { Prototype } from "./Prototype";
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
  LightKind,
} from "./derived/Primitives";
export type { TransformInit } from "./Transform";
export type { Vec3, Euler, JsonValue, JsonRecord } from "./types";
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
