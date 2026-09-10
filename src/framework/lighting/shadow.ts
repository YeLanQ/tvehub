// ---------------------------------------------------------------------------
// 灯光阴影配置（Unity Light → Shadows 语义）：
//
// 每盏可投影灯光（点光/平行光/聚光灯）自带一组阴影参数：
// - strength    阴影浓度 0~1（Unity "Strength"；映射 three 的 shadow.intensity）
// - bias        深度偏移（Unity "Bias"；压制自阴影麻点，负值向远处推）
// - normalBias  法线偏移（Unity "Normal Bias"；≤0 = 自动：按阴影贴图纹素相对化）
// - near        近裁剪面（Unity "Near Plane"；按阴影相机语义裁掉过近的投影）
// - radius      软化半径（Shadow 类型 Hard/Soft 的渲染差异；PCF 采样核）
// - resolution  阴影贴图分辨率（Unity "Resolution"；0 = 自动：平面 2048 / 点光 1024）
//
// 数据形状可在节点 JSON 与灯光组件设置间共享；统一解析后写到 three 灯光的
// shadow 上（渲染侧只认 three 对象，不感知配置来源）。
// ---------------------------------------------------------------------------

export interface LightShadowConfig {
  /** 阴影浓度 0~1（1 = 纯黑阴影，0 = 阴影不可见） */
  strength: number;
  /** 深度偏移（typical -0.005 ~ 0；过负会飘影/peter-panning） */
  bias: number;
  /** 法线偏移（世界单位；≤0 = 自动按阴影贴图纹素相对化） */
  normalBias: number;
  /** 近裁剪面（世界单位；沿光方向比这更近的物体不参与投影） */
  near: number;
  /** 阴影软化半径（PCF 采样核；1 = 硬阴影，>1 逐渐柔和，检查器 Shadow 类型据此映射） */
  radius: number;
  /** 阴影贴图分辨率（0 = 自动：平面 2048 / 点光 1024；显式档位 512/1024/2048/4096） */
  resolution: number;
}

export const DEFAULT_LIGHT_SHADOW: LightShadowConfig = {
  strength: 1,
  bias: -0.0005,
  normalBias: 0, // 0 = 自动
  near: 0.1,
  radius: 4, // 缺省柔和（与检查器 Shadow 类型下拉的 Soft 档一致）
  resolution: 0, // 0 = 自动
};

/** Shadow 类型下拉的三档（Unity None/Hard/Soft 语义；渲染端映射见 radius） */
export type LightShadowType = "off" | "hard" | "soft";
export const LIGHT_SHADOW_TYPE_HARD_RADIUS = 1;
export const LIGHT_SHADOW_TYPE_SOFT_RADIUS = 4;

/** 分辨率质量下拉的显式档位（0 = 自动，不在其中） */
export const SHADOW_RESOLUTIONS = [512, 1024, 2048, 4096] as const;
/** 自动档：平面阴影（平行光/聚光灯）的贴图分辨率 */
export const SHADOW_MAP_SIZE_PLANE = 2048;
/** 自动档：点光阴影贴图降档（立方体贴图要渲染 6 个面，同分辨率开销 ×6） */
export const SHADOW_MAP_SIZE_CUBE = 1024;

/** 解析后的实际贴图分辨率：显式档位优先，0 = 按灯型自动 */
export function shadowMapSizeOf(resolution: number, isPoint: boolean): number {
  if (resolution > 0) return resolution;
  return isPoint ? SHADOW_MAP_SIZE_CUBE : SHADOW_MAP_SIZE_PLANE;
}

/** 阴影配置 + 投射开关 → Shadow 类型档位（检查器下拉取值） */
export function lightShadowTypeOf(castShadow: boolean, shadow: LightShadowConfig): LightShadowType {
  if (!castShadow) return "off";
  return shadow.radius >= LIGHT_SHADOW_TYPE_SOFT_RADIUS ? "soft" : "hard";
}

/** Shadow 类型档位 → 配置补丁（写回节点/组件设置） */
export function applyLightShadowType(
  shadow: LightShadowConfig,
  type: LightShadowType,
): { castShadow: boolean; radius: number } {
  switch (type) {
    case "hard":
      return { castShadow: true, radius: LIGHT_SHADOW_TYPE_HARD_RADIUS };
    case "soft":
      return { castShadow: true, radius: LIGHT_SHADOW_TYPE_SOFT_RADIUS };
    default:
      return { castShadow: false, radius: shadow.radius };
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** 任意来源 → 收敛的阴影配置（缺失/非法字段回退默认） */
export function parseLightShadow(v: unknown): LightShadowConfig {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const d = DEFAULT_LIGHT_SHADOW;
  const rawRes = num(o.resolution, d.resolution);
  const resolution = (SHADOW_RESOLUTIONS as readonly number[]).includes(rawRes) ? rawRes : 0;
  return {
    strength: Math.max(0, Math.min(1, num(o.strength, d.strength))),
    bias: Math.max(-0.05, Math.min(0, num(o.bias, d.bias))),
    normalBias: Math.max(0, num(o.normalBias, d.normalBias)),
    near: Math.max(0.01, num(o.near, d.near)),
    radius: Math.max(1, Math.min(5, num(o.radius, d.radius))),
    resolution,
  };
}

/** 深拷贝（节点克隆/组件复制用） */
export function cloneLightShadow(c: LightShadowConfig): LightShadowConfig {
  return { ...c };
}

/** 是否同一配置（签名比对；参数补丁走重建路径时避免无谓写入） */
export function lightShadowSignature(c: LightShadowConfig): string {
  return [c.strength, c.bias, c.normalBias, c.near, c.radius, c.resolution].join("|");
}
