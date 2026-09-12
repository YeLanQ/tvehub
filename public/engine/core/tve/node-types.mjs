// ---------------------------------------------------------------------------
// 节点类型（Entity 子类 + 编辑器 type 键映射）
// 作为 @property({ type }) 的引用 token 与运行时类型（instanceof 可判断）。
// 层级：Transform 承载通用节点能力，具体类型继续派生，保证
//   meshNode 实例 instanceof Transform / Entity 均成立。
// ---------------------------------------------------------------------------
import { state } from "./state.mjs";
import { Entity, setKindClasses } from "./entity.mjs";

class Transform extends Entity {}
class MeshNode extends Transform {}
class LightNode extends Transform {}
class CameraNode extends Transform {}
class SkyboxNode extends Transform {}

class ParticleSystemNode extends Transform {
  play() { state.host?.particles?.play(this.id); }
  pause() { state.host?.particles?.pause(this.id); }
  stop() { state.host?.particles?.stop(this.id); }
  restart() { state.host?.particles?.restart(this.id); }
  clear() { state.host?.particles?.clear(this.id); }
  get playing() { return state.host?.particles?.infoOf(this.id)?.playing ?? false; }
  get paused() { return state.host?.particles?.infoOf(this.id)?.paused ?? false; }
  get finished() { return state.host?.particles?.infoOf(this.id)?.finished ?? false; }
  get aliveCount() { return state.host?.particles?.infoOf(this.id)?.alive ?? 0; }
  get settings() { return state.host?.particles?.settingsOf(this.id) ?? null; }
  setSettings(patch) { state.host?.particles?.updateSettings(this.id, patch); }
}

for (const key of [
  "duration", "looping", "prewarm", "startDelay", "startLifetime", "startSpeed",
  "startSize", "startColor", "endColor", "gravityModifier", "emissionRate",
  "maxParticles", "shape", "shapeRadius", "shapeAngle", "simulationSpace",
  "colorOverLifetime", "sizeOverLifetime", "blending", "texture",
]) {
  Object.defineProperty(ParticleSystemNode.prototype, key, {
    configurable: true,
    enumerable: false,
    get() { const s = state.host?.particles?.settingsOf(this.id); return s ? s[key] : undefined; },
    set(v) { state.host?.particles?.updateSettings(this.id, { [key]: v }); },
  });
}

class UICanvasNode extends Transform {}
class UIImageNode extends Transform {}
class UITextNode extends Transform {}
class UIButtonNode extends Transform {}
class UILayoutNode extends Transform {}

const UI_ANCHOR_KEYS = ["anchorMin", "anchorMax", "pivot", "anchoredPosition", "offsetMin", "offsetMax"];

for (const [Cls, keys] of [
  [UICanvasNode, ["sortOrder", "designWidth", "designHeight", "scaleMode"]],
  [UIImageNode, ["sortOrder", "size", ...UI_ANCHOR_KEYS, "image", "color"]],
  [UITextNode, ["sortOrder", "size", ...UI_ANCHOR_KEYS, "text", "fontSize", "color", "bold", "italic", "fontFamily", "align"]],
  [UIButtonNode, ["sortOrder", "size", ...UI_ANCHOR_KEYS, "image", "color", "label", "labelColor", "fontSize", "labelBold", "interactable"]],
  [UILayoutNode, ["sortOrder", "size", ...UI_ANCHOR_KEYS, "layoutMode", "padding", "spacing", "gridColumns"]],
]) {
  for (const key of keys) {
    Object.defineProperty(Cls.prototype, key, {
      configurable: true,
      enumerable: false,
      get() { const s = state.host?.ui?.settingsOf(this.id); return s ? s[key] : undefined; },
      set(v) { state.host?.ui?.updateSettings(this.id, { [key]: v }); },
    });
  }
}

const KIND_CLASSES = {
  node: Transform,
  meshNode: MeshNode,
  cameraNode: CameraNode,
  skyboxNode: SkyboxNode,
  audioNode: Transform,
  particleSystemNode: ParticleSystemNode,
  lightNode: LightNode,
  pointLightNode: LightNode,
  directionalLightNode: LightNode,
  ambientLightNode: LightNode,
  spotLightNode: LightNode,
  uiCanvasNode: UICanvasNode,
  uiImageNode: UIImageNode,
  uiTextNode: UITextNode,
  uiButtonNode: UIButtonNode,
  uiLayoutNode: UILayoutNode,
};

// 注入回 entity.mjs（getEntity 按 userData.nodeKind 构建实例）
setKindClasses(KIND_CLASSES);

Transform.__nodeKinds = null;
MeshNode.__nodeKinds = ["meshNode"];
LightNode.__nodeKinds = [
  "lightNode", "pointLightNode", "directionalLightNode", "ambientLightNode", "spotLightNode",
];
CameraNode.__nodeKinds = ["cameraNode"];
SkyboxNode.__nodeKinds = ["skyboxNode"];
ParticleSystemNode.__nodeKinds = ["particleSystemNode"];
UICanvasNode.__nodeKinds = ["uiCanvasNode"];
UIImageNode.__nodeKinds = ["uiImageNode"];
UITextNode.__nodeKinds = ["uiTextNode"];
UIButtonNode.__nodeKinds = ["uiButtonNode"];
UILayoutNode.__nodeKinds = ["uiLayoutNode"];

/** @property({ type: 节点类 }) 是否节点引用选项（运行时标识） */
export function isNodeRefType(v) {
  return typeof v === "function" && v !== Entity && Object.prototype.hasOwnProperty.call(v, "__nodeKinds");
}

export {
  KIND_CLASSES,
  Transform,
  MeshNode,
  LightNode,
  CameraNode,
  SkyboxNode,
  ParticleSystemNode,
  UICanvasNode,
  UIImageNode,
  UITextNode,
  UIButtonNode,
  UILayoutNode,
};