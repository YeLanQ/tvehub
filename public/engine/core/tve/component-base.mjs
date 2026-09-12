// ---------------------------------------------------------------------------
// 内置组件门面基类 + 常量 + 设置收敛函数
// ---------------------------------------------------------------------------
import { numOr } from "./state.mjs";

export const LIGHT_KINDS = ["point", "directional", "spot", "ambient"];
export const LOOP_MODES = ["loop", "once", "pingpong"];
export const CONDITION_OPS = [">", "<", ">=", "<=", "==", "!="];

/** 门面基类：承装实体句柄 / 组件类型键 / 组件引用 JSON */
class BuiltinComponent {
  constructor(entity, typeKey, json) {
    this.entity = entity;
    this.type = typeKey;
    this.__json = json ?? null;
  }

  get id() {
    return String(this.__json?.id ?? "");
  }
}

export { BuiltinComponent };

/** 灯光组件设置收敛（缺省项回默认；color 为 lightColor 别名） */
export function lightSettingsFrom(s) {
  const out = {
    kind: "point",
    lightColor: 0xffffff,
    intensity: 1,
    distance: 10,
    decay: 2,
    angle: 45,
    penumbra: 0.2,
    castShadow: false,
  };
  if (!s || typeof s !== "object") return out;
  if (LIGHT_KINDS.includes(s.kind)) out.kind = s.kind;
  const color = typeof s.lightColor === "number" ? s.lightColor : s.color;
  if (typeof color === "number" && Number.isFinite(color)) {
    out.lightColor = Math.max(0, Math.round(color)) & 0xffffff;
  }
  const num = (v, fb, lo, hi) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return fb;
    return hi === undefined ? Math.max(lo, v) : Math.min(hi, Math.max(lo, v));
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
export function audioSettingsFrom(s) {
  const out = {
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
  const num = (v, fb, lo, hi) => {
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
export function clipBindingFrom(s) {
  return {
    clip: s && typeof s.clip === "string" ? s.clip : "",
    autoplay: !(s && s.autoplay === false),
    loop: !(s && s.loop === false),
    speed:
      s && typeof s.speed === "number" && Number.isFinite(s.speed) && s.speed >= 0 ? s.speed : 1,
  };
}