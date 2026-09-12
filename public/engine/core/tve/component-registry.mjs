// ---------------------------------------------------------------------------
// 内置组件注册表 + 工厂函数 + resolveComponentField
// 门面类注册（类型键 ↔ 类双通道寻址）；createBuiltinFacade/builtinFacadeOf 按
// 类型键解析实体已有组件为门面；createRuntimeBuiltin 在节点上创建运行时组件。
// ---------------------------------------------------------------------------
import { postLog } from "../log.mjs";
import { buildComponentLight } from "../lights.mjs";
import {
  state,
  nodeJsonOf,
  componentJsonOf,
  pushComponentJson,
  nextRuntimeCompId,
} from "./state.mjs";
import {
  lightSettingsFrom,
  audioSettingsFrom,
  clipBindingFrom,
  LOOP_MODES,
} from "./component-base.mjs";
import { Light } from "./component-light.mjs";
import {
  RigidBody,
  Collider,
  AudioSource,
  AnimationClip,
  SkeletalAnimation,
} from "./component-facades.mjs";

// 组件类型键标记（字符串名 ↔ 门面类双通道寻址；@property 组件字段识别用）
RigidBody.__tveComponentType = "rigidBody";
Collider.__tveComponentType = "collider";
Light.__tveComponentType = "light";
AudioSource.__tveComponentType = "audioSource";
AnimationClip.__tveComponentType = "animationClip";
SkeletalAnimation.__tveComponentType = "skeletalAnimation";

/** 门面类注册表（类型键 → 类；"animation"/"anim" 别名指向骨骼动画） */
const BUILTIN_FACADES = {
  rigidBody: RigidBody,
  collider: Collider,
  light: Light,
  audioSource: AudioSource,
  animationClip: AnimationClip,
  skeletalAnimation: SkeletalAnimation,
};
const BUILTIN_TYPE_KEYS = Object.keys(BUILTIN_FACADES);

/** getComponent/addComponent 参数 → 组件类型键（类或字符串；未知返回 null） */
function builtinTypeKeyOf(token) {
  if (typeof token === "string") {
    if (token === "animation" || token === "anim") return "skeletalAnimation";
    return BUILTIN_TYPE_KEYS.includes(token) ? token : null;
  }
  if (typeof token === "function" && typeof token.__tveComponentType === "string") {
    return BUILTIN_TYPE_KEYS.includes(token.__tveComponentType) ? token.__tveComponentType : null;
  }
  return null;
}

/** 按类型键解析实体已有组件为门面（不存在返回 null；不写缓存） */
function createBuiltinFacade(entity, typeKey) {
  const json = nodeJsonOf(entity.id);
  switch (typeKey) {
    case "rigidBody":
      return state.host?.physics?.bodyInfo(entity.id)
        ? new RigidBody(entity, typeKey, componentJsonOf(json, "rigidBody"))
        : null;
    case "collider": {
      const c = componentJsonOf(json, "collider");
      return c ? new Collider(entity, typeKey, c) : null;
    }
    case "light": {
      const c = componentJsonOf(json, "light");
      return c ? new Light(entity, typeKey, c) : null;
    }
    case "audioSource": {
      const c = componentJsonOf(json, "audioSource");
      return c ? new AudioSource(entity, typeKey, c) : null;
    }
    case "animationClip": {
      const c = componentJsonOf(json, "animationClip");
      return c ? new AnimationClip(entity, typeKey, c) : null;
    }
    case "skeletalAnimation":
      return state.host?.animations?.bindingOf?.(entity.id)
        ? new SkeletalAnimation(entity, typeKey, null)
        : null;
    default:
      return null;
  }
}

