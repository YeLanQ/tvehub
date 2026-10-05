// ---------------------------------------------------------------------------
// 内置组件门面基类 + 常量 + 设置收敛函数
// ---------------------------------------------------------------------------
import type { ComponentJson } from "./state";
import type { Entity } from "./entity";

export const LIGHT_KINDS = ["point", "directional", "spot", "ambient"];
export const LOOP_MODES = ["loop", "once", "pingpong"];
export const CONDITION_OPS = [">", "<", ">=", "<=", "==", "!="];

/**
 * 组件门面类构造器视图（__tveComponentType 由 component-registry 挂载，
 * decorators/builtinTypeKeyOf 据此把类解析为组件类型键）。
 */
export type ComponentFacadeCtor = Function & {
  __tveComponentType?: unknown;
};

/**
 * 灯光组件设置（lightSettingsFrom 产出/场景 JSON 收敛后的形状）。
 * 类型别名（非 interface）：需作为 Record<string, unknown> 传入 buildComponentLight。
 */
export type LightSettings = {
  kind: string;
  lightColor: number;
  intensity: number;
  distance: number;
  decay: number;
  angle: number;
  penumbra: number;
  castShadow: boolean;
  cullingMask: number;
  shadowStrength: number;
  shadowBias: number;
  shadowNormalBias: number;
  shadowNear: number;
  shadowRadius: number;
  shadowResolution: number;
};

/** 音源组件设置（与 audio.mjs parseAudioSettings 同一取值域） */
export type AudioSettings = {
  source: string;
  autoplay: boolean;
  loop: boolean;
  volume: number;
  speed: number;
  spatial: string;
  refDistance: number;
  maxDistance: number;
  rolloff: number;
};

/** 动画剪辑组件设置（clip/autoplay/loop/speed） */
export type ClipBindingOptions = {
  clip: string;
  autoplay: boolean;
  loop: boolean;
  speed: number;
};

/** 门面基类：承装实体句柄 / 组件类型键 / 组件引用 JSON */class BuiltinComponent {
  static declare __tveComponentType?: string;

  /** 宿主实体句柄 */
  entity: Entity;
  /** 组件类型键（rigidBody/collider/light/audioSource/animationClip/skeletalAnimation） */
  type: string;
  /** 组件引用 JSON（运行时创建的组件可能无 JSON，为 null） */
  __json: ComponentJson | null;

  constructor(entity: Entity, typeKey: string, json: ComponentJson | null) {
    this.entity = entity;
    this.type = typeKey;
    this.__json = json ?? null;
  }

  get id(): string {
    return String(this.__json?.id ?? "");
  }
}

export { BuiltinComponent };

/** 灯光组件设置收敛（缺省项回默认；color 为 lightColor 别名） */
export function lightSettingsFrom(s: Record<string, unknown> | null | undefined): LightSettings {
  // 断言安全：cullingMask/shadow* 各字段在 return 前必然逐项赋值，缺省入参走
  // 提前返回时保持原 8 键字面量形状不变
  const out = {
    kind: "point",
    lightColor: 0xffffff,
    intensity: 1,
    distance: 10,
    decay: 2,
    angle: 45,
    penumbra: 0.2,
    castShadow: false,
  } as LightSettings;
  if (!s || typeof s !== "object") return out;
  if (LIGHT_KINDS.includes(s.kind as string)) out.kind = s.kind as string;
  const color = typeof s.lightColor === "number" ? s.lightColor : s.color;
  if (typeof color === "number" && Number.isFinite(color)) {
    out.lightColor = Math.max(0, Math.round(color)) & 0xffffff;
  }
  // lo 可缺省：shadowResolution 以 2 参调用，lo 为 undefined 时
  // Math.max(undefined, v) → NaN → 档位 includes 恒 false → 回 0（保持原运行行为）
  const num = (v: unknown, fb: number, lo?: number, hi?: number): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) return fb;
    return hi === undefined ? Math.max(lo!, v) : Math.min(hi, Math.max(lo!, v));
  };
  out.intensity = num(s.intensity, out.intensity, 0);
  out.distance = num(s.distance, out.distance, 0);
  out.cullingMask =
    typeof s.cullingMask === "number" && Number.isFinite(s.cullingMask) ? s.cullingMask | 0 : -1;
  out.decay = num(s.decay, out.decay, 0);
  out.angle = num(s.angle, out.angle, 1, 89);
  out.penumbra = num(s.penumbra, out.penumbra, 0, 1);
  if (typeof s.castShadow === "boolean") out.castShadow = s.castShadow;
  out.shadowStrength = num(s.shadowStrength, 1, 0, 1);
  out.shadowBias = num(s.shadowBias, -0.0005, -0.05, 0);
  out.shadowNormalBias = num(s.shadowNormalBias, 0, 0);
  out.shadowNear = num(s.shadowNear, 0.1, 0.01);
  out.shadowRadius = num(s.shadowRadius, 4, 1, 5);
  out.shadowResolution = [512, 1024, 2048, 4096].includes(num(s.shadowResolution, 0))
    ? num(s.shadowResolution, 0)
    : 0;
  return out;
}

/** 音源组件设置收敛（缺省项回默认；与 audio.mjs parseAudioSettings 同一取值域） */
export function audioSettingsFrom(s: Record<string, unknown> | null | undefined): AudioSettings {
  const out: AudioSettings = {
    source: "",
    autoplay: true,
    loop: true,
    volume: 1,
    speed: 1,
    spatial: "2d",
    refDistance: 1,
    maxDistance: 30,
    rolloff: 1,
  };
  if (!s || typeof s !== "object") return out;
  const num = (v: unknown, fb: number, lo: number, hi?: number): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) return fb;
    return hi === undefined ? Math.max(lo, v) : Math.min(hi, Math.max(lo, v));
  };
  if (typeof s.source === "string") out.source = s.source;
  if (typeof s.autoplay === "boolean") out.autoplay = s.autoplay;
  if (typeof s.loop === "boolean") out.loop = s.loop;
  out.volume = num(s.volume, out.volume, 0, 1);
  out.speed = num(s.speed, out.speed, 0.1, 4);
  if (s.spatial === "3d") out.spatial = "3d";
  out.refDistance = num(s.refDistance, out.refDistance, 0.01);
  out.maxDistance = num(s.maxDistance, out.maxDistance, 0.01);
  out.rolloff = num(s.rolloff, out.rolloff, 0);
  return out;
}

/** 动画剪辑组件设置收敛（clip/autoplay/loop/speed） */
export function clipBindingFrom(s: Record<string, unknown> | null | undefined): ClipBindingOptions {
  return {
    clip: s && typeof s.clip === "string" ? s.clip : "",
    autoplay: !(s && s.autoplay === false),
    loop: !(s && s.loop === false),
    speed:
      s && typeof s.speed === "number" && Number.isFinite(s.speed) && s.speed >= 0 ? s.speed : 1,
  };
}
