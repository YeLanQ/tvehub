// 节点组件层 barrel：契约（types）+ 各类型描述符 + 查表注册表。

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
  NodeComponentRef,
  RigidBodyComponentRef,
  ScriptComponentRef,
} from "./types";
export {
  isAnimationClipComponent,
  isAudioSourceComponent,
  isColliderComponent,
  isLightComponent,
  isRigidBodyComponent,
  isScriptComponent,
} from "./types";
export { parseAnimClipBinding } from "./animationClipComponent";
export {
  cloneComponentForWrite,
  cloneNodeComponents,
  descriptorOf,
  parseNodeComponents,
} from "./registry";