/** 实体的指定类型内置组件门面（句柄缓存；未挂载返回 null） */
function builtinFacadeOf(entity, typeKey) {
  let byType = state.builtinByNode.get(entity.id);
  const hit = byType?.get(typeKey);
  if (hit) return hit;
  const facade = createBuiltinFacade(entity, typeKey);
  if (!facade) return null;
  if (!byType) {
    byType = new Map();
    state.builtinByNode.set(entity.id, byType);
  }
  byType.set(typeKey, facade);
  return facade;
}

/** 在节点上创建运行时内置组件并返回门面 */
function createRuntimeBuiltin(entity, typeKey, settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  const json = nodeJsonOf(entity.id);
  if (!json) return null;
  if (typeKey === "light") {
    const comp = {
      id: nextRuntimeCompId(),
      type: "light",
      enabled: true,
      light: lightSettingsFrom(s),
    };
    pushComponentJson(json, comp);
    buildComponentLight(comp.light, entity.__obj);
    return new Light(entity, typeKey, comp);
  }
  if (typeKey === "audioSource") {
    const comp = {
      id: nextRuntimeCompId(),
      type: "audioSource",
      enabled: true,
      audio: audioSettingsFrom(s),
    };
    pushComponentJson(json, comp);
    state.host?.audios?.addSource?.({ id: comp.id, audio: comp.audio }, entity.__obj, entity.id);
    return new AudioSource(entity, typeKey, comp);
  }
  if (typeKey === "animationClip") {
    const comp = {
      id: nextRuntimeCompId(),
      type: "animationClip",
      enabled: true,
      clip: clipBindingFrom(s),
    };
    pushComponentJson(json, comp);
    state.host?.clipAnims?.add?.({
      key: comp.id,
      obj: entity.__obj,
      clip: comp.clip.clip,
      autoplay: comp.clip.autoplay,
      loop: comp.clip.loop,
      speed: comp.clip.speed,
    });
    return new AnimationClip(entity, typeKey, comp);
  }
  if (typeKey === "skeletalAnimation") {
    if (!state.host?.animations?.bindingOf?.(entity.id)) {
      postLog("warn", "[tve] 骨骼动画组件只能用于模型网格节点（source=model）");
      return null;
    }
    if (s.graph && typeof s.graph === "object") state.host.animations.applyGraph(entity.id, s.graph);
    const anim = {};
    if (typeof s.clip === "string") anim.clip = s.clip;
    if (typeof s.autoplay === "boolean") anim.autoplay = s.autoplay;
    if (typeof s.speed === "number" && Number.isFinite(s.speed) && s.speed >= 0) {
      anim.speed = s.speed;
    }
    if (LOOP_MODES.includes(s.loop)) anim.loop = s.loop;
    if (Object.keys(anim).length) state.host.animations.applyAnim(entity.id, anim);
    return builtinFacadeOf(entity, typeKey);
  }
  return null;
}

/** 解析脚本组件字段声明（宿主实例化后调用；get-or-create 语义） */
export function resolveComponentField(entity, typeKey) {
  if (!BUILTIN_TYPE_KEYS.includes(typeKey)) return null;
  if (typeKey === "rigidBody" || typeKey === "collider") {
    return createBuiltinFacade(entity, typeKey);
  }
  const existing = createBuiltinFacade(entity, typeKey);
  if (existing) return builtinFacadeOf(entity, typeKey);
  if (typeKey === "skeletalAnimation") return null;
  return createRuntimeBuiltin(entity, typeKey, {});
}

// 注入到 state（entity.mjs 经 state 调用，打破循环依赖）
state.builtinTypeKeyOf = builtinTypeKeyOf;
state.builtinFacadeOf = builtinFacadeOf;
state.createRuntimeBuiltin = createRuntimeBuiltin;

export {
  BUILTIN_FACADES,
  BUILTIN_TYPE_KEYS,
  builtinTypeKeyOf,
  createBuiltinFacade,
  builtinFacadeOf,
  createRuntimeBuiltin,
  RigidBody,
  Collider,
  Light,
  AudioSource,
  AnimationClip,
  SkeletalAnimation,
};